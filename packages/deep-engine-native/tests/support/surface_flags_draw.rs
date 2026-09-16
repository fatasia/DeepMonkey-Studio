use crate::lod_draw_renderer::render;
use deep_engine_native::{
    contract::ShadingModel, runtime_package::parse_and_validate_runtime_package,
};

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn surface_flags_preserve_main_coverage_and_control_real_cascade_depth() {
    pollster::block_on(async {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                ..Default::default()
            })
            .await
            .unwrap();
        println!("Surface flags adapter: {:?}", adapter.get_info());
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .unwrap();
        let loaded = parse_and_validate_runtime_package(include_bytes!(
            "../fixtures/runtime-package-lod-v1.json"
        ))
        .unwrap();
        let mut packet = loaded.render_packet;
        for material in &mut packet.materials {
            material.shading_model = Some(ShadingModel::Unlit);
            material.base_color = [0.25, 0.5, 0.75];
        }
        let unlit = render(&device, &queue, &packet, &loaded.environment).await;
        let expected: Vec<u8> = [0.25, 0.5, 0.75, 1.0]
            .into_iter()
            .flat_map(|value| crate::half_float::f32_to_f16(value).to_le_bytes())
            .collect();
        assert!(
            unlit
                .hdr
                .chunks_exact(8)
                .filter(|pixel| *pixel == expected.as_slice())
                .count()
                > 100,
            "unlit interior pixels must match linear base-color golden"
        );
        assert!(unlit.depths.iter().any(|depth| *depth < 1.0));
        for instance in &mut packet.instances {
            instance.cast_shadow = Some(false);
        }
        let no_cast = render(&device, &queue, &packet, &loaded.environment).await;
        assert!(
            unlit.hdr == no_cast.hdr,
            "unlit color must ignore cast-induced lighting changes"
        );
        assert!(
            no_cast.depths.iter().all(|depth| *depth == 1.0),
            "disabled casters must leave every cascade clear"
        );
        assert!(
            no_cast
                .commands
                .iter()
                .skip(1)
                .flatten()
                .all(|command| command[1] == 0)
        );
        assert!(
            no_cast.commands[0].iter().any(|command| command[1] > 0),
            "noncasters remain in main view"
        );
        for material in &mut packet.materials {
            material.metallic = 1.0;
            material.roughness = 0.045;
            material.emissive_factor = Some([8.0, 2.0, 4.0]);
        }
        let modified_lighting = render(&device, &queue, &packet, &loaded.environment).await;
        assert!(
            unlit.hdr == modified_lighting.hdr,
            "unlit must ignore metal, roughness and emission"
        );
        for instance in &mut packet.instances {
            instance.lod = None;
        }
        let direct = render(&device, &queue, &packet, &loaded.environment).await;
        assert!(
            direct.depths.iter().all(|depth| *depth == 1.0),
            "non-LOD noncasters also leave all cascades clear"
        );
        assert!(direct.hdr.chunks_exact(8).any(|pixel| pixel != [0; 8]));
    });
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn receive_shadow_changes_color_without_changing_any_caster_depth() {
    pollster::block_on(async {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions::default())
            .await
            .unwrap();
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .unwrap();
        let loaded = parse_and_validate_runtime_package(include_bytes!(
            "../fixtures/runtime-package-lod-v1.json"
        ))
        .unwrap();
        let mut packet = serde_json::from_str::<deep_engine_native::contract::RenderPacket>(
            include_str!("../../fixtures/render_packet_shadow_v1.json"),
        )
        .unwrap();
        let lit = render(&device, &queue, &packet, &loaded.environment).await;
        for instance in &mut packet.instances {
            instance.receive_shadow = Some(false);
        }
        let no_receive = render(&device, &queue, &packet, &loaded.environment).await;
        assert!(lit.depths == no_receive.depths);
        assert_eq!(lit.commands, no_receive.commands);
        let changed = lit
            .hdr
            .chunks_exact(8)
            .zip(no_receive.hdr.chunks_exact(8))
            .filter(|(a, b)| a != b)
            .count();
        assert!(
            changed > 10,
            "receivers must become visibly unshadowed: {changed} pixels"
        );
        println!("receiveShadow changed {changed} pixels; four cascade depths unchanged");
    });
}
