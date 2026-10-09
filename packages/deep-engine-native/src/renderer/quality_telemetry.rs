//! T01 跨端质量诊断:与 TS `packages/deep-engine/src/webgpu/qualityTelemetry.ts`
//! 同语义的 Native 镜像与逐帧采集。字段经 serde 以 camelCase 原名序列化,
//! 保证 WebGPU/Native/WASM 三端报告字段一致,不造第二套词汇。
//!
//! 覆盖口径(写入 report 的 `coverage`,消费方据此解读,禁止伪零值解读):
//! - `passCount`:render 循环可辨识的 pass 编码边界(bloom 内部子 pass 不细分);
//! - `uploadedBytes`:renderer 边界直发的 `queue.write_buffer` 字节
//!   (set_view/resize 的 frame/section uniform);culling/lod/deep2d 等
//!   模块内部上传不在本切片所有权内,未计入;
//! - `visibleInstances`:HiZ 遮挡读回挂载时的主视锥 drawn 实例数;未挂载
//!   时为 null(未测量),绝不回退写成候选数;
//! - `activeProfile`:`DEEP_ENGINE_QUALITY_PROFILE` 解析结果;未设档为 null;
//! - `adaptiveDecisions`:Native 档位是静态环境变量,无自适应控制器,恒 0。
//!
//! 关闭诊断零开销:Renderer 持有 `Option<QualityTelemetry>`,关闭时为
//! `None`,frame.rs 全部采集点都是 `if let Some` 短路守卫——无分配、无
//! 格式化、无遍历(测试见本文件 `disabled_frame_loop_performs_zero_...`)。

use std::collections::VecDeque;

use serde::Serialize;

pub const QUALITY_TELEMETRY_SCHEMA: &str = "deep-engine.quality-telemetry";
pub const QUALITY_TELEMETRY_VERSION: u32 = 1;
const QUALITY_TELEMETRY_CAPACITY: usize = 256;

/// 活动质量档名;词汇与 TS `AuthoredQualityProfile` 一致,None = 作者未设档。
pub type ActiveProfileName = Option<&'static str>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityFrameRecord {
    pub frame: u64,
    pub pass_count: u32,
    pub uploaded_bytes: u64,
    /// None = 未测量(该帧无遮挡读回),序列化为 null。
    pub visible_instances: Option<u32>,
    pub active_profile: ActiveProfileName,
    pub adaptive_decisions: u32,
}

/// 有界质量诊断窗口。采集方法全部 `#[inline]` 标量推进,关闭态不触达。
#[derive(Debug)]
pub struct QualityTelemetry {
    window: VecDeque<QualityFrameRecord>,
    /// 帧间事件驱动的 renderer 直发上传字节,随下一帧落账。
    pending_upload_bytes: u64,
    in_frame_passes: u32,
    in_frame_visible: Option<u32>,
    frame_started: bool,
    next_frame: u64,
    active_profile: ActiveProfileName,
}

impl QualityTelemetry {
    pub(crate) fn new(active_profile: ActiveProfileName) -> Self {
        Self {
            window: VecDeque::with_capacity(QUALITY_TELEMETRY_CAPACITY),
            pending_upload_bytes: 0,
            in_frame_passes: 0,
            in_frame_visible: None,
            frame_started: false,
            next_frame: 0,
            active_profile,
        }
    }

    /// R6 热切换候补:运行中改写活动档名。当前仅测试消费;wasm 镜像与
    /// 窄特性目标不调用,按仓库惯例标注保留。
    #[allow(dead_code)]
    pub(crate) fn set_active_profile(&mut self, name: ActiveProfileName) {
        self.active_profile = name;
    }

    /// 帧起点:失败早退帧不落账,下一帧 begin 丢弃残余帧内计数。
    #[inline]
    pub(crate) fn begin_frame(&mut self) {
        self.in_frame_passes = 0;
        self.in_frame_visible = None;
        self.frame_started = true;
        self.next_frame += 1;
    }

