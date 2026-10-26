//! Extracts the baseline `src/utils/json` sources with `git show <rev>:<path>` into
//! OUT_DIR, byte for byte, and generates a one-line module declaration pointing at
//! them. Nothing in the extracted files is edited; the crate root provides the same
//! `crate::parseable`, `crate::event` and `crate::metadata` stubs to both copies.
//!
//! Override the revision with FLATTEN_BENCH_BASELINE_REV (default 547c5118, the
//! merge-base of fix/flatten-row-cap with main).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::{env, fs};

const DEFAULT_REV: &str = "547c5118";
const FILES: &[&str] = &["mod.rs", "flatten.rs", "strict.rs"];

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=FLATTEN_BENCH_BASELINE_REV");

    let rev = env::var("FLATTEN_BENCH_BASELINE_REV").unwrap_or_else(|_| DEFAULT_REV.to_owned());
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let repo_root = manifest_dir.join("../..");
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let json_dir = out_dir.join("baseline").join("json");
    fs::create_dir_all(&json_dir).unwrap();

    for file in FILES {
        let spec = format!("{rev}:src/utils/json/{file}");
        let output = Command::new("git")
            .arg("-C")
            .arg(&repo_root)
            .args(["show", &spec])
            .output()
            .expect("failed to run git");
        assert!(
            output.status.success(),
            "git show {spec} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        fs::write(json_dir.join(file), &output.stdout).unwrap();
    }

    let commit = git(&repo_root, &["rev-parse", &format!("{rev}^{{commit}}")]);
    let blob = git(
        &repo_root,
        &["rev-parse", &format!("{rev}:src/utils/json/flatten.rs")],
    );
    println!("cargo:rustc-env=FLATTEN_BENCH_BASELINE_COMMIT={commit}");
    println!("cargo:rustc-env=FLATTEN_BENCH_BASELINE_FLATTEN_BLOB={blob}");

    let mod_path = json_dir.join("mod.rs");
    fs::write(
        out_dir.join("baseline_modules.rs"),
        format!(
            "#[path = {:?}]\npub mod baseline_json;\n",
            mod_path.to_str().expect("OUT_DIR must be UTF-8")
        ),
    )
    .unwrap();
}

fn git(repo_root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .args(args)
        .output()
        .expect("failed to run git");
    assert!(output.status.success(), "git {args:?} failed");
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}
