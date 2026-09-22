use std::time::Instant;

use crate::{
    player_content::{DynamicPlaybackStep, PlayerContent},
    player_state::PlayerState,
};

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
        state: &mut PlayerState,
    ) -> Result<(), String> {
        let started = *self.started.get_or_insert_with(Instant::now);
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let mut applied = 0usize;
        while self.next_step < self.total_steps {
            let step_time = self.step_time(self.next_step);
            if step_time > elapsed_ms {
                break;
            }
            let previous = content.packet().clone();
            let step = content.apply_dynamic_playback_step(step_time)?;
            apply_camera(content, state, renderer, step_time)?;
            if step.changed_instances > 0 {
                pollster::block_on(renderer.replace_render_packet(&previous, content))?;
            }
            self.steps.push(step);
            self.next_step += 1;
            applied += 1;
        }
        if applied == 0 {
            return Ok(());
        }
        // Real render submission for the mutated scene: diff-staged packet
        // update, not a static re-present of unchanged content.
        Ok(())
    }

    pub(super) fn after_present(&mut self) -> AfterPresent {
        let elapsed_ms = self
            .started
            .map(|started| started.elapsed().as_millis() as u64)
            .unwrap_or(0);
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

pub(super) struct ProductDynamicPlayback {
    started: Instant,
    next_frame: Instant,
    duration_ms: u64,
    looping: bool,
    finished: bool,
}

pub(super) struct ProductPhysicsPlayback {
    last_frame: Instant,
    next_frame: Instant,
    reported: bool,
}

impl ProductPhysicsPlayback {
    pub(super) fn for_content(content: &PlayerContent) -> Option<Self> {
        if !content.physics_playing() {
            return None;
        }
        let now = Instant::now();
        Some(Self {
            last_frame: now,
            next_frame: now,
            reported: false,
        })
    }

    pub(super) fn wake_at(&self) -> Instant {
        self.next_frame
    }

    pub(super) fn before_render(
        &mut self,
        renderer: &mut Renderer,
        content: &mut PlayerContent,
    ) -> Result<(), String> {
        let now = Instant::now();
        let delta = now.duration_since(self.last_frame).as_secs_f64();
        self.last_frame = now;
        self.next_frame = now + std::time::Duration::from_millis(16);
        let previous = content.packet().clone();
        let changed = content.advance_physics(delta)?;
        if changed > 0 {
            pollster::block_on(renderer.replace_render_packet(&previous, content))?;
            if !self.reported {
                println!(
                    "native physics runtime active: fixed step synchronized {changed} render instances"
                );
                self.reported = true;
            }
        }
        Ok(())
    }
}

impl ProductDynamicPlayback {
    pub(super) fn for_content(content: &PlayerContent) -> Option<Self> {
        let (duration_ms, autoplay, looping) = content.dynamic_runtime_playback()?;
        if !autoplay || duration_ms == 0 {
            return None;
        }
        let now = Instant::now();
        Some(Self {
            started: now,
            next_frame: now,
            duration_ms,
            looping,
            finished: false,
        })
    }

    pub(super) fn wake_at(&self) -> Option<Instant> {
        (!self.finished).then_some(self.next_frame)
    }

    pub(super) fn before_render(
        &mut self,
        renderer: &mut Renderer,
        content: &mut PlayerContent,
        state: &mut PlayerState,
    ) -> Result<(), String> {
        if self.finished {
            return Ok(());
        }
        let elapsed = self.started.elapsed().as_millis() as u64;
        let time_ms = if self.looping {
            elapsed % self.duration_ms
        } else {
            elapsed.min(self.duration_ms)
        };
        let previous = content.packet().clone();
        let step = content.apply_dynamic_playback_step(time_ms)?;
        apply_camera(content, state, renderer, time_ms)?;
        if step.changed_instances > 0 {
            pollster::block_on(renderer.replace_render_packet(&previous, content))?;
        }
        if !self.looping && elapsed >= self.duration_ms {
            self.finished = true;
        }
        self.next_frame = Instant::now() + std::time::Duration::from_millis(16);
        Ok(())
    }
}

fn apply_camera(
    content: &PlayerContent,
    state: &mut PlayerState,
    renderer: &mut Renderer,
    time_ms: u64,
) -> Result<(), String> {
    let Some(frame) = content.sample_dynamic_camera(time_ms) else {
        return Ok(());
    };
    state.view = state.view.with_eye_target(frame.position, frame.target)?;
    renderer.set_view(state.view);
    Ok(())
}
