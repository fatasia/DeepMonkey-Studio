use std::{fs, path::Path, time::Instant};

use bevy::{
    diagnostic::{DiagnosticsStore, SystemInfo, SystemInformationDiagnosticsPlugin},
    prelude::*,
};
use serde::Serialize;

use crate::{args::RunnerArgs, gpu_info::{GpuIdentity, GpuInfo}};

#[derive(Resource)]
pub struct RunState {
    started: Instant,
    frames: u64,
    cpu_frame_ms: Vec<f64>,
    gpu_frame_ms: Vec<f64>,
    peak_host_bytes: f64,
    cold_start_ms: Option<f64>,
    load_to_interactive_ms: Option<f64>,
    render_diagnostic_paths: Vec<String>,
    args: RunnerArgs,
}

impl RunState {
    pub fn new(args: RunnerArgs, started: Instant) -> Self {
        Self { started, frames: 0, cpu_frame_ms: Vec::new(), gpu_frame_ms: Vec::new(),
            peak_host_bytes: 0.0, cold_start_ms: None, load_to_interactive_ms: None,
            render_diagnostic_paths: Vec::new(), args }
    }

    pub fn instance_count(&self) -> u32 { self.args.instances }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RawRun<'a> {
    schema: &'static str,
    schema_version: u8,
    engine: Engine,
    environment: Environment<'a>,
    fixture: Fixture,
    settings: Settings,
    samples: Samples<'a>,
    observations: Observations,
}

#[derive(Serialize)]
struct Engine { reference: &'static str, version: &'static str, renderer: &'static str, track: &'static str }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Environment<'a> { os: &'a str, kernel: &'a str, cpu: &'a str, core_count: &'a str,
    memory: &'a str, gpu: Option<GpuIdentity> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Fixture { id: &'static str, instance_count: u32, geometry_count: u32, material_count: u32, triangles: u64 }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings { width: u32, height: u32, warmup_frames: u64, sample_frames: u64, duration_seconds: f64,
    present_mode: &'static str, msaa_samples: u8, quality_profile: &'static str }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Samples<'a> { cpu_frame_ms: &'a [f64], gpu_frame_ms: &'a [f64] }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Observations { elapsed_seconds: f64, peak_host_bytes: f64, cold_start_ms: Option<f64>,
    load_to_interactive_ms: Option<f64>,
    render_diagnostic_paths: Vec<String>, gpu_timestamp_source: &'static str }

pub fn sample_and_finish(
    time: Res<Time<Real>>,
    diagnostics: Res<DiagnosticsStore>,
    system_info: Option<Res<SystemInfo>>,
    gpu_info: Res<GpuInfo>,
    mut state: ResMut<RunState>,
    mut exit: MessageWriter<AppExit>,
) {
    state.frames += 1;
    let elapsed = state.started.elapsed().as_secs_f64();
    if state.cold_start_ms.is_none() { state.cold_start_ms = Some(elapsed * 1000.0); }
    let gpu_value = render_gpu_frame_ms(&diagnostics, &mut state.render_diagnostic_paths);
    if state.load_to_interactive_ms.is_none() && gpu_value.is_some() {
        state.load_to_interactive_ms = Some(elapsed * 1000.0);
    }
    if let Some(memory_gib) = diagnostics.get(&SystemInformationDiagnosticsPlugin::PROCESS_MEM_USAGE)
        .and_then(|entry| entry.value())
    {
        state.peak_host_bytes = state.peak_host_bytes.max(memory_gib * 1024.0 * 1024.0 * 1024.0);
    }
    if state.frames > state.args.warmup_frames {
        state.cpu_frame_ms.push(time.delta_secs_f64() * 1000.0);
        if let Some(value) = gpu_value { state.gpu_frame_ms.push(value); }
    }
    let enough_samples = state.cpu_frame_ms.len() >= state.args.sample_frames as usize;
    let enough_duration = elapsed >= state.args.duration_seconds;
    if enough_samples && enough_duration {
        if let Err(error) = write_run(&state, system_info.as_deref(), &gpu_info) {
            eprintln!("failed to write benchmark evidence: {error}");
            exit.write(AppExit::error());
        } else {
            exit.write(AppExit::Success);
        }
    }
}

fn render_gpu_frame_ms(diagnostics: &DiagnosticsStore, paths: &mut Vec<String>) -> Option<f64> {
    let mut total = 0.0;
    let mut count = 0;
    for diagnostic in diagnostics.iter() {
        let path = diagnostic.path().as_str();
        if path.ends_with("/elapsed_gpu") {
            if !paths.iter().any(|entry| entry == path) { paths.push(path.to_owned()); }
            if let Some(value) = diagnostic.value().filter(|value| value.is_finite() && *value >= 0.0) {
                total += value;
                count += 1;
            }
        }
    }
    (count > 0).then_some(total)
}

fn write_run(state: &RunState, system_info: Option<&SystemInfo>, gpu_info: &GpuInfo)
    -> Result<(), Box<dyn std::error::Error>> {
    let unknown = "unavailable".to_owned();
    let info = system_info;
    let environment = Environment { os: info.map_or(&unknown, |value| &value.os),
        kernel: info.map_or(&unknown, |value| &value.kernel), cpu: info.map_or(&unknown, |value| &value.cpu),
        core_count: info.map_or(&unknown, |value| &value.core_count), memory: info.map_or(&unknown, |value| &value.memory),
        gpu: gpu_info.0.lock().expect("GPU identity lock poisoned").clone() };
    let document = RawRun { schema: "deep-engine.bevy-raw-run", schema_version: 1,
        engine: Engine { reference: "bevy", version: "0.19.1", renderer: "wgpu/vulkan", track: "native-wgpu" },
        environment,
        fixture: Fixture { id: "factory-instances/cubes-v2", instance_count: state.args.instances,
            geometry_count: 1, material_count: 1, triangles: u64::from(state.args.instances) * 12 },
        settings: Settings { width: 1280, height: 720, warmup_frames: state.args.warmup_frames,
            sample_frames: state.args.sample_frames, duration_seconds: state.args.duration_seconds,
            present_mode: "auto-no-vsync", msaa_samples: 4, quality_profile: "pbr-forward-hdr-tonemapped" },
        samples: Samples { cpu_frame_ms: &state.cpu_frame_ms, gpu_frame_ms: &state.gpu_frame_ms },
        observations: Observations { elapsed_seconds: state.started.elapsed().as_secs_f64(),
            peak_host_bytes: state.peak_host_bytes, cold_start_ms: state.cold_start_ms,
            load_to_interactive_ms: state.load_to_interactive_ms,
            render_diagnostic_paths: state.render_diagnostic_paths.clone(),
            gpu_timestamp_source: "bevy RenderDiagnosticsPlugin elapsed_gpu pass spans; summed per synced frame" } };
    if let Some(parent) = Path::new(&state.args.output).parent() { fs::create_dir_all(parent)?; }
    fs::write(&state.args.output, serde_json::to_vec_pretty(&document)?)?;
    Ok(())
}
