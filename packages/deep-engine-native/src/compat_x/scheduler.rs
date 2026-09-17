//! 可信宿主的X内容调度边界；配置与固定worker位置不属于内容合同。
pub use super::XDynamicContent;
use super::{
    process::{self, XProcessConfig, XProcessError},
    *,
};
use crate::runtime_package::runtime_content_sha256;

#[derive(Debug, Clone, PartialEq)]
pub struct XPublishedOutput {
    pub epoch: u64,
    pub request_hash: String,
    pub output_hash: String,
    pub messages: Vec<XMessage>,
}

impl XPublishedOutput {
    /// X can publish one isolated Deep2D layer per epoch; non-display messages remain diagnostics.
    pub fn display_list(&self) -> Result<Option<&crate::deep2d::Deep2dDisplayList>, &'static str> {
        let mut display = None;
        for message in &self.messages {
            if let XMessage::DisplayList(candidate) = message
                && display.replace(candidate.as_ref()).is_some()
            {
                return Err("X output contains more than one display list");
            }
        }
        Ok(display)
    }
}

#[derive(Default)]
pub struct XContentScheduler {
    config: XProcessConfig,
    last_known_good: Option<XPublishedOutput>,
}

impl XContentScheduler {
    /// 只能由可信宿主配置，不从动态内容反序列化开关或预算。
    pub fn new(config: XProcessConfig) -> Result<Self, XProcessError> {
        XCompatibilityHost::new(config.enabled, config.budget).map_err(XProcessError::Rejected)?;
        Ok(Self {
            config,
            last_known_good: None,
        })
    }

    pub fn last_known_good(&self) -> Option<&XPublishedOutput> {
        self.last_known_good.as_ref()
    }

    pub fn dispatch(
        &mut self,
        content: &XDynamicContent,
        mut context: impl FnMut() -> XExecutionContext,
    ) -> Result<&XPublishedOutput, XProcessError> {
        self.dispatch_with(content, &mut context, |config, request, context| {
            let player = std::env::current_exe().map_err(io_error)?;
            let worker = player
                .parent()
                .ok_or_else(|| io_error("player directory unavailable"))?
                .join("deep2d-x-worker.exe");
            let metadata = std::fs::symlink_metadata(&worker).map_err(io_error)?;
            use std::os::windows::fs::MetadataExt;
            // 固定包内普通文件，拒绝reparse point；不接受内容注入可执行路径。
            if !metadata.is_file() || metadata.file_attributes() & 0x400 != 0 {
                return Err(io_error("packaged X worker is not a regular file"));
            }
            process::lpac::evaluate(&worker, config, request, context)
        })
    }

    fn dispatch_with(
        &mut self,
        content: &XDynamicContent,
        context: &mut dyn FnMut() -> XExecutionContext,
        evaluate: impl FnOnce(
            XProcessConfig,
            &XRequest,
            &mut dyn FnMut() -> XExecutionContext,
        ) -> Result<XCandidate, XProcessError>,
    ) -> Result<&XPublishedOutput, XProcessError> {
        let host = XCompatibilityHost::new(self.config.enabled, self.config.budget)
            .map_err(XProcessError::Rejected)?;
        let request = &content.request;
        host.guard(
            self.config.lane,
            request.expected_epoch,
            request.started_at_ms,
            context(),
        )
        .map_err(XProcessError::Rejected)?;
        if content.lane != CompatibilityLane::ExperimentalX {
            return Err(XProcessError::Rejected(XRejection::NativeN0Isolated));
        }
        for version in [content.schema_version, request.schema_version] {
            if version != X_COMPATIBILITY_SCHEMA_VERSION {
                return Err(XProcessError::Rejected(
                    XRejection::UnsupportedSchemaVersion { received: version },
                ));
            }
        }
        let bytes = process::encode_bounded_request(request, self.config.budget)?;
        let value = serde_json::from_slice(&bytes).map_err(io_error)?;
        if content.content_hash.algorithm != "sha256"
            || content.content_hash.value != runtime_content_sha256(&value)
        {
            return Err(XProcessError::InvalidReceipt);
        }
        let candidate = evaluate(self.config, request, context)?;
        let request_hash = candidate.request_hash().to_owned();
        let output_hash = candidate.output_hash().to_owned();
        let messages = host
            .publish(content.lane, candidate, context())
            .map_err(XProcessError::Rejected)?;
        super::host::validate_messages(&messages).map_err(|_| XProcessError::InvalidReceipt)?;
        self.last_known_good = Some(XPublishedOutput {
            epoch: request.expected_epoch,
            request_hash,
            output_hash,
            messages,
        });
        Ok(self
            .last_known_good
            .as_ref()
            .expect("successful publication assigned"))
    }
}

fn io_error(error: impl std::fmt::Display) -> XProcessError {
    XProcessError::Io(error.to_string())
}

#[cfg(test)]
#[path = "scheduler_tests.rs"]
mod tests;
