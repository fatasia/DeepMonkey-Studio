use super::*;

pub(super) fn verify(window: Arc<Window>, proxy: EventLoopProxy<GpuEvent>) {
    let mut frames = Vec::new();
    for (index, (kind, energy, range, direction, decay)) in [
        ("point", 0.0, 0.0, [0.0, -1.0, 0.0], 2.0),
        ("point", 16.0, 0.0, [0.0, -1.0, 0.0], 2.0),
        ("point", 16.0, 0.01, [0.0, -1.0, 0.0], 2.0),
        ("point", 16.0, 0.0, [0.0, -1.0, 0.0], 0.0),
        ("spot", 16.0, 0.0, [0.0, -1.0, 0.0], 2.0),
        ("spot", 16.0, 0.0, [0.0, 1.0, 0.0], 2.0),
    ]
    .into_iter()
    .enumerate()
    {
        let content = lit_content(
            [0.0; 3],
            Some(
                json!({"direction":[0,1,0],"radiance":[0,0,0],"exposure":1.05,"shadows":false,
            "localLights":[{"kind":kind,"position":[0,4,0],"direction":direction,"radiance":[energy,0,0],"range":range,"decay":decay,"innerCos":0.8,"outerCos":0.5}]}),
            ),
            Some(true),
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
            100 + index as u64,
            &content,
            content.initial_view(),
            features,
        ))
        .unwrap();
        renderer.activate_surface();
        present(&mut renderer);
        frames.push(directional_tests::read_pixels(&renderer));
        let local_rows = renderer.frame[15..19].to_vec();
        let mut view = content.initial_view();
        view.yaw += 0.3;
        renderer.set_view(view);
        renderer.resize(PhysicalSize::new(704, 512)).unwrap();
        present(&mut renderer);
        assert_eq!(renderer.frame[15..19], local_rows);
    }
    let different = |a: usize, b: usize| {
        frames[a]
            .iter()
            .zip(&frames[b])
            .filter(|(x, y)| (*x - *y).abs() > 0.0001)
            .count()
    };
    assert!(different(0, 1) > 100, "point light must contribute");
    assert_eq!(
        different(0, 2),
        0,
        "outside finite range must contribute zero"
    );
    assert!(different(1, 3) > 100, "authored decay must affect pixels");
    assert!(different(0, 4) > 100, "spot cone must light receivers");
    assert_eq!(
        different(0, 5),
        0,
        "reversed spot cone must contribute zero"
    );
    eprintln!(
        "local light GPU differences: point={} decay={} spot={}",
        different(0, 1),
        different(1, 3),
        different(0, 4)
    );
}
