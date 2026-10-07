// SPDX-License-Identifier: AGPL-3.0-or-later
//! Reproducible, fail-closed overlay for the pinned Prism distribution.
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs, io,
    path::{Component, Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: String,
    files: Vec<File>,
    additions: Vec<Addition>,
    cache_bust: CacheBust,
}
#[derive(Deserialize)]
struct CacheBust {
    mode: String,
}
#[derive(Deserialize)]
struct File {
    path: String,
    sha256: String,
    replacements: Vec<Replacement>,
}
#[derive(Deserialize)]
struct Replacement {
    from: String,
    to: String,
    count: usize,
}
#[derive(Deserialize)]
struct Addition {
    path: String,
    source: String,
}
fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::other(message.into())
}
fn relative(root: &Path, path: &str) -> io::Result<PathBuf> {
    let p = Path::new(path);
    if p.as_os_str().is_empty() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(invalid(format!("invalid overlay path: {path}")));
    }
    Ok(root.join(p))
}
fn files(dir: &Path, output: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            files(&entry.path(), output)?;
        } else if kind.is_file() {
            output.push(entry.path());
        } else {
            return Err(invalid("UI distribution contains a non-regular file"));
        }
    }
    Ok(())
}
pub fn prepare(root: &Path, source: &Path, destination: &Path) -> io::Result<()> {
    let manifest_path = root.join("scripts/community-ui-overlay.json");
    println!("cargo:rerun-if-changed={}", manifest_path.display());
    println!("cargo:rerun-if-changed=build_support/community_ui.rs");
    let raw = fs::read(manifest_path)?;
    let manifest: Manifest = serde_json::from_slice(&raw).map_err(invalid_json)?;
    if manifest.cache_bust.mode != "javascript-filenames" {
        return Err(invalid("unsupported UI cache busting mode"));
    }
    let mut identity = Sha256::new();
    identity.update(&raw);
    let mut updates = BTreeMap::new();
    for file in &manifest.files {
        let input = fs::read(relative(source, &file.path)?)?;
        if format!("{:x}", Sha256::digest(&input)) != file.sha256 {
            return Err(invalid(format!(
                "{}: SHA256 mismatch for {}",
                manifest.version, file.path
            )));
        }
        let mut text = String::from_utf8(input).map_err(|e| invalid(e.to_string()))?;
        for r in &file.replacements {
            if r.from.is_empty() || text.matches(&r.from).count() != r.count {
                return Err(invalid(format!(
                    "overlay replacement count mismatch in {}",
                    file.path
                )));
            }
            text = text.replace(&r.from, &r.to);
        }
        updates.insert(file.path.clone(), text.into_bytes());
    }
    for addition in &manifest.additions {
        let path = relative(root, &addition.source)?;
        println!("cargo:rerun-if-changed={}", path.display());
        let bytes = fs::read(path)?;
        identity.update(&bytes);
        if relative(source, &addition.path)?.exists()
            || updates.insert(addition.path.clone(), bytes).is_some()
        {
            return Err(invalid("overlay addition collides with an existing file"));
        }
    }
    // Always copy pristine inputs; never reapply transformations to patched files.
    if destination.exists() {
        fs::remove_dir_all(destination)?;
    }
    fs::create_dir_all(destination)?;
    let mut inputs = Vec::new();
    files(source, &mut inputs)?;
    for input in inputs {
        let target = destination.join(input.strip_prefix(source).unwrap());
        fs::create_dir_all(target.parent().unwrap())?;
        fs::copy(input, target)?;
    }
    for (path, bytes) in updates {
        let target = relative(destination, &path)?;
        fs::create_dir_all(target.parent().unwrap())?;
        fs::write(target, bytes)?;
    }
    {
        let digest = format!("{:x}", identity.finalize());
        let mut output = Vec::new();
        files(destination, &mut output)?;
        let names: BTreeMap<String, String> = output
            .iter()
            .filter(|p| p.extension().is_some_and(|e| e == "js"))
            .map(|p| {
                let name = p.file_name().unwrap().to_string_lossy().into_owned();
                let new = format!(
                    "{}-community-{}.js",
                    name.trim_end_matches(".js"),
                    &digest[..12]
                );
                (name, new)
            })
            .collect();
        let tokens = regex::Regex::new(r"[A-Za-z0-9_.-]+\.js").unwrap();
        for path in output {
            let extension = path.extension().and_then(|e| e.to_str());
            if !matches!(extension, Some("js" | "html")) {
                continue;
            }
            let original = fs::read_to_string(&path)?;
            let text = tokens.replace_all(&original, |captures: &regex::Captures<'_>| {
                names
                    .get(&captures[0])
                    .cloned()
                    .unwrap_or_else(|| captures[0].to_owned())
            });
            if extension == Some("js") {
                let new = &names[path.file_name().unwrap().to_str().unwrap()];
                fs::write(path.with_file_name(new), text.as_bytes())?;
            } else {
                fs::write(path, text.as_bytes())?;
            }
        }
    }
    for file in &manifest.files {
        fs::copy(
            relative(source, &file.path)?,
            relative(destination, &file.path)?,
        )?;
    }
    Ok(())
}
fn invalid_json(error: serde_json::Error) -> io::Error {
    invalid(error.to_string())
}
