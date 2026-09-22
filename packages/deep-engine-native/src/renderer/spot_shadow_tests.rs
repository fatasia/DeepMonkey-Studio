use super::*;

pub(super) fn verify(window: Arc<Window>, proxy: EventLoopProxy<GpuEvent>) {
    verify_kind(window, proxy, "spot");
}
pub(super) fn verify_point(window: Arc<Window>, proxy: EventLoopProxy<GpuEvent>) {
    verify_kind(window, proxy, "point");
}
fn verify_kind(window: Arc<Window>, proxy: EventLoopProxy<GpuEvent>, kind: &str) {
    let mut frames = Vec::new();
    let mut cases = vec![
        (false, true, 0.0),
        (true, true, 0.0),
        (true, false, 0.0),
        (true, true, 2.0),
        (false, true, 2.0),
        (true, true, 0.0),
        (true, true, 0.0),
    ];
    if kind == "spot" {
        cases.extend([(true, true, 0.0), (true, true, 0.0), (true, false, 0.0)]);
    }
    for (index, (cast, receive, x)) in cases.into_iter().enumerate() {
        let mut local = json!({"kind":kind,"position":[x,4,3],"direction":[0,-0.8,-0.6],"radiance":[16,16,16],"range":12,"decay":2,"innerCos":0.8,"outerCos":0.5});
        if cast {
            local["castShadow"] = json!(true);
        }
        if index >= 7 {
            local["shadowSoftness"] = json!(if index == 7 { 0.0 } else { 1.0 });
        }
        let locals = if index == 6 {
            let mut spot = local.clone();
            spot["kind"] = json!("spot");
            let mut values = vec![spot; 4];
            if kind == "point" {
                values.push(local);
            }
            values
        } else {
            vec![local]
        };
        let mut content = lit_content_flags(
            [0.0; 3],
            Some(
                json!({"direction":[0,1,0],"radiance":[0,0,0],"exposure":1.05,"shadows":false,"localLights":locals}),
            ),
            Some(receive),
            if index == 5 { Some(false) } else { None },
        );
        let features = RendererFeatures {
            bloom: entry_bloom(&content),
            fog: FogSettings::DISABLED,
            shadow_probe: false,
            ibl_probe: false,
            telemetry: false,
        };
        let mut renderer = pollster::block_on(Renderer::new_candidate(
            window.clone(),
            proxy.clone(),
            120 + index as u64,
            &content,
            content.initial_view(),
            features,
        ))
        .unwrap();
        renderer.activate_surface();
        present(&mut renderer);
        frames.push(directional_tests::read_pixels(&renderer));
        if kind == "spot" && index == 1 {
            let reference = renderer.shadow_casters.clone();
            reference.clear_view_key_cache_for_test();
            assert_eq!(
                renderer.shadow_keys,
                reference
                    .keys(&renderer.shadow_map, renderer.shadow_shader_key)
                    .unwrap()
            );
            renderer.shadow_cache.invalidate();
            present(&mut renderer);
            assert_eq!(
                frames[index],
                directional_tests::read_pixels(&renderer),
                "full shadow refresh and retained keys must match pixels"
            );
            let previous = content.packet().clone();
            let previous_keys = renderer.shadow_keys.clone();
            content.mutate_packet_for_test(|packet| {
                packet.instances.last_mut().unwrap().transform[12] += 0.5
            });
            let staged =
                pollster::block_on(renderer.stage_render_packet_update(&previous, &content))
                    .unwrap();
            let metrics = renderer.publish_render_packet_update(staged).unwrap();
            assert_eq!(
                (
                    metrics.geometry_uploads,
                    metrics.texture_uploads,
                    metrics.material_uploads
                ),
                (0, 0, 0)
            );
            assert_ne!(
                renderer.shadow_keys, previous_keys,
                "moving caster must refresh shadow fingerprints"
            );
            present(&mut renderer);
            assert_ne!(
                frames[index],
                directional_tests::read_pixels(&renderer),
                "moving geometry must change actual pixels"
            );
            let moved = content.packet().clone();
            content.mutate_packet_for_test(|packet| *packet = previous.clone());
            let staged =
                pollster::block_on(renderer.stage_render_packet_update(&moved, &content)).unwrap();
            renderer.publish_render_packet_update(staged).unwrap();
            present(&mut renderer);
            assert_eq!(
                frames[index],
                directional_tests::read_pixels(&renderer),
                "undo must restore exact shadow pixels"
            );
        }
        if index == 1 {
            renderer.resize(PhysicalSize::new(0, 0)).unwrap();
            assert!(matches!(
                renderer.render_internal(true, true),
                RenderOutcome::Skipped
            ));
            let retained = directional_tests::read_pixels(&renderer);
            assert!(
                retained == frames[index],
                "skipped shadow frame must preserve last pixels"
            );
            renderer.resize(PhysicalSize::new(640, 480)).unwrap();
            present(&mut renderer);
        }
        assert_eq!(
            renderer.shadow_map.layer_views.len(),
            if index == 6 {
                if kind == "point" { 14 } else { 8 }
            } else if cast {
                if kind == "point" { 10 } else { 5 }
            } else {
                4
            }
        );
        let matrices = deep_engine_native::local_shadow::frame_matrices(&renderer.frame);
        let mut view = content.initial_view();
        view.yaw += 0.3;
        renderer.set_view(view);
        renderer.resize(PhysicalSize::new(704, 512)).unwrap();
        assert_eq!(
            renderer.shadow_cache.plan(&renderer.shadow_keys).dirty_mask & 0x3ff0,
            0,
            "camera-only change must reuse local depth layers"
        );
        present(&mut renderer);
        assert_eq!(
            deep_engine_native::local_shadow::frame_matrices(&renderer.frame),
            matrices,
            "camera/resize cannot move local projection"
        );
    }
    let different = |a: usize, b: usize| {
        frames[a]
            .iter()
            .zip(&frames[b])
            .filter(|(x, y)| (*x - *y).abs() > 0.0001)
            .count()
    };
    eprintln!(
        "spot diagnostics: shadow={} bypass={} moved={}",
        different(0, 1),
        different(0, 2),
        different(1, 3)
    );
    assert!(different(0, 1) > 100, "spot shadow must occlude receiver");
    assert_eq!(
        different(0, 2),
        0,
        "receiveShadow false must bypass local shadow"
    );
    assert!(
        different(1, 3) > 100,
        "moving spot changes lit/shadow pixels"
    );
    assert!(
        different(3, 4) > 100,
        "moved light still casts a measurable shadow"
    );
    assert_eq!(
        different(0, 5),
        0,
        "castShadow false must remove local occluders"
    );
    if kind == "spot" {
        assert_eq!(
            different(1, 7),
            0,
            "explicit zero preserves old shadow pixels"
        );
        assert!(
            different(7, 8) > 100,
            "PCSS softness must change shadow pixels"
        );
        assert_eq!(different(0, 9), 0, "soft shadows honor receiveShadow false");
        println!(
            "spot PCSS pixels: softened={} legacy={} bypass={}",
            different(7, 8),
            different(1, 7),
            different(0, 9)
        );
    }
    eprintln!(
        "spot shadow pixels: shadow={} receive bypass={} moved={}",
        different(0, 1),
        different(0, 2),
        different(1, 3)
    );
}
