//! Gate D evidence assembly; GPU creation/readback stay in the original integration test.
use super::{gpu, render, rgba};
use winit::dpi::PhysicalSize;

/// Real OutputPass on the shared HDR swatches; scene/depth/shadow remain separate gates.
#[test]
#[ignore = "requires hardware GPU; run explicitly with --ignored"]
fn j3_gate_d_shared_output_dump() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../deep-engine/fixtures/display-parity-v1.json"
    ))
    .unwrap();
    let width = fixture["width"].as_u64().unwrap() as u32;
    let height = fixture["height"].as_u64().unwrap() as u32;
    let colors = fixture["colors"].as_array().unwrap();
    let (device, queue, errors) = gpu();
    let mut frames = Vec::new();
    for _ in 0..2 {
        let swatches: Vec<Vec<u8>> = colors
            .iter()
            .map(|color| {
                render(
                    &device,
                    &queue,
                    PhysicalSize::new(width, height),
                    false,
                    wgpu::TextureFormat::Rgba8Unorm,
                    rgba(
                        color[0].as_f64().unwrap(),
                        color[1].as_f64().unwrap(),
                        color[2].as_f64().unwrap(),
                        1.0,
                    ),
                    None,
                )
            })
            .collect();
        let mut frame = Vec::with_capacity((width * height * 4) as usize);
        for _y in 0..height {
            for x in 0..width {
                frame.extend_from_slice(&swatches[x as usize * colors.len() / width as usize][..4]);
            }
        }
        frames.push(frame);
    }
    assert_eq!(frames[0], frames[1], "native repeats must be byte-stable");
    assert!(
        errors.lock().unwrap().is_empty(),
        "{:?}",
        errors.lock().unwrap()
    );
    let evidence = serde_json::json!({"schema":"deep-engine.j3-output-native", "width":width,
        "height":height, "frames":frames, "gpuErrors":0, "scope":"production-output-common-subset", "fixture":fixture,
        "shaderSource":include_str!("../../assets/shaders/native_output_v1.wgsl")});
    let path = std::env::var("J3_NATIVE_OUTPUT_PATH")
        .expect("J3_NATIVE_OUTPUT_PATH required for paired evidence");
    std::fs::write(path, serde_json::to_vec(&evidence).unwrap()).unwrap();
}
