/*
 * Parseable Server (C) 2022 - 2025 Parseable, Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 */

use anyhow::Result;
use vergen_gitcl::{
    BuildBuilder, CargoBuilder, Emitter, GitclBuilder, RustcBuilder, SysinfoBuilder,
};

pub fn main() -> Result<()> {
    ui::setup()?;

    // Init vergen
    Emitter::default()
        .add_instructions(&BuildBuilder::all_build()?)?
        .add_instructions(&CargoBuilder::all_cargo()?)?
        .add_instructions(&GitclBuilder::default().all().sha(true).build()?)?
        .add_instructions(&RustcBuilder::all_rustc()?)?
        .add_instructions(&SysinfoBuilder::all_sysinfo()?)?
        .emit()?;

    Ok(())
}

#[path = "build_support/native_ui.rs"]
mod native_ui;

mod ui {
    use static_files::resource_dir;
    use std::{env, fs, io, path::PathBuf};

    use crate::native_ui;

    pub fn setup() -> io::Result<()> {
        for name in ["NEXT_ASSETS_PATH", "P_BUILD_NO_UI", "LOCAL_ASSETS_PATH"] {
            println!("cargo:rerun-if-env-changed={name}");
        }
        println!("cargo:rerun-if-changed=build.rs");
        println!("cargo:rerun-if-changed=build_support/native_ui.rs");
        if env::var_os("LOCAL_ASSETS_PATH").is_some() {
            return Err(io::Error::other(
                "LOCAL_ASSETS_PATH was removed with the classic UI; build frontend/ and set NEXT_ASSETS_PATH to its dist directory",
            ));
        }
        let assets = env::var_os("NEXT_ASSETS_PATH").map(PathBuf::from);
        let disabled = native_ui::no_ui(
            env::var("P_BUILD_NO_UI").ok().as_deref(),
            env::var("PROFILE").as_deref() == Ok("debug"),
            assets.is_some(),
        )?;
        if disabled {
            println!(
                "cargo:warning=Building without a UI for backend development (P_BUILD_NO_UI=1)"
            );
            println!("cargo:rustc-env=UI_VERSION=disabled");
            return fs::write(
                PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("generated.rs"),
                "pub fn generate() -> ::std::collections::HashMap<&'static str, ::static_files::Resource> { ::std::collections::HashMap::new() }\n",
            );
        }
        let path = assets.ok_or_else(|| io::Error::other(
            "Native UI assets are required. Run `cd frontend && npm ci && npm run build`, then set NEXT_ASSETS_PATH to frontend/dist. For backend-only debug development, set P_BUILD_NO_UI=1.",
        ))?;
        println!("cargo:rerun-if-changed={}", path.display());
        native_ui::validate(&path)?;
        println!(
            "cargo:rustc-env=UI_VERSION=native-{}",
            env!("CARGO_PKG_VERSION")
        );
        resource_dir(path).build()
    }
}
