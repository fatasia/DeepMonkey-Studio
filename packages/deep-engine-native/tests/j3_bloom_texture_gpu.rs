#[path = "../src/bloom_pass.rs"]
mod bloom_pass;
#[path = "../src/bloom_pipeline.rs"]
mod bloom_pipeline;
#[path = "../src/half_float.rs"]
mod half_float;
#[path = "../src/shader_package/hash.rs"]
mod hash;
#[path = "../src/output_pass.rs"]
mod output_pass;

use bloom_pass::BloomPass;
use deep_engine_native::{
    bloom::BloomSettings, half_decode::half_to_f32, mesh_abi::FORWARD_COLOR_FORMAT,
};
use output_pass::OutputPass;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use winit::dpi::PhysicalSize;
const FIXTURE: &str = include_str!("../../deep-engine/fixtures/j3-bloom-texture-v1.json");

fn input_pixel(id: &str, x: u32, y: u32, width: u32, height: u32) -> [f32; 4] {
    let rgb = match id {
        "uniform" => [4., 2., 1.],
        "center-spot"
            if x >= width / 2 - 2
                && x < width / 2 + 2
                && y >= height / 2 - 2
                && y < height / 2 + 2 =>
        {
            [16., 8., 4.]
        }
        "edge-spot" if x < 4 && y < 4 => [16., 8., 4.],
        "center-spot" | "edge-spot" => [0.; 3],
        "gradient" => [
            x as f32 / (width - 1) as f32 * 4.,
            y as f32 / (height - 1) as f32 * 2.,
            (x + y) as f32 / (width + height - 2) as f32,
        ],
        "signed-checker" if (x + y) % 2 == 0 => [4., -2., 1.],
        "signed-checker" => [-4., 2., -1.],
        "threshold-stripes" => match x % 4 {
            0 => [0.75, 0.5, 0.25],
            1 => [1., 1., 0.5],
            2 => [1.25, 1., 0.75],
            _ => [1.5, 1.25, 1.],
        },
        _ => panic!("Unknown frozen Bloom input"),
    };
    [rgb[0], rgb[1], rgb[2], [0., 0.25, 0.5, 1.][x as usize % 4]]
}
fn texture(
    device: &wgpu::Device,
    width: u32,
    height: u32,
    usage: wgpu::TextureUsages,
) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("J3 Bloom actual texture"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORWARD_COLOR_FORMAT,
        usage,
        view_formats: &[],
    })
}
async fn read_texture(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    texture: &wgpu::Texture,
) -> (Vec<f32>, String) {
    let width = texture.width();
    let height = texture.height();
    let row_bytes = (width * 8).div_ceil(256) * 256;
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: u64::from(row_bytes * height),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(row_bytes),
                rows_per_image: Some(height),
            },
        },
        texture.size(),
    );
    queue.submit([encoder.finish()]);
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    buffer.map_async(wgpu::MapMode::Read, .., move |result| {
        sender.send(result).unwrap()
    });
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    receiver.recv().unwrap().unwrap();
    let bytes = buffer.get_mapped_range(..).unwrap();
    let mut bits = vec![];
    for y in 0..height {
        for x in 0..width * 4 {
            let at = (y * row_bytes + x * 2) as usize;
            bits.push(u16::from_le_bytes([bytes[at], bytes[at + 1]]));
        }
    }
    let pixels = bits.iter().copied().map(half_to_f32).collect();
    let digest = hash::sha256(
        bits.iter()
            .map(u16::to_string)
            .collect::<Vec<_>>()
            .join(",")
            .as_bytes(),
    );
    drop(bytes);
    buffer.unmap();
    buffer.destroy();
    (pixels, digest)
}
#[test]
#[ignore = "actual Native BloomPass and public OutputPass full texture observations"]
fn j3_gate_d_actual_bloom_textures() {
    pollster::block_on(async {
        let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
        let width = fixture["width"].as_u64().unwrap() as u32;
        let height = fixture["height"].as_u64().unwrap() as u32;
        let settings = BloomSettings::default();
        for (key, value) in [
            ("threshold", settings.threshold),
            ("softKnee", settings.soft_knee),
            ("intensity", settings.intensity),
            ("radius", settings.radius),
        ] {
            assert_eq!(
                value,
                fixture["native"][key].as_f64().unwrap() as f32,
                "Native production default {key} changed"
            );
        }
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(matches!(
            adapter.get_info().device_type,
            wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu
        ));
        let (device, queue) = adapter.request_device(&Default::default()).await.unwrap();
        let errors = Arc::new(Mutex::new(vec![]));
        let recorded = errors.clone();
        device.on_uncaptured_error(Arc::new(move |error| {
            recorded.lock().unwrap().push(error.to_string())
        }));
        let mut frames = vec![];
        for id in fixture["cases"].as_array().unwrap() {
            let id = id.as_str().unwrap();
            let scopes = [
                wgpu::ErrorFilter::Validation,
                wgpu::ErrorFilter::OutOfMemory,
                wgpu::ErrorFilter::Internal,
            ]
            .map(|filter| device.push_error_scope(filter));
            let bits = (0..height)
                .flat_map(|y| {
                    (0..width).flat_map(move |x| {
                        input_pixel(id, x, y, width, height).map(half_float::f32_to_f16)
                    })
                })
                .collect::<Vec<_>>();
            let input_hash = hash::sha256(
                bits.iter()
                    .map(u16::to_string)
                    .collect::<Vec<_>>()
                    .join(",")
                    .as_bytes(),
            );
            let source = texture(
                &device,
                width,
                height,
                wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            );
            queue.write_texture(
                source.as_image_copy(),
                bytemuck::cast_slice(&bits),
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(width * 8),
                    rows_per_image: Some(height),
                },
                source.size(),
            );
            let source_view = source.create_view(&Default::default());
            let bloom = BloomPass::new(
                &device,
                &source_view,
                PhysicalSize::new(width, height),
                settings,
            )
            .unwrap()
            .unwrap();
            let output = texture(
                &device,
                width,
                height,
                wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            );
            let output_view = output.create_view(&Default::default());
            let pass = OutputPass::new(
                &device,
                FORWARD_COLOR_FORMAT,
                &source_view,
                Some((bloom.output_view(), settings.intensity)),
                None,
                None,
            );
            assert!(pass.uses_bloom());
            assert!(!pass.uses_fog());
            for round in 0..2 {
                let mut encoder = device.create_command_encoder(&Default::default());
                bloom.encode(&mut encoder);
                pass.draw(&mut encoder, &output_view);
                queue.submit([encoder.finish()]);
                let (blurred, blurred_hash) =
                    read_texture(&device, &queue, bloom.output_texture()).await;
                let (display, display_hash) = read_texture(&device, &queue, &output).await;
                frames.push(json!({"id":id,"round":round,"inputHash":input_hash,"width":width,"height":height,
                "blurredWidth":bloom.output_texture().width(),"blurredHeight":bloom.output_texture().height(),
                "blurred":blurred,"display":display,"blurredHash":blurred_hash,"displayHash":display_hash}));
            }
            for scope in scopes.into_iter().rev() {
                assert!(scope.pop().await.is_none(), "Actual Bloom GPU scope failed");
            }
        }
        let errors = errors.lock().unwrap().clone();
        assert!(errors.is_empty());
        let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test-output/interrupted-0930/bloom-texture");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(out.join("native.json"),serde_json::to_vec(&json!({"passed":true,"profile":"native-production-default-blurred-and-display-aces-srgb",
        "fixtureHash":hash::sha256(FIXTURE.as_bytes()),"sourceHash":hash::sha256(format!("{}\n{}",bloom_pass::bloom_shader(),output_pass::output_shader(true,false)).as_bytes()),
        "frames":frames,"errors":errors})).unwrap()).unwrap();
    });
}
