//! `--smoke-state-ops`: real-window playback of the frozen R3 state-op
//! sequence (clipping enable/move/disable/box + selection) on the same fixed
//! clock discipline as dynamic playback: the wall clock only decides *when*
//! each contracted step is applied, never *what* the state becomes. Every
//! applied step mutates the real `PlayerState`/`PlayerView` (with a real
//! `set_view` GPU submission for clipping changes) and is read back through
//! the f32 pipeline to prove the contract survives the native float width.
use std::time::Instant;

use crate::player_content::PlayerContent;
use crate::player_state::PlayerState;
use crate::renderer::Renderer;
use deep_engine_native::runtime_package::{
    ClipState, R3StateOps, axis_clip_field_from_plane, axis_clip_plane, canonical_r3_state_frame,
};

pub(super) enum AfterPresent {
    /// Playback incomplete: request another real-window frame.
    Continue,
    /// Every step applied and the final pose presented; the payload is the
    /// exit receipt JSON.
    Complete(String),
}

/// Real-window state-op playback configuration. The validated ops sequence and
/// the package hash it was frozen against travel together so a mismatched pair
/// fails the preflight instead of replaying against the wrong content.
pub struct StateOpsSpec {
    pub ops: R3StateOps,
    pub package_hash: String,
}

struct StatePresentation {
    frame: usize,
    elapsed_ms: u64,
    applied_steps: usize,
}

struct StepRecord {
    index: usize,
    at_ms: u64,
    canonical: String,
    /// Contract field read back from the real player state; `None` when the
    /// native player has no consumer for that mode (box clipping).
    applied: Option<String>,
    applied_note: Option<String>,
}

pub(super) struct StateOpsProbe {
    ops: R3StateOps,
    package_hash: String,
    started: Option<Instant>,
    next_step: usize,
    steps: Vec<StepRecord>,
    presentations: Vec<StatePresentation>,
}

impl StateOpsProbe {
    pub(super) fn new(spec: StateOpsSpec) -> Self {
        Self {
            ops: spec.ops,
            package_hash: spec.package_hash,
            started: None,
            next_step: 0,
            steps: Vec::new(),
            presentations: Vec::new(),
        }
    }

    fn replay_revisions(content: &PlayerContent, at_ms: u64) -> Vec<u64> {
        content
            .dynamic_runtime
            .as_ref()
            .map(|runtime| {
                runtime
                    .replay_events_at(at_ms)
                    .iter()
                    .map(|event| event.revision)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Applies one contracted step to the real player state and records the
    /// canonical frame plus the readback (applied) frame.
    fn apply_step(
        &mut self,
        renderer: &mut Renderer,
        content: &PlayerContent,
        state: &mut PlayerState,
    ) -> Result<(), String> {
        let index = self.next_step;
        let at_ms = self.ops.steps[index].at_ms;
        let revisions = Self::replay_revisions(content, at_ms);
        let (_, canonical, clip, selection) =
            canonical_r3_state_frame(&self.ops, index, &revisions)
                .map_err(|error| format!("step {index}: {error}"))?;
        match self.ops.steps[index].op.kind.as_str() {
            "clip-enable" | "clip-move" | "box-enable" | "clip-disable" => {
                // Box clipping has no native consumer: the canonical frame is
                // still produced (contract math), but the state is not applied
                // and the record honestly reports the gap instead of faking it.
                if matches!(clip, ClipState::Box { .. }) {
                    self.steps.push(StepRecord {
                        index,
                        at_ms,
                        canonical,
                        applied: None,
                        applied_note: Some(
                            "unsupported-native: PlayerView.clipping holds one plane; box clipping has no native consumer yet"
                                .into(),
                        ),
                    });
                    return Ok(());
                }
                let plane = axis_clip_plane(&clip)?;
                state.view.clipping = plane.map(|value| value as f32);
                renderer.set_view(state.view);
            }
            "select" | "clear-selection" => {
                // The contract owns selection independent of the pointer path:
                // the keyboard/picking section flow also clears selection on
                // clipping changes, so the player state is written directly.
                state.selected = selection.clone();
                state.selected_point = None;
            }
            other => return Err(format!("step {index}: unknown op kind {other}")),
        }
        let applied_clip = axis_clip_field_from_plane(state.view.clipping).map_err(|error| {
            format!("step {index}: applied clipping is not contract-representable: {error}")
        })?;
        let applied = format!(
            "r3-state-frame-v1|i={index}|t={at_ms}|clip={applied_clip}|sel={}|events={}",
            deep_engine_native::runtime_package::selection_field(state.selected.as_deref()),
            revisions
                .iter()
                .map(u64::to_string)
                .collect::<Vec<_>>()
                .join(","),
        );
        if applied != canonical {
            return Err(format!(
                "step {index}: applied state diverged from the contract\n  contract: {canonical}\n  applied:  {applied}"
            ));
        }
        self.steps.push(StepRecord {
            index,
            at_ms,
            canonical,
            applied: Some(applied),
            applied_note: None,
        });
        Ok(())
    }

    /// Advances the deterministic step grid against the real window clock.
    pub(super) fn before_render(
        &mut self,
        renderer: &mut Renderer,
        content: &PlayerContent,
        state: &mut PlayerState,
    ) -> Result<(), String> {
        let started = *self.started.get_or_insert_with(Instant::now);
        let elapsed_ms = started.elapsed().as_millis() as u64;
        while self.next_step < self.ops.steps.len() {
            if self.ops.steps[self.next_step].at_ms > elapsed_ms {
                break;
            }
            self.apply_step(renderer, content, state)?;
            self.next_step += 1;
        }
        Ok(())
    }

    pub(super) fn after_present(&mut self) -> AfterPresent {
        let elapsed_ms = self
            .started
            .map(|started| started.elapsed().as_millis() as u64)
            .unwrap_or(0);
        self.presentations.push(StatePresentation {
            frame: self.presentations.len() + 1,
            elapsed_ms,
            applied_steps: self.steps.len(),
        });
        if self.next_step < self.ops.steps.len() {
            return AfterPresent::Continue;
        }
        let receipt = serde_json::json!({
            "schema": "deep-engine.native-state-ops-receipt",
            "schemaVersion": 1,
            "opsId": self.ops.id,
            "packageHash": self.package_hash,
            "totalSteps": self.ops.steps.len(),
            "clock": "real-window",
            "steps": self.steps.iter().map(|step| serde_json::json!({
                "index": step.index,
                "atMs": step.at_ms,
                "canonical": step.canonical,
                "applied": step.applied,
                "appliedNote": step.applied_note,
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
