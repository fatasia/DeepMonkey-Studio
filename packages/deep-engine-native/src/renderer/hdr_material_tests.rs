use super::*;
fn content_variant(index: usize) -> PlayerContent {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/runtime-package-prefiltered-ibl-v1.json"
    ))
    .unwrap();
    let ibl = fixture["payloads"][fixture["entrypoints"]["environment"].as_str().unwrap()].clone();
    let lighting = json!({"direction":[0,0,1],"radiance":[1,1,1],"exposure":1.05,"shadows":true,
        "localLights":[{"kind":"point","position":[0,3,3],"direction":[0,-1,0],"radiance":[16,8,4],"range":12,"decay":2,"innerCos":1,"outerCos":0,"castShadow":true},
        {"kind":"spot","position":[0,4,3],"direction":[0,-0.8,-0.6],"radiance":[4,8,16],"range":12,"decay":2,"innerCos":0.8,"outerCos":0.5,"castShadow":true}]});
    lit_content_environment(
        [0.03, 0.04, 0.05],
        Some(lighting),
        None,
        None,
        |packet| {
            *packet =
                serde_json::from_str(include_str!("../../fixtures/render_packet_alpha_v1.json"))
                    .unwrap();
            let mut back = packet["geometries"][0].clone();
            back["id"] = json!("back-facing-quad");
            for triangle in back["indices"].as_array_mut().unwrap().chunks_exact_mut(3) {
                triangle.swap(1, 2);
            }
            packet["geometries"].as_array_mut().unwrap().push(back);
            packet["instances"].as_array_mut().unwrap().push(json!({"id":"back-facing","geometry":"back-facing-quad","material":"alpha-mask-double","transform":[0.6,0,0,0,0,0.6,0,0,0,0,1,0,1.8,0,0,1]}));
            let materials = packet["materials"].as_array_mut().unwrap();
            for material in materials.iter_mut() {
                match index {
                    2 => {
                        material["normalTexture"]["normalScale"] = json!(0);
                    }
                    3 => {
                        material["metallic"] = json!(0);
                        material["roughness"] = json!(1);
                    }
                    4 => {
                        if material["alphaMode"] == "MASK" {
                            material["alphaCutoff"] = json!(1);
                        }
                    }
                    5 => {
                        material["doubleSided"] = json!(false);
                    }
                    _ => {}
                }
            }
            for instance in packet["instances"].as_array_mut().unwrap() {
                instance["receiveShadow"] = json!(index != 6);
                instance["castShadow"] = json!(index != 7);
            }
            packet["materials"].as_array_mut().unwrap().push(
                json!({"id":"receiver","baseColor":[0.7,0.7,0.7],"metallic":0,"roughness":1}),
            );
            packet["instances"].as_array_mut().unwrap().push(json!({"id":"receiver","geometry":"textured-quad","material":"receiver","castShadow":false,"receiveShadow":index!=6,"transform":[4,0,0,0,0,4,0,0,0,0,1,0,0,0,-1,1]}));
        },
        if index == 1 { None } else { Some(ibl) },
    )
}
pub(super) fn verify(window: Arc<Window>, proxy: EventLoopProxy<GpuEvent>) {
    let mut frames = Vec::new();
    for index in 0..8 {
        let content = content_variant(index);
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
            200 + index as u64,
            &content,
            content.initial_view(),
            features,
        ))
        .unwrap();
        renderer.activate_surface();
        present(&mut renderer);
        frames.push(directional_tests::read_pixels(&renderer));
        assert!(frames[index].iter().all(|v| v.is_finite()));
        if index == 0 {
            let dark = content_variant(1);
            renderer.resize(PhysicalSize::new(0, 0)).unwrap();
            assert!(pollster::block_on(renderer.replace_dropped_package(&content, &dark)).is_err());
            assert!(directional_tests::read_pixels(&renderer) == frames[0]);
            renderer.resize(PhysicalSize::new(640, 480)).unwrap();
            present(&mut renderer);
            pollster::block_on(renderer.replace_dropped_package(&content, &dark)).unwrap();
            present(&mut renderer);
            let without = directional_tests::read_pixels(&renderer);
            assert!(
                without
                    .iter()
                    .zip(&frames[0])
                    .filter(|(a, b)| (*a - *b).abs() > 1e-4)
                    .count()
                    > 100
            );
        }
    }
    let changes: Vec<usize> = (1..8)
        .map(|index| {
            frames[0]
                .iter()
                .zip(&frames[index])
                .filter(|(a, b)| (*a - *b).abs() > 1e-4)
                .count()
        })
        .collect();
    assert!(
        changes.iter().all(|count| *count > 10),
        "HDR, normal, metal/roughness, mask, double-sided, receive/cast combinations: {changes:?}"
    );
    println!("HDR/material/shadow pixel differences: {changes:?}");
}
