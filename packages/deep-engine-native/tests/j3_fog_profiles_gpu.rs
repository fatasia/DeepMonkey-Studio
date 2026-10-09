#[path = "../src/half_float.rs"]
mod half_float;
use deep_engine_native::shader_package::hash;
#[path = "../src/output_pass.rs"]
mod output_pass;
use deep_engine_native::{
    fog::FogSettings,
    half_decode::half_to_f32,
    mesh_abi::{
        FORWARD_COLOR_FORMAT, FORWARD_DEPTH_FORMAT, FORWARD_SAMPLE_COUNT, frame_uniform_with_fog,
    },
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use wgpu::util::DeviceExt;
const FIXTURE: &str = include_str!("../../deep-engine/fixtures/j3-fog-profiles-v1.json");

#[test]
#[ignore = "actual legal Native OutputPass Fog mode/height/HG full texture matrix"]
fn j3_gate_d_actual_fog_profiles() {
    pollster::block_on(async {
        let f: Value = serde_json::from_str(FIXTURE).unwrap();
        let width = f["width"].as_u64().unwrap() as u32;
        let height = f["height"].as_u64().unwrap() as u32;
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
        let extent = wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        };
        let source = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Fog fixed HDR"),
            size: extent,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: FORWARD_COLOR_FORMAT,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let bits = (0..height)
            .flat_map(|_| {
                (0..width).flat_map(|x| {
                    [
                        f["source"][0].as_f64().unwrap() as f32,
                        f["source"][1].as_f64().unwrap() as f32,
                        f["source"][2].as_f64().unwrap() as f32,
                        [0.0, 0.25, 0.5, 1.0][x as usize % 4],
                    ]
                    .map(half_float::f32_to_f16)
                })
            })
            .collect::<Vec<_>>();
        queue.write_texture(
            source.as_image_copy(),
            bytemuck::cast_slice(&bits),
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 8),
                rows_per_image: Some(height),
            },
            extent,
        );
        let input_hash = hash::sha256(
            bits.iter()
                .map(u16::to_string)
                .collect::<Vec<_>>()
                .join(",")
                .as_bytes(),
        );
        let depth = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Fog actual 4xMSAA depth"),
            size: extent,
            mip_level_count: 1,
            sample_count: FORWARD_SAMPLE_COUNT,
            dimension: wgpu::TextureDimension::D2,
            format: FORWARD_DEPTH_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let depth_view = depth.create_view(&Default::default());
        let source_view = source.create_view(&Default::default());
        let mut frames = vec![];
        for p in f["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .chain(f["nativeOnly"].as_array().unwrap())
        {
            let density = p["density"].as_f64().unwrap() as f32;
            let color = std::array::from_fn(|i| f["color"][i].as_f64().unwrap() as f32);
            let fog = if p["exponential"].as_bool().unwrap_or(false) {
                FogSettings::exponential(density, color).unwrap()
            } else {
                FogSettings::volumetric_with_profile(
                    density,
                    color,
                    p["steps"].as_u64().unwrap() as u32,
                    p["height"].as_f64().unwrap() as f32,
                    p["g"].as_f64().unwrap() as f32,
                )
                .unwrap()
            };
            let near = f["near"].as_f64().unwrap() as f32;
            let far = f["far"].as_f64().unwrap() as f32;
            let distance = f["geometryDepth"].as_f64().unwrap() as f32;
            let raw_depth = if p["sky"].as_bool().unwrap() {
                1.0
            } else {
                far / (far - near) - near * far / ((far - near) * distance)
            };
            for eye_y in f["nativeEyeY"].as_array().unwrap() {
                let eye_y = eye_y.as_f64().unwrap() as f32;
                let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
                let mut frame = frame_uniform_with_fog(width as f32 / height as f32, 0.0, fog);
                frame[8][1] = eye_y;
                frame[3][1] = -frame[1][1] * eye_y;
                frame[11][..3].copy_from_slice(&std::array::from_fn::<_, 3, _>(|i| {
                    f["light"][i].as_f64().unwrap() as f32
                }));
                assert_eq!(frame[1][1], f["focal"].as_f64().unwrap() as f32);
                assert_eq!(frame[143][0], near);
                assert_eq!(frame[143][1], far);
                let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Fog actual frame"),
                    contents: bytemuck::cast_slice(&frame),
                    usage: wgpu::BufferUsages::UNIFORM,
                });
                let output = device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("Fog actual display"),
                    size: extent,
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: FORWARD_COLOR_FORMAT,
                    usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
                    view_formats: &[],
                });
                let pass = output_pass::OutputPass::new(
                    &device,
                    FORWARD_COLOR_FORMAT,
                    &source_view,
                    None,
                    fog.requires_output_pass()
                        .then_some((&depth_view, &uniform)),
                    None,
                );
                assert_eq!(pass.uses_fog(), density > 0.0);
                assert!(!pass.uses_bloom());
                for round in 0..2 {
                    let read = device.create_buffer(&wgpu::BufferDescriptor {
                        label: None,
                        size: u64::from(width * height * 8),
                        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                        mapped_at_creation: false,
                    });
                    let mut encoder = device.create_command_encoder(&Default::default());
                    {
                        let _clear = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                            label: Some("Fog fixed depth producer"),
                            color_attachments: &[],
                            depth_stencil_attachment: Some(
                                wgpu::RenderPassDepthStencilAttachment {
                                    view: &depth_view,
                                    depth_ops: Some(wgpu::Operations {
                                        load: wgpu::LoadOp::Clear(raw_depth),
                                        store: wgpu::StoreOp::Store,
                                    }),
                                    stencil_ops: None,
                                },
                            ),
                            ..Default::default()
                        });
                    }
                    pass.draw(&mut encoder, &output.create_view(&Default::default()));
                    encoder.copy_texture_to_buffer(
                        output.as_image_copy(),
                        wgpu::TexelCopyBufferInfo {
                            buffer: &read,
                            layout: wgpu::TexelCopyBufferLayout {
                                offset: 0,
                                bytes_per_row: Some(width * 8),
                                rows_per_image: Some(height),
                            },
                        },
                        extent,
                    );
                    queue.submit([encoder.finish()]);
                    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
                    read.map_async(wgpu::MapMode::Read, .., move |result| {
                        sender.send(result).unwrap()
                    });
                    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
                    receiver.recv().unwrap().unwrap();
                    let bytes = read.get_mapped_range(..).unwrap();
                    let lanes = bytes
                        .chunks_exact(2)
                        .map(|p| u16::from_le_bytes([p[0], p[1]]))
                        .collect::<Vec<_>>();
                    let pixels = lanes.iter().copied().map(half_to_f32).collect::<Vec<_>>();
                    frames.push(json!({"id":p["id"],"eyeY":eye_y,"round":round,"width":width,"height":height,"inputHash":input_hash,"frame":frame.iter().map(|v|v.to_vec()).collect::<Vec<_>>(),
                    "rawDepth":raw_depth,"pixels":pixels,"rgbaHash":hash::sha256(lanes.iter().map(u16::to_string).collect::<Vec<_>>().join(",").as_bytes())}));
                    drop(bytes);
                    read.unmap();
                    read.destroy();
                }
                assert!(scope.pop().await.is_none());
            }
        }
        let errors = errors.lock().unwrap().clone();
        assert!(errors.is_empty());
        let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test-output/interrupted-0930/fog-profiles");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(out.join("native.json"),serde_json::to_vec(&json!({"passed":true,"profile":"native-world-height-relative-HG-output","fixtureHash":hash::sha256(FIXTURE.as_bytes()),"inputHash":input_hash,
        "sourceHash":hash::sha256(format!("{}\n{}",output_pass::output_shader(false,false),output_pass::output_shader(false,true)).as_bytes()),"frames":frames,"errors":errors})).unwrap()).unwrap();
    });
}
