use std::{env, fs, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=../../apps/desktop/src-tauri/icons/icon.ico");
    println!("cargo:rerun-if-env-changed=RC");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let icon = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .join("../../apps/desktop/src-tauri/icons/icon.ico")
        .canonicalize()
        .expect("product icon must exist");
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let resource = output.join("product-icon.rc");
    let compiled = output.join("product-icon.res");
    // 与 Tauri 安装器共用唯一 ICO；不生成另一套尺寸或配色。
    fs::write(
        &resource,
        format!(
            concat!("LANGUAGE 0, 0\n101 ICON \"{}\"\n",
                "1 VERSIONINFO\nFILEVERSION 0,1,0,0\nPRODUCTVERSION 0,1,0,0\nFILEOS 0x40004L\nFILETYPE 1L\nBEGIN\n",
                "BLOCK \"StringFileInfo\" BEGIN BLOCK \"040904b0\" BEGIN\n",
                "VALUE \"ProductName\", \"Deep Monkey Studio\\0\"\nVALUE \"FileDescription\", \"Deep Monkey Studio\\0\"\n",
                "VALUE \"FileVersion\", \"0.1.0.0\\0\"\nVALUE \"ProductVersion\", \"0.1.0.0\\0\"\nEND END\n",
                "BLOCK \"VarFileInfo\" BEGIN VALUE \"Translation\", 0x409, 1200 END\nEND\n"),
            icon.display().to_string().replace('\\', "/")
        ),
    )
    .expect("write icon resource");
    let status = Command::new(resource_compiler())
        .args(["/nologo", "/fo"])
        .arg(&compiled)
        .arg(&resource)
        .status()
        .expect("Windows SDK rc.exe is required to embed the product icon");
    assert!(status.success(), "product icon resource compilation failed");
    println!("cargo:rustc-link-arg-bins={}", compiled.display());
}

fn resource_compiler() -> PathBuf {
    if let Some(explicit) = env::var_os("RC") {
        return explicit.into();
    }
    // Cargo 可从普通终端启动；与已有 MSVC 工具链共用 Windows SDK。
    let registered = Command::new("reg.exe")
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Windows Kits\Installed Roots",
            "/v",
            "KitsRoot10",
        ])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|text| {
            text.lines().find_map(|line| {
                line.split_once("REG_SZ")
                    .map(|(_, value)| PathBuf::from(value.trim()))
            })
        });
    let sdk = env::var_os("WindowsSdkDir")
        .map(PathBuf::from)
        .or(registered)
        .unwrap_or_else(|| {
            PathBuf::from(
                env::var_os("ProgramFiles(x86)").unwrap_or_else(|| "C:/Program Files (x86)".into()),
            )
            .join("Windows Kits/10")
        })
        .join("bin");
    let host = if env::consts::ARCH == "aarch64" {
        "arm64"
    } else {
        "x64"
    };
    let mut candidates = fs::read_dir(sdk)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path().join(host).join("rc.exe"))
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    candidates.sort();
    candidates.pop().unwrap_or_else(|| "rc.exe".into())
}
