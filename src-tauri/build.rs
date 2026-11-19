fn main() {
    link_clang_runtime();
    tauri_build::build()
}

/// whisper.cpp's Metal backend uses `@available(...)` checks. When building for an
/// older macOS than the host (release builds target 11.0) those compile to calls
/// into clang's runtime (`__isPlatformVersionAtLeast`), which rustc doesn't link.
fn link_clang_runtime() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let Ok(out) = std::process::Command::new("xcrun").args(["clang", "--print-resource-dir"]).output() else { return };
    let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let lib_dir = std::path::Path::new(&dir).join("lib/darwin");
    if lib_dir.join("libclang_rt.osx.a").exists() {
        println!("cargo:rustc-link-search=native={}", lib_dir.display());
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
    }
}
