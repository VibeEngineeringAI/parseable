// SPDX-License-Identifier: AGPL-3.0-or-later
//! Reproducible, fail-closed overlay for the pinned Prism distribution.
use regex::Regex;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs, io,
    path::{Component, Path, PathBuf},
    sync::LazyLock,
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
fn module_paths(source: &Path) -> io::Result<BTreeMap<String, String>> {
    let mut paths = Vec::new();
    files(source, &mut paths)?;
    let mut modules = BTreeMap::new();
    for path in paths {
        if path.extension().is_some_and(|e| e == "js" || e == "html") {
            let name = path.strip_prefix(source).unwrap().components();
            let name = name
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            modules.insert(
                name,
                String::from_utf8_lossy(&fs::read(&path)?).into_owned(),
            );
        }
    }
    Ok(modules)
}
/// Resolves a module specifier to a distribution-relative path. Relative
/// specifiers resolve against the importer; others against the deployment base.
fn resolve_reference(from: &str, specifier: &str) -> Option<String> {
    let external = specifier.split_once(':').is_some_and(|(scheme, _)| {
        scheme.starts_with(|c: char| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    });
    if external || specifier.starts_with("//") {
        return None;
    }
    let mut segments: Vec<&str> = Vec::new();
    if specifier.starts_with("./") || specifier.starts_with("../") {
        segments.extend(from.split('/'));
        segments.pop();
    }
    for segment in specifier.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop()?;
            }
            _ => segments.push(segment),
        }
    }
    Some(segments.join("/"))
}
fn quoted_module(inner: &str) -> String {
    let specifier = r#"[^"'`\s]+?\.js"#;
    inner.replace(
        "{}",
        &format!(r#"(?:"({specifier})"|'({specifier})'|`({specifier})`)"#),
    )
}
static HTML_REFERENCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*(?:"([^"']+?\.js)"|'([^"']+?\.js)')"#,
    )
    .unwrap()
});
static IMPORT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&quoted_module(
        r"\b(?:from|import)\s*{}|\bimport\s*\(\s*{}\s*\)",
    ))
    .unwrap()
});
static PRELOAD_MAP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b__vite__mapDeps\s*=[^\[]*\[([^\]]*)\]").unwrap());
static PRELOAD_ENTRY: LazyLock<Regex> = LazyLock::new(|| Regex::new(&quoted_module("{}")).unwrap());
fn first_captures<'t>(pattern: &Regex, text: &'t str) -> impl Iterator<Item = &'t str> {
    pattern
        .captures_iter(text)
        .filter_map(|c| c.iter().skip(1).flatten().next().map(|m| m.as_str()))
}
/// Module references that make a JavaScript file reachable from index.html:
/// HTML entry/modulepreload tags, static `import`/`export ... from`, dynamic
/// `import()`, and the Vite `__vite__mapDeps` preload list. Mirrors
/// scripts/prepare-community-ui.mjs.
fn module_references(from: &str, text: &str) -> Vec<String> {
    let mut specifiers: Vec<String> = Vec::new();
    if from.ends_with(".html") {
        specifiers.extend(first_captures(&HTML_REFERENCE, text).map(str::to_owned));
    } else {
        specifiers.extend(first_captures(&IMPORT, text).map(str::to_owned));
        // Vite preload paths are relative to the deployment base, not the importer.
        for list in PRELOAD_MAP.captures_iter(text) {
            let list = list.get(1).unwrap().as_str();
            specifiers.extend(first_captures(&PRELOAD_ENTRY, list).map(|s| format!("/{s}")));
        }
    }
    specifiers
        .iter()
        .filter_map(|s| resolve_reference(from, s))
        .collect()
}
fn reachable_modules(modules: &BTreeMap<String, String>) -> BTreeSet<String> {
    let mut reachable = BTreeSet::from(["index.html".to_owned()]);
    let mut pending = vec!["index.html".to_owned()];
    while let Some(from) = pending.pop() {
        let text = modules.get(&from).map_or("", String::as_str);
        for path in module_references(&from, text) {
            if modules.contains_key(&path) && reachable.insert(path.clone()) {
                pending.push(path);
            }
        }
    }
    reachable
}
/// A Prism upgrade can leave stale chunks from older builds in the
/// distribution; patches to them verify but never run. Every patched file must
/// be part of the stock module graph, every addition must be loaded by the
/// patched graph, and patches must not import modules the stock UI does not
/// load (for example, a stale chunk named in an import specifier).
fn verify_reachability(
    version: &str,
    stock: &BTreeMap<String, String>,
    patched: &BTreeMap<String, String>,
    patched_paths: &[&str],
    addition_paths: &[&str],
) -> io::Result<()> {
    let before = reachable_modules(stock);
    let after = reachable_modules(patched);
    let unreachable: Vec<_> = patched_paths
        .iter()
        .filter(|p| !before.contains(**p))
        .chain(addition_paths.iter().filter(|p| !after.contains(**p)))
        .copied()
        .collect();
    if !unreachable.is_empty() {
        return Err(invalid(format!(
            "{version}: overlay files not reachable from index.html: {}",
            unreachable.join(", ")
        )));
    }
    let foreign: Vec<_> = after
        .iter()
        .filter(|p| !before.contains(*p) && !addition_paths.contains(&p.as_str()))
        .map(String::as_str)
        .collect();
    if !foreign.is_empty() {
        return Err(invalid(format!(
            "{version}: overlay imports modules outside the Prism UI graph: {}",
            foreign.join(", ")
        )));
    }
    Ok(())
}
/// `prism_version` is the pinned release from Cargo.toml (for example
/// `v3.2.5`); the manifest must have been derived from that release.
pub fn prepare(
    root: &Path,
    source: &Path,
    destination: &Path,
    prism_version: &str,
) -> io::Result<()> {
    let manifest_path = root.join("scripts/community-ui-overlay.json");
    println!("cargo:rerun-if-changed={}", manifest_path.display());
    println!("cargo:rerun-if-changed=build_support/community_ui.rs");
    let raw = fs::read(manifest_path)?;
    let manifest: Manifest = serde_json::from_slice(&raw).map_err(invalid_json)?;
    if manifest.cache_bust.mode != "javascript-filenames" {
        return Err(invalid("unsupported UI cache busting mode"));
    }
    if !manifest
        .version
        .starts_with(&format!("prism-{prism_version}-"))
    {
        return Err(invalid(format!(
            "{}: overlay does not match the pinned Prism UI {prism_version}",
            manifest.version
        )));
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
    let stock = module_paths(source)?;
    let mut patched = stock.clone();
    for (path, bytes) in &updates {
        patched.insert(path.clone(), String::from_utf8_lossy(bytes).into_owned());
    }
    let patched_paths: Vec<_> = manifest.files.iter().map(|f| f.path.as_str()).collect();
    let addition_paths: Vec<_> = manifest.additions.iter().map(|a| a.path.as_str()).collect();
    verify_reachability(
        &manifest.version,
        &stock,
        &patched,
        &patched_paths,
        &addition_paths,
    )?;
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
        let tokens = Regex::new(r"[A-Za-z0-9_.-]+\.js").unwrap();
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
                // Only the renamed graph ships. Stale tabs must reload (see
                // docs/oidc.md); keeping originals would double the embedded
                // UI and let old tabs mix unpatched chunks into the new graph.
                let new = &names[path.file_name().unwrap().to_str().unwrap()];
                fs::write(path.with_file_name(new), text.as_bytes())?;
                fs::remove_file(path)?;
            } else {
                fs::write(path, text.as_bytes())?;
            }
        }
    }
    Ok(())
}
fn invalid_json(error: serde_json::Error) -> io::Error {
    invalid(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENTRY: &str = r#"import { v } from "./chunk-a.js"; export const deps = ["assets/chunk-a.js", "assets/extra.js"];"#;
    const CHUNK: &str = "export const v = 1;";
    const STALE: &str = "export const v = 1; // left over from an older Prism build";

    fn sha(text: &str) -> String {
        format!("{:x}", Sha256::digest(text))
    }

    fn write(root: &Path, path: &str, text: &str) {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    /// A stock distribution whose graph is index.html -> index-main.js ->
    /// chunk-a.js, plus an unreferenced stale chunk; `files` is the manifest's
    /// file list. The default overlay patches chunk-a.js to load the addition.
    fn fixture_with(version: &str, files: serde_json::Value) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(
            root,
            "dist/index.html",
            r#"<script type="module" src="/assets/index-main.js"></script>"#,
        );
        write(root, "dist/assets/index-main.js", ENTRY);
        write(root, "dist/assets/chunk-a.js", CHUNK);
        write(root, "dist/assets/stale.js", STALE);
        write(
            root,
            "dist/assets/style.css",
            "body { content: 'chunk-a.js'; }",
        );
        write(root, "scripts/extra.js", "export const extra = true;");
        let manifest = serde_json::json!({
            "version": version,
            "files": files,
            "additions": [{"path": "assets/extra.js", "source": "scripts/extra.js"}],
            "cacheBust": {"mode": "javascript-filenames"},
        });
        write(
            root,
            "scripts/community-ui-overlay.json",
            &manifest.to_string(),
        );
        dir
    }

    fn patch(path: &str, sha256: &str, import: &str) -> serde_json::Value {
        serde_json::json!([{
            "path": path,
            "sha256": sha256,
            "replacements": [
                {"from": "v = 1", "to": "v = 2", "count": 1},
                {"from": "export const", "to": format!("import \"{import}\";export const"), "count": 1},
            ],
        }])
    }

    fn fixture(chunk_sha: &str) -> tempfile::TempDir {
        fixture_with(
            "prism-v1.0.0-test",
            patch("assets/chunk-a.js", chunk_sha, "./extra.js"),
        )
    }

    fn run(dir: &tempfile::TempDir) -> io::Result<()> {
        let root = dir.path();
        prepare(root, &root.join("dist"), &root.join("out"), "v1.0.0")
    }

    fn js_files(dir: &Path) -> Vec<String> {
        let mut output = Vec::new();
        files(dir, &mut output).unwrap();
        let mut names: Vec<_> = output
            .iter()
            .filter(|p| p.extension().is_some_and(|e| e == "js"))
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn ships_only_the_patched_renamed_graph() {
        let dir = fixture(&sha(CHUNK));
        let (root, out) = (dir.path(), dir.path().join("out"));
        run(&dir).unwrap();

        let names = js_files(&out);
        assert_eq!(
            names.len(),
            4,
            "every JS asset ships exactly once: {names:?}"
        );
        assert!(names.iter().all(|name| name.contains("-community-")));
        let renamed = |stem: &str| {
            names
                .iter()
                .find(|name| name.starts_with(&format!("{stem}-community-")))
                .unwrap()
                .clone()
        };
        let (entry, chunk, extra) = (renamed("index-main"), renamed("chunk-a"), renamed("extra"));

        let html = fs::read_to_string(out.join("index.html")).unwrap();
        assert!(html.contains(&format!("/assets/{entry}")));
        let entry_text = fs::read_to_string(out.join("assets").join(&entry)).unwrap();
        assert!(entry_text.contains(&format!("./{chunk}")));
        assert!(entry_text.contains(&format!("assets/{chunk}")));
        assert!(entry_text.contains(&format!("assets/{extra}")));
        let chunk_text = fs::read_to_string(out.join("assets").join(&chunk)).unwrap();
        assert_eq!(
            chunk_text,
            format!("import \"./{extra}\";export const v = 2;")
        );
        // Non-JS assets are copied verbatim.
        let css = fs::read_to_string(out.join("assets/style.css")).unwrap();
        assert_eq!(css, "body { content: 'chunk-a.js'; }");

        // Rebuilding from pristine inputs is deterministic.
        prepare(root, &root.join("dist"), &out, "v1.0.0").unwrap();
        assert_eq!(js_files(&out), names);
    }

    #[test]
    fn refuses_unpinned_inputs() {
        let dir = fixture(&"0".repeat(64));
        let error = run(&dir).unwrap_err();
        assert!(error.to_string().contains("SHA256 mismatch"));
        assert!(!dir.path().join("out").exists());
    }

    #[test]
    fn refuses_a_manifest_for_another_prism_release() {
        let dir = fixture(&sha(CHUNK));
        let root = dir.path();
        let error = prepare(root, &root.join("dist"), &root.join("out"), "v1.0.1").unwrap_err();
        assert!(
            error
                .to_string()
                .contains("does not match the pinned Prism UI v1.0.1")
        );
        assert!(!root.join("out").exists());
    }

    #[test]
    fn refuses_patches_to_chunks_the_ui_never_loads() {
        // A stale chunk verifies (hash and counts match) but is unreachable, so
        // neither it nor the addition it imports would ever run.
        let dir = fixture_with(
            "prism-v1.0.0-test",
            patch("assets/stale.js", &sha(STALE), "./extra.js"),
        );
        let error = run(&dir).unwrap_err().to_string();
        assert!(
            error.contains("not reachable from index.html: assets/stale.js, assets/extra.js"),
            "{error}"
        );
        assert!(!dir.path().join("out").exists());
    }

    #[test]
    fn refuses_patches_that_import_modules_outside_the_graph() {
        let dir = fixture_with(
            "prism-v1.0.0-test",
            serde_json::json!([{
                "path": "assets/chunk-a.js",
                "sha256": sha(CHUNK),
                "replacements": [{"from": "export", "to": "import \"./extra.js\";import \"./stale.js\";export", "count": 1}],
            }]),
        );
        let error = run(&dir).unwrap_err().to_string();
        assert!(
            error.contains("outside the Prism UI graph: assets/stale.js"),
            "{error}"
        );
    }

    #[test]
    fn follows_html_static_dynamic_and_preload_references() {
        let modules: BTreeMap<String, String> = [
            (
                "index.html",
                r#"<script type="module" crossorigin src="/assets/index.js"></script><link rel="modulepreload" href="/assets/vendor.js"><link rel="stylesheet" href="/assets/index.css">"#,
            ),
            (
                "assets/index.js",
                r#"const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/Page.js","assets/preloaded.js"])))=>i.map(i=>d[i]);import{a as b}from"./shared.js";import"./side-effect.js";const p=()=>import(`./Page.js`),__vite__mapDeps([0,1]);const note="mentioned.js";"#,
            ),
            ("assets/vendor.js", "export const vendor = 1;"),
            ("assets/shared.js", r#"export*from'../lib/deep.js';"#),
            ("lib/deep.js", r#"const q=import("https://cdn.example/x.js");"#),
            ("assets/side-effect.js", ""),
            ("assets/Page.js", ""),
            ("assets/preloaded.js", ""),
            ("assets/mentioned.js", ""),
            ("assets/stale.js", r#"import"./index.js";"#),
        ]
        .into_iter()
        .map(|(path, text)| (path.to_owned(), text.to_owned()))
        .collect();
        let reachable = reachable_modules(&modules);
        let expected = [
            "assets/Page.js",
            "assets/index.js",
            "assets/preloaded.js",
            "assets/shared.js",
            "assets/side-effect.js",
            "assets/vendor.js",
            "index.html",
            "lib/deep.js",
        ];
        assert_eq!(
            reachable.iter().map(String::as_str).collect::<Vec<_>>(),
            expected
        );
        assert_eq!(resolve_reference("assets/a.js", "../../x.js"), None);
    }
}
