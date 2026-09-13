use crate::{
    player_content::PlayerContent,
    renderer::{Renderer, scene_update::RendererSceneEvidence},
    shadow_probe::ShadowProbeMetrics,
};

pub(super) struct ShadowUpdateProbe {
    rejected: Option<PlayerContent>,
    out_of_range: Option<PlayerContent>,
    replacement: Option<PlayerContent>,
    initial: Option<(RendererSceneEvidence, ShadowProbeMetrics)>,
    staged: Option<RendererSceneEvidence>,
}

impl ShadowUpdateProbe {
    pub(super) fn new(
        rejected: PlayerContent,
        out_of_range: PlayerContent,
        replacement: PlayerContent,
    ) -> Self {
        Self {
            rejected: Some(rejected),
            out_of_range: Some(out_of_range),
            replacement: Some(replacement),
            initial: None,
            staged: None,
        }
    }

    pub(super) fn after_present(
        &mut self,
        renderer: &mut Renderer,
        active: &mut PlayerContent,
    ) -> Result<bool, String> {
        if self.initial.is_none() {
            self.stage_replacement(renderer, active)?;
            return Ok(false);
        }
        self.verify_replacement(renderer)?;
        Ok(true)
    }

    fn stage_replacement(
        &mut self,
        renderer: &mut Renderer,
        active: &mut PlayerContent,
    ) -> Result<(), String> {
        let before = renderer.scene_update_evidence();
        let initial_probe = renderer
            .last_shadow_probe()
            .ok_or("initial shadow frame produced no probe evidence")?;
        let noop = pollster::block_on(renderer.replace_render_packet(active))?;
        if noop != Default::default() || renderer.scene_update_evidence() != before {
            return Err("identical RenderPacket was not a zero-work update".into());
        }
        let rejected = self.rejected.take().ok_or("missing rejected candidate")?;
        let rejection = match pollster::block_on(renderer.replace_render_packet(&rejected)) {
            Ok(_) => return Err("revision collision candidate unexpectedly committed".into()),
            Err(error) => error,
        };
        if !rejection.contains("reused for different content") {
            return Err(format!("unexpected replacement rejection: {rejection}"));
        }
        if renderer.scene_update_evidence() != before {
            return Err("rejected RenderPacket changed live scene or shadow state".into());
        }
        let out_of_range = self
            .out_of_range
            .take()
            .ok_or("missing out-of-range candidate")?;
        let rejection = match pollster::block_on(renderer.replace_render_packet(&out_of_range)) {
            Ok(_) => return Err("out-of-range bounds candidate unexpectedly committed".into()),
            Err(error) => error,
        };
        if !rejection.contains("floating-origin range") {
            return Err(format!("unexpected bounds rejection: {rejection}"));
        }
        if renderer.scene_update_evidence() != before {
            return Err("bounds rejection changed live scene or shadow state".into());
        }
        let replacement = self.replacement.take().ok_or("missing replacement")?;
        let metrics = pollster::block_on(renderer.replace_render_packet(&replacement))?;
        let staged = renderer.scene_update_evidence();
        validate_staged(before, staged, metrics)?;
        println!(
            "native shadow update staged: old_bounds={:?} new_bounds={:?} scene_version={} cache={metrics:?} revision_rollback=exact bounds_rollback=exact identical=noop",
            before.bounds, staged.bounds, staged.shadow_version.scene
        );
        *active = replacement;
        self.initial = Some((before, initial_probe));
        self.staged = Some(staged);
        Ok(())
    }

    fn verify_replacement(&self, renderer: &Renderer) -> Result<(), String> {
        let (before, initial_probe) = self.initial.ok_or("missing initial evidence")?;
        let staged = self.staged.ok_or("missing staged evidence")?;
        let final_state = renderer.scene_update_evidence();
        let final_probe = renderer
            .last_shadow_probe()
            .ok_or("replacement shadow frame produced no probe evidence")?;
        if final_state.shadow_render_pending
            || final_state.shadow_version != staged.shadow_version
            || final_state.bounds != staged.bounds
            || final_state.first_cascade != staged.first_cascade
        {
            return Err("replacement shadow frame did not commit the staged plan".into());
        }
        if final_probe.version != final_state.shadow_version
            || final_probe.version.scene == initial_probe.version.scene
            || final_probe.shadow_effect_hash == initial_probe.shadow_effect_hash
        {
            return Err("replacement did not change the rendered shadow evidence".into());
        }
        println!(
            "native shadow update GPU OK: scene_version={}=>{} changed_pixels={}=>{} effect_hash={:016x}=>{:016x} shadow_luminance={:.6}=>{:.6} plan_changed={} Vulkan-frame=presented cache={:?}",
            before.shadow_version.scene,
            final_state.shadow_version.scene,
            initial_probe.changed_pixels,
            final_probe.changed_pixels,
            initial_probe.shadow_effect_hash,
            final_probe.shadow_effect_hash,
            initial_probe.shadowed_luminance,
            final_probe.shadowed_luminance,
            before.first_cascade != final_state.first_cascade,
            final_state.cache_live,
        );
        Ok(())
    }
}

fn validate_staged(
    before: RendererSceneEvidence,
    staged: RendererSceneEvidence,
    metrics: crate::gpu_scene_cache::GpuSceneCacheMetrics,
) -> Result<(), String> {
    if staged.bounds == before.bounds
        || staged.first_cascade == before.first_cascade
        || staged.shadow_version.scene != before.shadow_version.scene.wrapping_add(1)
        || !staged.shadow_render_pending
        || staged.culling_candidates != before.culling_candidates
        || staged.cache_live != before.cache_live
    {
        return Err(
            "valid replacement did not stage new bounds, CSM plan and dirty version".into(),
        );
    }
    if metrics.geometry_reuses == 0
        || metrics.material_reuses == 0
        || metrics.instance_uploaded_bytes == 0
        || metrics.instance_copied_bytes == 0
    {
        return Err(format!(
            "replacement bypassed incremental GPU cache: {metrics:?}"
        ));
    }
    Ok(())
}
