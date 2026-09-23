//! Explicit normal-window verification of one immutable publication candidate.
use std::{ffi::OsString, fs, path::PathBuf};

// 数据结构与序列化逻辑在 publication_record（无服务层依赖，可被 player_state
// 等底层状态引用）；本模块只保留 --verify-package 服务入口。
pub use crate::publication_record::Verification;

pub fn execute(mut args: impl Iterator<Item = OsString>) -> Result<(), String> {
    let package = crate::player_cli::required_path(&mut args, "--verify-package")?;
    let mut value = |flag: &str| -> Result<OsString, String> {
        if args.next().as_deref() != Some(std::ffi::OsStr::new(flag)) {
            return Err(format!("expected {flag}"));
        }
        args.next()
            .ok_or_else(|| format!("{flag} requires a value"))
    };
    let report = PathBuf::from(value("--report")?);
    let nonce = value("--nonce")?
        .into_string()
        .map_err(|_| "nonce must be ASCII")?;
    let frames = value("--frames")?
        .into_string()
        .map_err(|_| "invalid frame count")?
        .parse()
        .map_err(|_| "invalid frame count")?;
    crate::player_cli::reject_extra(args)?;
    let verification = Verification::new(report, nonce, frames)?;
    crate::runtime_package_startup::verify(&package, verification)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    static SEQUENCE: AtomicU32 = AtomicU32::new(0);
    fn destination() -> PathBuf {
        std::env::temp_dir().join(format!(
            "native-verification-{}-{}.json",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }
    #[test]
    fn rejects_invalid_options() {
        for frames in [0, 121] {
            assert!(Verification::new(destination(), "nonce".into(), frames).is_err());
        }
        for nonce in ["", "../file", "中文", "a b"] {
            assert!(Verification::new(destination(), nonce.into(), 1).is_err());
        }
        assert!(Verification::new("relative.json".into(), "nonce".into(), 1).is_err());
    }
    #[test]
    fn no_success_before_all_presented_frames() {
        let report = destination();
        let mut verification = Verification::new(report.clone(), "nonce".into(), 2)
            .unwrap()
            .bind_hash("actual-package-hash".into());
        assert!(!verification.presented(960, 640, "Vulkan".into()).unwrap());
        assert!(verification.finish().is_err());
        assert!(!report.exists());
    }
    #[test]
    fn refuses_smoke_dimensions() {
        let mut verification = Verification::new(destination(), "nonce".into(), 1).unwrap();
        assert!(verification.presented(64, 64, "Vulkan".into()).is_err());
    }
    #[test]
    fn publishes_exact_report_and_never_clobbers() {
        let report = destination();
        let ready = || {
            let mut v = Verification::new(report.clone(), "nonce".into(), 1)
                .unwrap()
                .bind_hash("actual".into());
            assert!(v.presented(960, 640, "Vulkan".into()).unwrap());
            v
        };
        let first = ready();
        let second = ready();
        first.finish().unwrap();
        let bytes = fs::read(&report).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["scope"], "native-window");
        assert_eq!(json["packageHash"], "actual");
        assert_eq!(json["presentedFrames"], 1);
        assert_eq!(json["gpuErrorsClean"], true);
        assert!(second.finish().is_err());
        assert_eq!(fs::read(&report).unwrap(), bytes);
        fs::remove_file(report).unwrap();
    }
}
