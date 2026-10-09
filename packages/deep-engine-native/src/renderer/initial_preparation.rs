//! Opt-in startup CPU phase observation, separate from the later frame window.
use web_time::Instant;

pub(super) struct InitialPreparationClock {
    origin: Instant,
    scene_end: Option<u64>,
    resource_start: Option<u64>,
    resource_stage_ends: [Option<u64>; 5],
    upload_bytes: u64,
    upload_elapsed_ns: u64,
}
pub(super) struct InitialPreparationReport {
    epoch: u64,
    scene_end: u64,
    resource_start: u64,
    resource_end: u64,
    resource_stage_ends: [u64; 5],
    upload_bytes: u64,
    upload_elapsed_ns: u64,
}
const RESOURCE_STAGE_NAMES: [&str; 6] = [
    "layouts-shadow",
    "raster-pipelines",
    "probes-uniforms-ibl-output",
    "scene-visibility-deep2d-validation",
    "rt-attempt-validation",
    "telemetry-surface-overlay",
];
fn elapsed(origin: Instant) -> u64 {
    u64::try_from(origin.elapsed().as_nanos()).unwrap_or(u64::MAX)
}
impl InitialPreparationClock {
    pub(super) fn begin(enabled: bool) -> Option<Self> {
        enabled.then(|| Self {
            origin: Instant::now(),
            scene_end: None,
            resource_start: None,
            resource_stage_ends: [None; 5],
            upload_bytes: 0,
            upload_elapsed_ns: 0,
        })
    }
    // 启动期上传计量:字节只计初始准备窗口内 renderer 边界直发的
    // queue.write_buffer / queue.write_texture(与 quality_telemetry 的
    // renderer-direct-queue-writes 同口径);时长为上传段 host-monotonic
    // elapsed,含 CPU 调用/驱动阻塞/await 等待,不是纯 GPU 传输时间。
    pub(super) fn note_upload_bytes(&mut self, bytes: u64) {
        self.upload_bytes = self.upload_bytes.saturating_add(bytes);
    }
    pub(super) fn upload_timed<T>(&mut self, call: impl FnOnce() -> T) -> T {
        let start = Instant::now();
        let value = call();
        self.upload_elapsed_ns = self
            .upload_elapsed_ns
            .saturating_add(u64::try_from(start.elapsed().as_nanos()).unwrap_or(u64::MAX));
        value
    }
    pub(super) fn scene_prepared(&mut self) -> Result<(), String> {
        if self.scene_end.is_some() || self.resource_start.is_some() {
            return Err("initial scene preparation boundary repeated".into());
        }
        self.scene_end = Some(elapsed(self.origin));
        Ok(())
    }
    pub(super) fn resources_started(&mut self) -> Result<(), String> {
        if self.scene_end.is_none() || self.resource_start.is_some() {
            return Err("initial resource preparation boundary out of order".into());
        }
        self.resource_start = Some(elapsed(self.origin));
        Ok(())
    }
    pub(super) fn finish(self, epoch: u64) -> Result<InitialPreparationReport, String> {
        let scene_end = self.scene_end.ok_or("initial scene preparation missing")?;
        let resource_start = self
            .resource_start
            .ok_or("initial resource preparation missing")?;
        let resource_end = elapsed(self.origin);
        let mut resource_stage_ends = [0; 5];
        let mut previous = resource_start;
        for (index, mark) in self.resource_stage_ends.into_iter().enumerate() {
            let end = mark.ok_or("initial resource subphase missing")?;
            if end < previous || end > resource_end {
                return Err("initial resource subphase clock invalid".into());
            }
            resource_stage_ends[index] = end;
            previous = end;
        }
        if scene_end > resource_start || resource_start > resource_end {
            return Err("initial preparation clock invalid".into());
        }
        Ok(InitialPreparationReport {
            epoch,
            scene_end,
            resource_start,
            resource_end,
            resource_stage_ends,
            upload_bytes: self.upload_bytes,
            upload_elapsed_ns: self.upload_elapsed_ns,
        })
    }
    pub(super) fn resource_stage_prepared(&mut self, index: usize) -> Result<(), String> {
        if self.resource_start.is_none()
            || index >= self.resource_stage_ends.len()
            || self.resource_stage_ends[index].is_some()
            || (index > 0 && self.resource_stage_ends[index - 1].is_none())
        {
            return Err("initial resource subphase boundary out of order or repeated".into());
        }
        self.resource_stage_ends[index] = Some(elapsed(self.origin));
        Ok(())
    }
}
impl InitialPreparationReport {
    fn resource_stages(&self) -> Vec<serde_json::Value> {
        let mut start = self.resource_start;
        RESOURCE_STAGE_NAMES.iter().zip(self.resource_stage_ends.into_iter().chain(std::iter::once(self.resource_end)))
            .map(|(name, end)| {
                let value = serde_json::json!({"name":name,"startNs":start,"endNs":end,"durationNs":end-start});
                start = end;
                value
            }).collect()
    }
    pub(super) fn json(&self) -> serde_json::Value {
        serde_json::json!({"schema":"deep-engine.native-initial-preparation","schemaVersion":2,
            "deviceEpoch":self.epoch,"clockId":"host-monotonic","committed":true,
            "windowStartNs":0,"windowEndNs":self.resource_end,
            "scenePrepare":{"startNs":0,"endNs":self.scene_end,"durationNs":self.scene_end},
            "deviceSetup":{"startNs":self.scene_end,"endNs":self.resource_start,"durationNs":self.resource_start-self.scene_end},
            "resourcePrepare":{"startNs":self.resource_start,"endNs":self.resource_end,"durationNs":self.resource_end-self.resource_start,"stages":self.resource_stages()},
            "scope":"initial CPU scene preparation; async device setup; GPU resource creation, upload calls, pipeline setup and validation waits",
            "uploadedBytes":self.upload_bytes,
            "uploadedBytesCoverage":"renderer-direct queue.write_buffer/write_texture bytes inside the initial preparation window (section uniform, IBL environment textures resident estimate, cluster grid); device-level buffer init and BLAS/TLAS encoder copies stay device-accounted",
            "gpuUploadTimeNs":self.upload_elapsed_ns,
            "gpuUploadTimeClockId":"host-monotonic-upload-phase",
            "gpuUploadTimeNote":"upload-phase host-monotonic elapsed including CPU invocation, driver blocking and await waits; pure GPU transfer attribution requires timestamp-query and stays excluded"})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn complete_resources(clock: &mut InitialPreparationClock) {
        for index in 0..5 {
            clock.resource_stage_prepared(index).unwrap();
        }
    }
    #[test]
    fn disabled_does_not_create_a_clock() {
        assert!(InitialPreparationClock::begin(false).is_none());
    }
    #[test]
    fn rejects_missing_repeated_and_out_of_order_boundaries() {
        assert!(
            InitialPreparationClock::begin(true)
                .unwrap()
                .finish(1)
                .is_err()
        );
        let mut clock = InitialPreparationClock::begin(true).unwrap();
        assert!(clock.resources_started().is_err());
        clock.scene_prepared().unwrap();
        assert!(clock.scene_prepared().is_err());
        assert!(clock.finish(1).is_err());
        let mut clock = InitialPreparationClock::begin(true).unwrap();
        clock.scene_prepared().unwrap();
        clock.resources_started().unwrap();
        assert!(clock.resources_started().is_err());
        complete_resources(&mut clock);
        assert_eq!(clock.finish(0).unwrap().json()["deviceEpoch"], 0);
    }
    #[test]
    fn successful_commit_has_its_own_window_and_cpu_clock() {
        let mut clock = InitialPreparationClock::begin(true).unwrap();
        clock.scene_prepared().unwrap();
        clock.resources_started().unwrap();
        clock.note_upload_bytes(96);
        clock.upload_timed(|| {
            for _ in 0..10_000 {
                std::hint::black_box(64u64);
            }
        });
        clock.note_upload_bytes(64);
        complete_resources(&mut clock);
        let r = clock.finish(7).unwrap().json();
        assert_eq!(r["deviceEpoch"], 7);
        assert_eq!(r["clockId"], "host-monotonic");
        assert_eq!(r["windowEndNs"], r["resourcePrepare"]["endNs"]);
        assert_eq!(r["uploadedBytes"], 160);
        assert_eq!(r["gpuUploadTimeClockId"], "host-monotonic-upload-phase");
        let upload_ns = r["gpuUploadTimeNs"].as_u64().unwrap();
        assert!(
            upload_ns > 0,
            "gpuUploadTimeNs must be measured, not null/zero"
        );
        assert_eq!(r["committed"], true);
        let total = r["scenePrepare"]["durationNs"].as_u64().unwrap()
            + r["deviceSetup"]["durationNs"].as_u64().unwrap()
            + r["resourcePrepare"]["durationNs"].as_u64().unwrap();
        assert_eq!(total, r["windowEndNs"].as_u64().unwrap());
        let stages = r["resourcePrepare"]["stages"].as_array().unwrap();
        assert_eq!(stages.len(), 6);
        assert_eq!(
            stages
                .iter()
                .map(|stage| stage["durationNs"].as_u64().unwrap())
                .sum::<u64>(),
            r["resourcePrepare"]["durationNs"].as_u64().unwrap()
        );
        for pair in stages.windows(2) {
            assert_eq!(pair[0]["endNs"], pair[1]["startNs"]);
        }
        assert_eq!(stages[0]["startNs"], r["resourcePrepare"]["startNs"]);
        assert_eq!(stages[5]["endNs"], r["resourcePrepare"]["endNs"]);
    }
    #[test]
    fn resource_subphases_reject_early_duplicate_out_of_order_and_invalid_id() {
        let mut clock = InitialPreparationClock::begin(true).unwrap();
        assert!(clock.resource_stage_prepared(0).is_err());
        clock.scene_prepared().unwrap();
        clock.resources_started().unwrap();
        assert!(clock.resource_stage_prepared(1).is_err());
        assert!(clock.resource_stage_prepared(5).is_err());
        clock.resource_stage_prepared(0).unwrap();
        assert!(clock.resource_stage_prepared(0).is_err());
        assert!(clock.resource_stage_prepared(2).is_err());
        assert!(clock.finish(1).is_err());
    }
    #[test]
    fn invalid_subphase_clock_cannot_publish() {
        let mut clock = InitialPreparationClock::begin(true).unwrap();
        clock.scene_prepared().unwrap();
        clock.resources_started().unwrap();
        complete_resources(&mut clock);
        clock.resource_stage_ends[2] = Some(u64::MAX);
        assert!(clock.finish(1).is_err());
    }
}
