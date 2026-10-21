// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native UI build contract. Kept dependency-free for focused build validation.
use std::{fs, io, path::Path};

pub fn no_ui(value: Option<&str>, debug: bool, has_assets: bool) -> io::Result<bool> {
    match value {
        None | Some("0") => Ok(false),
        Some("1") if !debug => Err(io::Error::other(
            "P_BUILD_NO_UI=1 is only supported for debug backend development; release builds require NEXT_ASSETS_PATH",
        )),
        Some("1") if has_assets => Err(io::Error::other(
            "P_BUILD_NO_UI=1 conflicts with NEXT_ASSETS_PATH; unset one",
        )),
        Some("1") => Ok(true),
        Some(_) => Err(io::Error::other("P_BUILD_NO_UI must be 0 or 1")),
    }
}

pub fn validate(path: &Path) -> io::Result<()> {
    let index = fs::read_to_string(path.join("index.html")).map_err(|err| {
        io::Error::new(err.kind(), format!(
            "NEXT_ASSETS_PATH {} has no readable index.html; build frontend/ with `npm run build`: {err}", path.display(),
        ))
    })?;
    if !index.contains(r#"<base href="/""#) {
        return Err(io::Error::other(
            "NEXT_ASSETS_PATH index.html has no <base href=\"/\">; rebuild frontend/ with `npm run build`",
        ));
    }
    if !path.join("assets").is_dir()
        || !fs::read_dir(path.join("assets"))?.any(|entry| {
            entry.is_ok_and(|entry| entry.path().extension().is_some_and(|ext| ext == "js"))
        })
    {
        return Err(io::Error::other(
            "NEXT_ASSETS_PATH has no compiled JavaScript in assets/; rebuild frontend/ with `npm run build`",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_ui_is_explicit_debug_only_and_unambiguous() {
        assert!(!no_ui(None, true, false).unwrap());
        assert!(!no_ui(Some("0"), false, true).unwrap());
        assert!(no_ui(Some("1"), true, false).unwrap());
        assert!(no_ui(Some("1"), false, false).is_err());
        assert!(no_ui(Some("1"), true, true).is_err());
        assert!(no_ui(Some("true"), true, false).is_err());
    }

    #[test]
    fn native_assets_must_be_a_complete_build() {
        let root = std::env::temp_dir().join(format!("parseable-native-ui-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        assert!(validate(&root).is_err());
        fs::write(root.join("index.html"), "<head></head>").unwrap();
        assert!(validate(&root).is_err());
        fs::write(root.join("index.html"), r#"<head><base href="/" /></head>"#).unwrap();
        assert!(validate(&root).is_err());
        fs::create_dir(root.join("assets")).unwrap();
        fs::write(root.join("assets/index-abc123.js"), "export {};").unwrap();
        validate(&root).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
