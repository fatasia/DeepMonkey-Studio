//! Explicit normal-window verification of one immutable publication candidate.
use serde::Serialize;
use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
};

pub struct Verification {
    report: PathBuf,
    required_frames: u32,
    evidence: Evidence,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Evidence {
    schema_version: u8,
    scope: &'static str,
    nonce: String,
    package_hash: String,
    width: u32,
    height: u32,
    presented_frames: u32,
    backend: String,
    gpu_errors_clean: bool,
}

impl Verification {
    fn new(report: PathBuf, nonce: String, frames: u32) -> Result<Self, String> {
        if !report.is_absolute() || report.exists() {
            return Err("verification report must be a new absolute path".into());
        }
        if nonce.is_empty()
            || nonce.len() > 128
            || !nonce
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("verification nonce must contain 1..128 ASCII letters/digits/-/_".into());
        }
        if !(1..=120).contains(&frames) {
            return Err("verification frames must be 1..120".into());
        }
        Ok(Self {
            report,
            required_frames: frames,
            evidence: Evidence {
                schema_version: 1,
                scope: "native-window",
                nonce,
                package_hash: String::new(),
                width: 0,
                height: 0,
                presented_frames: 0,
                backend: String::new(),
                gpu_errors_clean: false,
            },
        })
    }

    pub fn bind_hash(mut self, hash: String) -> Self {
        self.evidence.package_hash = hash;
        self
    }

    // Called only after render(true) reports Presented, never after queue.submit alone.
    pub fn presented(&mut self, width: u32, height: u32, backend: String) -> Result<bool, String> {
        if width < 480 || height < 320 || backend.is_empty() {
            return Err("verification requires a normal sized native window and backend".into());
        }
        if self.evidence.presented_frames >= self.required_frames {
            return Err("verification received extra frames".into());
        }
        self.evidence.width = width;
        self.evidence.height = height;
        self.evidence.backend = backend;
        self.evidence.presented_frames += 1;
        self.evidence.gpu_errors_clean = true;
        Ok(self.evidence.presented_frames == self.required_frames)
    }

    // Publish success only after the event loop exits without a recorded failure.
    pub fn finish(self) -> Result<(), String> {
        if self.evidence.package_hash.is_empty()
            || self.evidence.presented_frames != self.required_frames
            || !self.evidence.gpu_errors_clean
        {
            return Err("native verification ended before verified present".into());
        }
        let bytes = serde_json::to_vec_pretty(&self.evidence).map_err(|e| e.to_string())?;
        let staging = self.report.with_extension(format!(
            "{}.{}.tmp",
            std::process::id(),
            self.evidence.nonce
        ));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)
            .map_err(|e| format!("verification staging failed: {e}"))?;
        let result = (|| {
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            // Same-directory hardlink publishes complete bytes with no replacement.
            fs::hard_link(&staging, &self.report)
        })();
        let _ = fs::remove_file(&staging);
        result.map_err(|e| format!("verification report failed: {e}"))
    }
}

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
