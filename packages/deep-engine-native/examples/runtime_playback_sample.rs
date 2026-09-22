//! F6 Native 嵌入最小示例：解析运行包并采样动态动画。
//!
//! 演示 Native 嵌入 SDK 的最小路径——不创建窗口或 GPU 设备：
//! 1. 从磁盘读取运行包 JSON；
//! 2. 校验并解码为 RuntimePackageSnapshot；
//! 3. 对动态动画按时间采样，输出每个目标的 TRS 状态。
//!
//! 运行：cargo run --example runtime_playback_sample -- <运行包.json> <时间毫秒>
//! 语义与 Web `dynamicRuntimePlayback.ts` 的 canonical 帧一致（同一 SHA-256 合同）。

use deep_engine_native::runtime_package::{
    parse_and_validate_dynamic_scene_runtime, DynamicSceneRuntime,
};

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().unwrap_or_else(|| {
        eprintln!("用法: runtime_playback_sample <运行包.json> [时间毫秒=0]");
        std::process::exit(2);
    });
    let time_ms: u64 = args
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);

    let raw = std::fs::read(&path).expect("读取运行包失败");
    let value: serde_json::Value =
        serde_json::from_slice(&raw).expect("运行包不是合法 JSON");
    let runtime = load_dynamic_channel(&value).expect("动态通道解码失败");

    println!(
        "durationMs={} tracks={} loop={}",
        runtime.animation.as_ref().map_or(0, |a| a.duration_ms),
        runtime.animation.as_ref().map_or(0, |a| a.tracks.len()),
        runtime.animation.as_ref().map_or(false, |a| a.r#loop),
    );
    for sample in runtime.sample_animation(time_ms) {
        println!(
            "{} {} = {:?}",
            sample.target_id, sample.property, sample.value
        );
    }
}

fn load_dynamic_channel(value: &serde_json::Value) -> Result<DynamicSceneRuntime, String> {
    let payload = value
        .get("payloads")
        .and_then(|payloads| payloads.get("scene.dynamic"))
        .ok_or("运行包缺少 scene.dynamic 动态通道")?;
    parse_and_validate_dynamic_scene_runtime(payload)
        .map_err(|error| format!("动态通道校验失败: {error}"))
}
