use crate::{lod_draw_renderer::render, parse_and_validate_runtime_package};

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn author_selected_main_and_all_cascades_match_explicit_geometry_draws() {
    pollster::block_on(async {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions::default())
            .await
            .unwrap();
        println!("author-selected adapter: {:?}", adapter.get_info());
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .unwrap();
        let loaded = parse_and_validate_runtime_package(include_bytes!(
            "../fixtures/runtime-package-author-lod-v1.json"
        ))
        .unwrap();
        let mut packet = loaded.render_packet;
        let authored = render(&device, &queue, &packet, &loaded.environment).await;
        let prepared = deep_engine_native::scene::prepare_scene(&packet).unwrap();
        let plan = deep_engine_native::lod_contract::prepare_gpu_lod(&packet, &prepared).unwrap();
        for (batch, draws) in prepared.batches.iter().zip(&plan.batches) {
            let id = &prepared.instance_ids[batch.instance_start as usize];
            let source = packet.instances.iter().find(|i| &i.id == id).unwrap();
            let author = source.lod.as_ref().unwrap().author.as_ref().unwrap();
            for (index, draw) in draws.iter().enumerate() {
                for (view, commands) in authored.commands.iter().enumerate() {
                    let count = commands[draw.indirect_index as usize][1];
                    if !author.selected_levels.contains(&index) {
                        assert_eq!(count, 0);
                    }
                    if view == 0 {
                        assert_eq!(count, u32::from(author.selected_levels.contains(&index)));
                    }
                    if view > 0
                        && batch.alpha_mode == deep_engine_native::contract::AlphaMode::Blend
                    {
                        assert_eq!(count, 0);
                    }
                }
            }
        }
        packet.instances = packet
            .instances
            .iter()
            .flat_map(|i| {
                let profile = i.lod.as_ref().unwrap();
                profile
                    .author
                    .as_ref()
                    .unwrap()
                    .selected_levels
                    .iter()
                    .map(|&level| {
                        let mut direct = i.clone();
                        direct.id = format!("{}.direct.{level}", i.id);
                        direct.geometry = profile.levels[level].geometry.clone();
                        direct.lod = None;
                        direct
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        let direct = render(&device, &queue, &packet, &loaded.environment).await;
        assert_eq!(
            authored.hdr, direct.hdr,
            "authored selected color differs from explicit geometry"
        );
        assert_eq!(
            authored.depths, direct.depths,
            "authored CSM differs from explicit geometry"
        );
        assert!(authored.depths.iter().any(|&d| d < 1.0));
        println!("author-selected zero/single/multi GPU main+4 CSM exact color/depth passed");
    });
}
