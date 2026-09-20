//! R10 CLI:运行固定步长场景,输出 native-result.json 与 frames-native.jsonl。
//! 用法:physics-validate <scene-spec.json> <out-dir>
//! 输出无时间戳、无随机字段:同输入两次运行字节级一致(除路径字段)。

use physics_validate::{canonical_frame, parse_spec, run_scene, summarize, FrameRecord};
use serde_json::{json, Value};
use std::path::PathBuf;

fn main() {
    let mut args = std::env::args().skip(1);
    let scene_path = args.next().unwrap_or_else(|| usage());
    let out_dir = args.next().unwrap_or_else(|| usage());
    let spec_bytes = std::fs::read(&scene_path).unwrap_or_else(|error| {
        panic!("read scene spec {scene_path}: {error}");
    });
    let spec = parse_spec(&spec_bytes).unwrap_or_else(|error| panic!("{error}"));
    let outcome = run_scene(&spec);
    let summary = summarize(&outcome.frames);

    std::fs::create_dir_all(&out_dir).expect("create out dir");
    let frames_path = PathBuf::from(&out_dir).join("frames-native.jsonl");
    let frames_text: String = outcome
        .frames
        .iter()
        .map(|frame| format!("{}\n", canonical_frame(frame)))
        .collect();
    std::fs::write(&frames_path, frames_text).expect("write frames");

    let result_path = PathBuf::from(&out_dir).join("native-result.json");
    let result = build_result(&scene_path, &spec, &spec_bytes, &outcome.frames, &summary);
    std::fs::write(
        &result_path,
        serde_json::to_string_pretty(&result).expect("serialize result"),
    )
    .expect("write result");
    println!("{}", result_path.display());
}

fn build_result(
    scene_path: &str,
    spec: &physics_validate::SceneSpec,
    spec_bytes: &[u8],
    frames: &[FrameRecord],
    summary: &physics_validate::FrameSummary,
) -> Value {
    let last = frames.last().expect("at least one frame");
    json!({
        "engine": {
            "name": "rapier3d",
            "version": rapier3d::VERSION,
            "versionSource": "Cargo.toml =0.35.3 (Cargo.lock; parry3d 0.30.2 同源核对见 README.md)",
            "features": ["enhanced-determinism"],
            "buildProfile": "dev(数值语义与 release 一致:无 fast-math)",
        },
        "spec": {
            "path": scene_path,
            "sha256": physics_validate::hash::sha256(spec_bytes),
            "scene": serde_json::to_value(spec).expect("serialize spec"),
        },
        "timestep": {
            "mode": "fixed",
            "dtF64": spec.timestep.dt,
            "dtF32Bits": format!("0x{:08x}", (spec.timestep.dt as f32).to_bits()),
            "steps": spec.timestep.steps,
            "frames": frames.len(),
        },
        "summary": {
            "frameSequenceSha256": summary.frame_sequence_sha256,
            "poseBitsSha256": summary.pose_bits_sha256,
            "jointBitsSha256": summary.joint_bits_sha256,
        },
        "framesRaw": frames
            .iter()
            .map(|frame| {
                json!({
                    "step": frame.step,
                    "bodies": frame
                        .bodies
                        .iter()
                        .map(|(id, pose)| json!([id, pose]))
                        .collect::<Vec<_>>(),
                    "joints": frame.joints.iter().map(|joint| json!({
                        "id": joint.id,
                        "kind": joint.kind,
                        "body1": joint.body1,
                        "body2": joint.body2,
                        "anchor1": joint.anchor1,
                        "anchor2": joint.anchor2,
                        "frame1": joint.frame1,
                        "frame2": joint.frame2,
                    })).collect::<Vec<_>>(),
                })
            })
            .collect::<Vec<_>>(),
        "finalPoses": last
            .bodies
            .iter()
            .map(|(id, pose)| {
                json!([id, pose.iter().map(|v| f64::from(*v)).collect::<Vec<_>>()])
            })
            .collect::<Vec<_>>(),
    })
}

fn usage() -> ! {
    eprintln!("用法: physics-validate <scene-spec.json> <out-dir>");
    std::process::exit(2);
}
