//! Fixed-fixture measurements, enabled only by the native-bench build and env.
use crate::{player_content::PlayerContent, renderer::Renderer};
use deep_engine_native::{
    benchmark_observer as observer,
    benchmark_workload::{fixture_indices, rebuild, rotate},
    contract::RenderPacket,
};
use serde_json::{Value, json};
use web_time::Instant;

pub(crate) fn validate(content: &PlayerContent) -> Result<Option<String>, String> {
    let Ok(workload) = std::env::var("DEEP_ENGINE_BENCH_WORKLOAD") else {
        return Ok(None);
    };
    if !observer::AVAILABLE {
        return Err("benchmark requires cargo --features native-bench".into());
    }
    if !["static", "dynamic", "rebuild"].contains(&workload.as_str()) {
        return Err(format!("unknown benchmark workload: {workload}"));
    }
    let packet = content.packet();
    let count = packet.instances.len().saturating_sub(1);
    if ![120, 1000].contains(&count)
        || (workload != "static" && count != 1000)
        || packet.geometries.len() != 7
        || packet.materials.len() != 7
        || content.deep2d.is_some()
        || content.chart.is_some()
        || !content.shader_packages.is_empty()
        || !packet
            .instances
            .iter()
            .any(|item| item.id == "fixture-ground")
        || fixture_indices(packet).is_none()
    {
        return Err("benchmark requires the primitive-only render-engine fixture".into());
    }
    Ok(Some(workload))
}

pub(super) struct Benchmark {
    workload: String,
    baseline: RenderPacket,
    indices: Vec<usize>,
    colors: Vec<String>,
    angles: Vec<f32>,
    clock: Instant,
    first_present: bool,
    measured_updates: usize,
    rebuild_ms: Vec<f64>,
    heap_bytes: Vec<i64>,
    draws: Vec<u32>,
}

impl Benchmark {
    pub(super) fn from_env(content: &PlayerContent) -> Option<Self> {
        let workload = validate(content).ok().flatten()?;
        let baseline = content.packet().clone();
        let indices = fixture_indices(&baseline)?;
        let colors = indices[..6]
            .iter()
            .map(|&i| baseline.instances[i].material.clone())
            .collect();
        Some(Self {
            workload,
            angles: (0..indices.len()).map(|i| i as f32 * 0.17).collect(),
            baseline,
            indices,
            colors,
            clock: Instant::now(),
            first_present: false,
            measured_updates: 0,
            rebuild_ms: Vec::with_capacity(512),
            heap_bytes: Vec::with_capacity(513),
            draws: Vec::with_capacity(512),
        })
    }

    pub(super) fn before_render(
        &mut self,
        renderer: &mut Renderer,
        content: &mut PlayerContent,
        sampling: bool,
    ) -> Result<(), String> {
        if self.workload == "static" || (self.workload == "rebuild" && !sampling) {
            observer::begin_draw_frame();
            return Ok(());
        }
        if sampling && self.workload == "rebuild" && self.heap_bytes.is_empty() {
            self.heap_bytes.push(observer::live_bytes());
        }
        let started = Instant::now();
        let previous = content.packet().clone();
        let mut next = content.packet().clone();
        if self.workload == "dynamic" {
            let time_ms = self.clock.elapsed().as_secs_f64() * 1000.0;
            for i in 0..200 {
                self.angles[i] += 0.004 + (i % 5) as f32 * 0.0004;
                let slot = self.indices[i];
                let mut transform = self.baseline.instances[slot].transform;
                rotate(&mut transform, self.angles[i], i);
                transform[13] += ((time_ms * 0.0015 + i as f64).sin() * 0.08) as f32;
                next.instances[slot].transform = transform;
            }
        } else {
            rebuild(
                &self.baseline,
                &self.indices,
                &self.colors,
                self.measured_updates + 1,
                &mut next,
            );
        }
        content.replace_benchmark_packet(next);
        pollster::block_on(renderer.replace_render_packet(&previous, content))?;
        // Include construction, content hashing and the real GPU publication transaction.
        drop(previous);
        if sampling {
            self.measured_updates += 1;
            if self.workload == "rebuild" {
                self.rebuild_ms
                    .push(started.elapsed().as_secs_f64() * 1000.0);
            }
        }
        observer::begin_draw_frame();
        Ok(())
    }

    pub(super) fn after_render(&mut self, presented: bool, sampling: bool) {
        let draws = observer::end_draw_frame();
        if !presented {
            return;
        }
        if !self.first_present {
            self.first_present = true;
            println!(
                "native benchmark first present: {}",
                json!({"workload": self.workload,
                "boundary": "surface.present returned; parent observes stdout receipt"})
            );
        }
        if sampling {
            self.draws.push(draws);
            if self.workload == "rebuild" {
                self.heap_bytes.push(observer::live_bytes());
            }
        }
    }

    pub(super) fn report(&self) -> Value {
        json!({ "schema": "deep-engine.fixture-benchmark", "version": 1,
            "workload": self.workload, "observerBuild": observer::AVAILABLE,
            "movingObjects": if self.workload == "dynamic" {200} else {0},
            "measuredUpdates": self.measured_updates,
            "drawCommands": self.draws, "drawScope": "all encoded render draw calls; indirect commands count once even if culled",
            "rebuildMs": self.rebuild_ms, "heapBytes": self.heap_bytes,
            "heapScope": "live Rust GlobalAlloc bytes after present; excludes driver/GPU and native system allocations" })
    }
}
