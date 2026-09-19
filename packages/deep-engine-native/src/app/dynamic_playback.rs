use std::time::Instant;

use crate::player_content::{DynamicPlaybackStep, PlayerContent};

use crate::renderer::Renderer;

pub const DYNAMIC_PLAYBACK_STEP_MS: u64 = 100;

/// Real-window dynamic playback configuration. The step grid indexes the
/// deterministic replay: the wall clock only decides *when* each step is
/// applied, never *what* is sampled, so the canonical frame sequence is
/// reproducible across runs and across renderers.
pub struct DynamicPlaybackSpec {
    pub step_ms: u64,
    pub duration_ms: u64,
    pub package_id: String,
    pub package_version: String,
    pub package_hash: String,
}

pub(super) enum AfterPresent {
    /// Playback incomplete: request another real-window frame.
    Continue,
    /// Every step applied and the final pose presented; the payload is the
    /// exit receipt JSON.
    Complete(String),
}

struct DynamicPresentation {
    frame: usize,
    elapsed_ms: u64,
    applied_steps: usize,
}

pub(super) struct DynamicPlaybackProbe {
    spec: DynamicPlaybackSpec,
    started: Option<Instant>,
    next_step: usize,
    total_steps: usize,
    steps: Vec<DynamicPlaybackStep>,
    presentations: Vec<DynamicPresentation>,
}

impl DynamicPlaybackProbe {
    pub(super) fn new(spec: DynamicPlaybackSpec) -> Self {
        let total_steps = (spec.duration_ms / spec.step_ms) as usize + 1;
        Self {
            spec,
            started: None,
            next_step: 0,
            total_steps,
            steps: Vec::new(),
            presentations: Vec::new(),
        }
    }

    fn step_time(&self, index: usize) -> u64 {
        (index as u64 * self.spec.step_ms).min(self.spec.duration_ms)
    }

    /// Advances the deterministic step grid against the real window clock and
    /// stages any newly covered steps onto the GPU before this frame renders.
    pub(super) fn before_render(
        &mut self,
        renderer: &mut Renderer,
        content: &mut PlayerContent,
    ) -> Result<(), String> {
        let started = *self.started.get_or_insert_with(Instant::now);
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let mut applied = 0usize;
        while self.next_step < self.total_steps {
            let step_time = self.step_time(self.next_step);
            if step_time > elapsed_ms {
                break;
            }
            self.steps.push(content.apply_dynamic_playback_step(step_time)?);
            self.next_step += 1;
            applied += 1;
        }
        if applied == 0 {
            return Ok(());
        }
        // Real render submission for the mutated scene: diff-staged packet
        // update, not a static re-present of unchanged content.
        let previous = content.packet().clone();
        pollster::block_on(renderer.replace_render_packet(&previous, content))?;
        Ok(())
    }

    pub(super) fn after_present(&mut self) -> AfterPresent {
        let elapsed_ms = self.started.map(|started| started.elapsed().as_millis() as u64).unwrap_or(0);
        self.presentations.push(DynamicPresentation {
            frame: self.presentations.len() + 1,
            elapsed_ms,
            applied_steps: self.steps.len(),
        });
        if self.next_step < self.total_steps {
            return AfterPresent::Continue;
        }
        let receipt = serde_json::json!({
            "schema": "deep-engine.native-dynamic-playback-receipt",
            "schemaVersion": 1,
            "packageId": self.spec.package_id,
            "packageVersion": self.spec.package_version,
            "packageHash": self.spec.package_hash,
            "durationMs": self.spec.duration_ms,
            "stepMs": self.spec.step_ms,
            "totalSteps": self.total_steps,
            "clock": "real-window",
            "steps": self.steps.iter().map(|step| serde_json::json!({
                "timeMs": step.time_ms,
                "canonical": step.canonical,
                "replayRevisions": step.replay_revisions,
                "changedInstances": step.changed_instances,
            })).collect::<Vec<_>>(),
            "presentations": self.presentations.iter().map(|presentation| serde_json::json!({
                "frame": presentation.frame,
                "elapsedMs": presentation.elapsed_ms,
                "appliedSteps": presentation.applied_steps,
            })).collect::<Vec<_>>(),
        });
        AfterPresent::Complete(receipt.to_string())
    }
}
