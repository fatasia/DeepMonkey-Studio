use std::{fs, path::Path};

use deep_engine_native::bloom::BloomSettings;

#[test]
fn bloom_contract_is_hdr_first_and_has_an_exact_disabled_mode() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let bloom = fs::read_to_string(root.join("assets/shaders/native_bloom_v1.wgsl")).unwrap();
    let output =
        fs::read_to_string(root.join("assets/shaders/native_output_bloom_v1.wgsl")).unwrap();
    let pass = fs::read_to_string(root.join("src/bloom_pass.rs")).unwrap();

    for entry in [
        "fragment_prefilter",
        "fragment_blur_horizontal",
        "fragment_blur_vertical",
    ] {
        assert!(bloom.contains(entry), "missing bloom stage {entry}");
    }
    assert!(bloom.contains("bloom.threshold * bloom.soft_knee"));
    assert!(output.contains("hdr.rgb + glow"));
    assert!(output.contains("textureSampleLevel(bloom_color, bloom_sampler"));
    // F4 色彩分级后 tonemap 调用点为 aces(author_grading_apply(hdr.rgb))：
    // bloom glow 必须在 ACES 之前合成（合同不变，断言随输出链同步）。
    assert!(
        output.find("hdr.rgb + glow").unwrap()
            < output.find("aces(author_grading_apply(hdr.rgb))").unwrap()
    );
    assert!(pass.contains("if !settings.is_active()"));
    assert!(pass.contains("return Ok(None)"));
    assert!(!BloomSettings::DISABLED.validate().unwrap().is_active());
}

#[test]
fn bloom_uses_half_resolution_reusable_targets() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let pass = fs::read_to_string(root.join("src/bloom_pass.rs")).unwrap();
    assert!(pass.contains("div_ceil(2)"));
    assert_eq!(pass.matches("create_target(device, extent").count(), 3);
    assert_eq!(pass.matches("create_pipeline(").count(), 3);
    let pipeline = fs::read_to_string(root.join("src/bloom_pipeline.rs")).unwrap();
    let output_pass = fs::read_to_string(root.join("src/output_pass.rs")).unwrap();
    assert!(pipeline.contains("min_binding_size: wgpu::BufferSize::new(16)"));
    assert!(output_pass.contains("min_binding_size: wgpu::BufferSize::new(16)"));
    assert!(output_pass.contains("SamplerBindingType::Filtering"));
    assert!(
        !pass.contains("create_pipeline(device")
            || pass.find("pub fn encode").unwrap() > pass.rfind("create_pipeline(").unwrap()
    );
}

#[test]
fn fog_is_a_separate_opt_in_hdr_variant_before_aces() {
    let plain = include_str!("../assets/shaders/native_output_v1.wgsl");
    let fog = include_str!("../assets/shaders/native_output_fog_v1.wgsl");
    let bloom_fog = include_str!("../assets/shaders/native_output_bloom_fog_v1.wgsl");
    assert!(!plain.contains("forward_depth"));
    for shader in [fog, bloom_fog] {
        assert!(shader.contains("texture_depth_multisampled_2d"));
        assert!(shader.contains("let near = frame.fogProjection.x"));
        assert!(shader.contains("let far = frame.fogProjection.y"));
        assert!(shader.contains(
            "select(optical_depth, optical_depth * optical_depth, frame.fogProjection.z == 2.0)"
        ));
        assert!(shader.contains("1.0 - exp(-metric)"));
        assert!(shader.contains("frame.fogProfile.y"));
        assert!(shader.contains("frame.fogProfile.z"));
        assert!(shader.contains("step_count"));
        assert!(shader.contains("let sample_height = frame.eye.y + ray.y * sample_distance"));
        assert!(shader.contains("exp(-max(sample_height, 0.0) / frame.fogProfile.y)"));
        assert!(shader.contains("let step_transmittance = exp(-density * step_distance)"));
        // F4 色彩分级后 tonemap 调用点同步（雾变体同合同：雾在 ACES 之前）。
        assert!(
            shader.find("let hdr = fogged_hdr").unwrap()
                < shader.find("aces(author_grading_apply(hdr.rgb))").unwrap()
        );
    }
    assert!(bloom_fog.contains("mix(hdr.rgb + glow, frame.tuning.rgb, amount)"));
}

#[test]
fn clustered_lighting_shader_consumes_the_resident_tile_plan() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mesh = fs::read_to_string(root.join("assets/shaders/native_mesh_v1.wgsl")).unwrap();
    assert!(mesh.contains("@binding(12) var<storage, read> cluster_grid"));
    assert!(mesh.contains("cluster_valid"));
    assert!(mesh.contains("tile_x = min(u32(clamp(ndc.x * 0.5 + 0.5"));
    assert!(mesh.contains("tile_y = min(u32(clamp(0.5 - ndc.y * 0.5"));
    assert!(mesh.contains("cluster_grid[tile_base + 1u + slot]"));
}

#[test]
fn resize_prepares_every_binding_before_publishing_the_candidate() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let renderer = fs::read_to_string(root.join("src/renderer/mod.rs")).unwrap();
    let prepare_forward = renderer.find("let mut next_forward").unwrap();
    let prepare_bloom = renderer.find("let next_bloom").unwrap();
    let prepare_output = renderer.find("let next_output").unwrap();
    let publish_forward = renderer
        .find("self.forward_targets = next_forward")
        .unwrap();
    let publish_bloom = renderer.find("bloom.publish_resize(targets)").unwrap();
    let publish_output = renderer
        .find("self.output_pass.publish_rebind(next_output)")
        .unwrap();
    assert!(prepare_forward < prepare_bloom && prepare_bloom < prepare_output);
    assert!(prepare_output < publish_forward && publish_forward < publish_bloom);
    assert!(publish_bloom < publish_output);
}
