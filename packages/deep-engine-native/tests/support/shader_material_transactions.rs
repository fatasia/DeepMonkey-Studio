use crate::{
    gpu_ibl::GpuIblEnvironment, gpu_scene::GpuScene, player_content::PlayerContent,
    shadow_map::ShadowMap,
};

pub fn verify(
    device: &wgpu::Device,
    foreign: &wgpu::Device,
    content: &PlayerContent,
    scene: &mut GpuScene,
    frame: &wgpu::Buffer,
    shadows: &ShadowMap,
    ibl: &GpuIblEnvironment,
) {
    let revision = scene.shader_revision;
    let signature = scene.shader_materials.as_ref().unwrap().signature.clone();
    let pipeline = scene
        .shader_materials
        .as_ref()
        .unwrap()
        .materials
        .iter()
        .flatten()
        .flat_map(|material| material.forward.iter().flatten())
        .next()
        .unwrap()
        .pipeline
        .clone();
    assert!(
        !scene
            .replace_shader_materials(device, content, frame, shadows, ibl)
            .unwrap()
    );
    assert_eq!(scene.shader_revision, revision);
    assert_eq!(
        &pipeline,
        &scene
            .shader_materials
            .as_ref()
            .unwrap()
            .materials
            .iter()
            .flatten()
            .flat_map(|material| material.forward.iter().flatten())
            .next()
            .unwrap()
            .pipeline
    );

    for mutation in [0usize, 1, 3] {
        let mut candidate = crate::fixture();
        let expected = match mutation {
            0 => {
                candidate.mutate_packet_for_test(|packet| packet.materials.swap(0, 1));
                "rebuild the entire scene"
            }
            1 => {
                candidate.mutate_packet_for_test(|packet| {
                    packet
                        .materials
                        .iter_mut()
                        .find(|material| material.normal_texture.is_some())
                        .unwrap()
                        .normal_texture = None;
                });
                "rebuild the entire scene"
            }
            _ => {
                candidate.material_bindings[0].technique_id = "missingTechnique".into();
                "missingTechnique"
            }
        };
        let error = scene
            .replace_shader_materials(device, &candidate, frame, shadows, ibl)
            .unwrap_err();
        assert!(error.contains(expected), "{error}");
        assert_eq!(scene.shader_revision, revision);
        assert_eq!(
            scene.shader_materials.as_ref().unwrap().signature,
            signature
        );
    }

    // Invalid WGSL is isolated per package instead of failing the whole
    // transaction (isolation slice): dependents fall back to builtin PBR and
    // the signature advances, proving the update published.
    let mut broken = crate::fixture();
    let broken_id = broken.shader_packages[0].package_id.clone();
    broken.shader_packages[0].modules[0].source.push_str(
        "
this is invalid WGSL",
    );
    assert!(
        scene
            .replace_shader_materials(device, &broken, frame, shadows, ibl)
            .unwrap()
    );
    {
        let materials = scene.shader_materials.as_ref().unwrap();
        assert_eq!(materials.isolated, vec![broken_id]);
        assert!(materials.fallback_materials >= 1);
    }

    let wrong_device = scene
        .replace_shader_materials(foreign, content, frame, shadows, ibl)
        .unwrap_err();
    assert!(
        wrong_device.contains("another GPU device"),
        "{wrong_device}"
    );

    // Valid package bytes force preparation, then an undersized candidate frame
    // fails actual GPU binding validation. Old pass objects must remain usable.
    let mut candidate = crate::fixture();
    candidate.material_bindings.reverse();
    let invalid_frame = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("invalid ShaderPackage candidate frame"),
        size: 16,
        usage: wgpu::BufferUsages::UNIFORM,
        mapped_at_creation: false,
    });
    let error = scene
        .replace_shader_materials(device, &candidate, &invalid_frame, shadows, ibl)
        .unwrap_err();
    assert!(error.contains("transaction rejected"), "{error}");
    // Re-baseline after the isolated publish above.
    let revision = scene.shader_revision;
    let signature = scene.shader_materials.as_ref().unwrap().signature.clone();
    assert_eq!(
        scene.shader_materials.as_ref().unwrap().signature,
        signature
    );
    assert!(
        scene
            .replace_shader_materials(device, &candidate, frame, shadows, ibl)
            .unwrap()
    );
    assert_eq!(scene.shader_revision, revision + 1);
    assert!(
        !scene
            .replace_shader_materials(device, &candidate, frame, shadows, ibl)
            .unwrap()
    );
}