    /// pass 编码边界计数;内层热路径,仅标量自增。
    #[inline]
    pub(crate) fn record_pass(&mut self) {
        self.in_frame_passes = self.in_frame_passes.saturating_add(1);
    }

    /// renderer 边界直发上传字节(帧间事件归入下一帧记录)。
    #[inline]
    pub(crate) fn note_upload_bytes(&mut self, bytes: u64) {
        self.pending_upload_bytes = self.pending_upload_bytes.saturating_add(bytes);
    }

    /// 主视锥剔除后实际绘制实例数(遮挡读回)。重复报告取首次,不覆盖。
    /// wasm 镜像暂不挂读回链(读回在非 wasm 帧路径),标注保留。
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))]
    #[inline]
    pub(crate) fn note_visible_instances(&mut self, drawn: u32) {
        if self.in_frame_visible.is_none() {
            self.in_frame_visible = Some(drawn);
        }
    }

    /// 帧落账:仅 presented 帧进入窗口;未 begin 的调用被拒绝(合同,
    /// 非静默吞)。上传字节取「自上一落账以来」的全部 pending。
    pub(crate) fn finish_frame(&mut self) -> Result<QualityFrameRecord, String> {
        if !self.frame_started {
            return Err("quality telemetry finish_frame without begin_frame".to_string());
        }
        self.frame_started = false;
        let record = QualityFrameRecord {
            frame: self.next_frame.saturating_sub(1),
            pass_count: self.in_frame_passes,
            uploaded_bytes: std::mem::take(&mut self.pending_upload_bytes),
            visible_instances: self.in_frame_visible.take(),
            active_profile: self.active_profile,
            adaptive_decisions: 0,
        };
        self.window.push_back(record);
        while self.window.len() > QUALITY_TELEMETRY_CAPACITY {
            self.window.pop_front();
        }
        Ok(record)
    }

    /// 最新落账帧号;无帧时 None(供诊断访问器判空,不构造 JSON)。
    #[allow(dead_code)]
    pub fn last_frame(&self) -> Option<u64> {
        self.window.back().map(|record| record.frame)
    }

    /// 诊断 JSON:字段 camelCase 与 TS schema 原名一致。
    pub fn report(&self) -> serde_json::Value {
        let latest = self.window.back();
        let totals_pass = self
            .window
            .iter()
            .map(|r| u64::from(r.pass_count))
            .sum::<u64>();
        let totals_upload = self.window.iter().map(|r| r.uploaded_bytes).sum::<u64>();
        let measured = self
            .window
            .iter()
            .filter(|r| r.visible_instances.is_some())
            .count();
        serde_json::json!({
            "schema": QUALITY_TELEMETRY_SCHEMA,
            "version": QUALITY_TELEMETRY_VERSION,
            "capacity": QUALITY_TELEMETRY_CAPACITY,
            "retainedFrameCount": self.window.len(),
            "firstFrame": self.window.front().map(|r| r.frame),
            "lastFrame": latest.map(|r| r.frame),
            "totals": {
                "passCount": totals_pass,
                "uploadedBytes": totals_upload,
                "framesWithMeasuredVisibleInstances": measured,
            },
            "activeProfile": latest.and_then(|r| r.active_profile),
            "adaptiveDecisions": latest.map(|r| r.adaptive_decisions),
            "frames": self.window.iter().collect::<Vec<_>>(),
            "coverage": {
                "passCount": "render-frame-boundaries",
                "uploadedBytes": "renderer-direct-queue-writes",
                "visibleInstances": "hiz-occlusion-readback",
                "adaptiveDecisions": "static-native-profile",
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record_of(quality: &mut QualityTelemetry) -> QualityFrameRecord {
        quality.begin_frame();
        quality.finish_frame().expect("started frame must finish")
    }

    #[test]
    fn frame_records_track_passes_uploads_and_unmeasured_visible_instances() {
        let mut quality = QualityTelemetry::new(Some("quality"));
        quality.begin_frame();
        quality.record_pass();
        quality.record_pass();
        quality.record_pass();
        quality.note_upload_bytes(96);
        quality.note_visible_instances(1234);
        let first = quality.finish_frame().unwrap();
        assert_eq!(
            first,
            QualityFrameRecord {
                frame: 0,
                pass_count: 3,
                uploaded_bytes: 96,
                visible_instances: Some(1234),
                active_profile: Some("quality"),
                adaptive_decisions: 0,
            }
        );

        // 未设档 + 无遮挡读回帧:visible_instances 必须是 null,不得伪零。
        quality.set_active_profile(None);
        quality.note_upload_bytes(64);
        let second = record_of(&mut quality);
        assert_eq!(second.visible_instances, None);
        assert_eq!(second.active_profile, None);
        assert_eq!(second.uploaded_bytes, 64);

        let report = quality.report();
        assert_eq!(report["schema"], QUALITY_TELEMETRY_SCHEMA);
        assert_eq!(report["version"], QUALITY_TELEMETRY_VERSION);
        assert_eq!(report["retainedFrameCount"], 2);
        assert_eq!(report["totals"]["passCount"], 3);
        assert_eq!(report["totals"]["uploadedBytes"], 160);
        assert_eq!(report["totals"]["framesWithMeasuredVisibleInstances"], 1);
        assert_eq!(report["activeProfile"], serde_json::Value::Null);
        assert_eq!(
            report["coverage"]["uploadedBytes"],
            "renderer-direct-queue-writes"
        );
    }

    #[test]
    fn records_serialize_with_ts_identical_camel_case_names() {
        let mut quality = QualityTelemetry::new(Some("ultra"));
        quality.begin_frame();
        quality.record_pass();
        quality.note_visible_instances(7);
        quality.finish_frame().unwrap();
        let report = quality.report();
        let frame = &report["frames"][0];
        for key in [
            "frame",
            "passCount",
            "uploadedBytes",
            "visibleInstances",
            "activeProfile",
            "adaptiveDecisions",
        ] {
            assert!(
                frame.get(key).is_some(),
                "missing TS-contract key `{key}` in {frame}"
            );
        }
        assert_eq!(frame["passCount"], 1);
        assert_eq!(frame["visibleInstances"], 7);
    }

    #[test]
    fn window_is_bounded_and_evicts_oldest_frames() {
        let mut quality = QualityTelemetry::new(None);
        for _ in 0..(QUALITY_TELEMETRY_CAPACITY + 10) {
            record_of(&mut quality);
        }
        let report = quality.report();
        assert_eq!(report["retainedFrameCount"], QUALITY_TELEMETRY_CAPACITY);
        assert_eq!(report["firstFrame"], 10);
    }

    #[test]
    fn finish_without_begin_is_rejected_not_swallowed() {
        let mut quality = QualityTelemetry::new(None);
        assert!(quality.finish_frame().is_err());
        assert_eq!(quality.report()["retainedFrameCount"], 0);
    }

    // ---- 关闭诊断零开销证明 ----
    //
    // 关闭态在 Renderer 中表现为 `Option<QualityTelemetry> = None`;frame.rs
    // 的全部采集点都是 `if let Some` 短路。下面的测试用线程局部分配计数器,
    // 复现 frame.rs 的调用形状(None 门控同序调用),断言关闭态帧循环零堆
    // 分配;开启态同形状分配 > 0 作为计数器有效性的对照。
    //
    // 诚实边界:真实 render() 帧内驱动/提交线程分配不可控,整帧零分配断言
    // 不可行;此处证明的是采集路径本身的零开销机制。

    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::Cell;

    struct ThreadCountingAlloc;

    thread_local! {
        static COUNTING: Cell<bool> = const { Cell::new(false) };
        static ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
    }

    unsafe impl GlobalAlloc for ThreadCountingAlloc {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            if COUNTING.with(Cell::get) {
                ALLOCATIONS.with(|count| count.set(count.get() + 1));
            }
            unsafe { System.alloc(layout) }
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            unsafe { System.dealloc(ptr, layout) }
        }
        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            if COUNTING.with(Cell::get) {
                ALLOCATIONS.with(|count| count.set(count.get() + 1));
            }
            unsafe { System.realloc(ptr, layout, new_size) }
        }
    }

    // crate 全局唯一 global allocator;仅测试构建生效(生产/WASM 构建不含
    // cfg(test) 块)。经 System 直通,只对开启计数的线程累计,不影响并行测试。
    #[global_allocator]
    static QUALITY_TELEMETRY_TEST_ALLOC: ThreadCountingAlloc = ThreadCountingAlloc;

    /// frame.rs 采集调用形状(None/Some 同一门控、同一调用序)。
    fn drive_frame(gate: &mut Option<QualityTelemetry>) {
        if let Some(quality) = gate.as_mut() {
            quality.begin_frame();
        }
        if let Some(quality) = gate.as_mut() {
            quality.record_pass();
        }
        if let Some(quality) = gate.as_mut() {
            quality.record_pass();
        }
        if let Some(quality) = gate.as_mut() {
            quality.note_upload_bytes(96);
        }
        if let Some(quality) = gate.as_mut() {
            quality.note_visible_instances(12);
        }
        if let Ok(record) = gate
            .as_mut()
            .map(QualityTelemetry::finish_frame)
            .unwrap_or_else(|| Err(String::new()))
        {
            std::hint::black_box(record);
        }
    }

    fn counted<F: FnOnce()>(body: F) -> usize {
        COUNTING.with(|flag| flag.set(true));
        let before = ALLOCATIONS.with(Cell::get);
        body();
        let after = ALLOCATIONS.with(Cell::get);
        COUNTING.with(|flag| flag.set(false));
        after - before
    }

    #[test]
    fn disabled_frame_loop_performs_zero_heap_allocations() {
        let mut gate: Option<QualityTelemetry> = None;
        drive_frame(&mut gate); // 预热:排除 thread_local 初始化等一次性成本
        let allocations = counted(|| {
            for _ in 0..1_000 {
                drive_frame(&mut gate);
            }
        });
        assert_eq!(
            allocations, 0,
            "disabled quality telemetry frame loop must not allocate"
        );
    }

    #[test]
    fn enabled_in_frame_collection_is_zero_alloc_until_bounded_window_fills() {
        let mut gate: Option<QualityTelemetry> = Some(QualityTelemetry::new(Some("quality")));
        drive_frame(&mut gate); // 预热
        // 窗口容量内:开启态采集同样零堆分配(标量推进 + 预分配有界环)。
        let allocations = counted(|| {
            for _ in 0..8 {
                drive_frame(&mut gate);
            }
        });
        assert_eq!(
            allocations, 0,
            "enabled quality collection must not allocate before the bounded window fills"
        );
        assert_eq!(gate.as_ref().unwrap().report()["retainedFrameCount"], 9);
    }

    #[test]
    fn report_path_allocates_and_counting_harness_is_live() {
        let mut gate: Option<QualityTelemetry> = Some(QualityTelemetry::new(Some("quality")));
        drive_frame(&mut gate);
        let json_allocations = counted(|| {
            std::hint::black_box(gate.as_mut().unwrap().report());
        });
        assert!(
            json_allocations > 0,
            "report path is JSON and must show the counter works"
        );
        // 窗口溢出触发有界环再分配:证明溢出路径有界,不会无界增长。
        let mut overflow_allocations = counted(|| {
            for _ in 0..(QUALITY_TELEMETRY_CAPACITY + 8) {
                drive_frame(&mut gate);
            }
        });
        std::hint::black_box(&mut overflow_allocations);
        assert_eq!(
            gate.as_ref().unwrap().report()["retainedFrameCount"],
            QUALITY_TELEMETRY_CAPACITY
        );
    }
}
