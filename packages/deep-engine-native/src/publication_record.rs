//! 发布验证记录数据（自包含，无服务层依赖）。
//! 从 publication_verification 拆出：player_state 等底层状态只需数据类型，
//! 不得反向依赖验证服务（player_cli/app 栈），否则 `#[path]` 重组装的测试
//! crate 无法闭合传递依赖（V5 预检 2026-09-23 同族修复）。
use serde::Serialize;
use std::fs::OpenOptions;
use std::{fs, io::Write, path::PathBuf};

pub struct Verification {
    report: PathBuf,
    required_frames: u32,
    evidence: Box<Evidence>,
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
    device: Option<serde_json::Value>,
    device_fingerprint_sha256: Option<String>,
    layers: Vec<crate::deep2d_gpu::DrawEvidence>,
}

impl Verification {
    pub(crate) fn new(report: PathBuf, nonce: String, frames: u32) -> Result<Self, String> {
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
            evidence: Box::new(Evidence {
                schema_version: 1,
                scope: "native-window",
                nonce,
                package_hash: String::new(),
                width: 0,
                height: 0,
                presented_frames: 0,
                backend: String::new(),
                gpu_errors_clean: false,
                device: None,
                device_fingerprint_sha256: None,
                layers: Vec::new(),
            }),
        })
    }

    pub fn bind_hash(mut self, hash: String) -> Self {
        self.evidence.package_hash = hash;
        self
    }

    pub fn observe_draws(
        &mut self,
        device: serde_json::Value,
        layers: Vec<crate::deep2d_gpu::DrawEvidence>,
    ) -> Result<(), String> {
        let fingerprint = deep_engine_native::runtime_package::runtime_content_sha256(&device);
        if self
            .evidence
            .device_fingerprint_sha256
            .as_ref()
            .is_some_and(|old| old != &fingerprint)
        {
            return Err("verification device changed between presents".into());
        }
        self.evidence.device = Some(device);
        self.evidence.device_fingerprint_sha256 = Some(fingerprint);
        self.evidence.layers = layers;
        Ok(())
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
