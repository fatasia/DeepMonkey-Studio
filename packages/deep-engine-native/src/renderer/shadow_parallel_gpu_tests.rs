//! 波次5 GPU 证据(真机 NVIDIA):Native RenderGraph 并行级联阴影编码。
//!
//! - 生产路径:render_internal(verify_submission=true)现在走
//!   「pre CB → 并行级联 CB(升序)→ 主 CB」单次提交,本测试全帧跑通,
//!   校验 GPU validation scopes/callbacks 干净。
//! - 确定性硬证据:同一场景与 culling 状态下,串行参照编码与并行编码
//!   产出的级联深度贴图**逐位一致**;带 GPU 时间戳路由的并行编码同样
//!   逐位一致。
//! - 并行编码 wall-clock 对比原样打印;≥2x 线性断言由纯 CPU 测试
//!   `render_graph_tests` 承担(编码 GPU 资源绑定的吞吐受驱动影响,
//!   不做机器相关的硬断言,如实声明)。

use super::*;
use crate::events::{GpuEvent, RenderOutcome};
use deep_engine_native::runtime_package::{
    parse_and_validate_runtime_package, runtime_content_sha256, runtime_package_sha256,
};
use serde_json::{Value, json};
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};
use winit::{
    application::ApplicationHandler,
    event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy},
    platform::windows::EventLoopBuilderExtWindows,
};

const SIZE: PhysicalSize<u32> = PhysicalSize::new(640, 480);
const TEST: &str = "renderer::shadow_parallel_gpu_tests::parallel_cascade_shadow_matches_serial_bitwise_and_production_frame_passes";

fn lit_shadow_content() -> PlayerContent {
    let mut package: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/runtime-package-v1.json")).unwrap();
    let old = package["entrypoints"]["environment"]
        .as_str()
        .unwrap()
        .to_owned();
    package["payloads"].as_object_mut().unwrap().remove(&old);
    package["entrypoints"]["environment"] = json!("scene.environment");
    let mut value = json!({"schema":"deep-engine.solid-environment","schemaVersion":1,"id":"scene.environment","revision":1,
        "kind":"solid-background-no-ibl","backgroundSrgb":[0.0,0.0,0.0],"outputTransform":"native-aces-v1"});
    let lighting =
        json!({"direction":[0.0,0.6,0.8],"radiance":[4.0,0.0,0.0],"exposure":1.05,"shadows":true});
    value["schemaVersion"] = json!(2);
    value["outputTransform"] = json!("native-aces-light-v2");
    value["lighting"] = lighting;
    for instance in package["payloads"]["scene.main"]["instances"]
        .as_array_mut()
        .unwrap()
    {
        instance["receiveShadow"] = json!(true);
        instance["castShadow"] = json!(true);
    }
    let hash = runtime_content_sha256(&package["payloads"]["scene.main"]);
    for resource in package["resources"].as_array_mut().unwrap() {
        if resource["id"] == "scene.main" {
            resource["contentHash"]["value"] = json!(hash);
        }
    }
    let hash = runtime_content_sha256(&value);
    package["payloads"]["scene.environment"] = value;
    for resource in package["resources"].as_array_mut().unwrap() {
        if resource["id"] == old {
            resource["id"] = json!("scene.environment");
            resource["contentHash"]["value"] = json!(hash);
        }
    }
    package["resources"]
        .as_array_mut()
        .unwrap()
        .sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    package["packageHash"]["value"] = json!(runtime_package_sha256(&package).unwrap());
    PlayerContent::from_package(
        parse_and_validate_runtime_package(&serde_json::to_vec(&package).unwrap()).unwrap(),
    )
    .unwrap()
}

#[test]
#[ignore = "requires a real NVIDIA GPU; parallel cascade shadow bitwise determinism"]
fn parallel_cascade_shadow_matches_serial_bitwise_and_production_frame_passes() {
    const CHILD: &str = "DEEP_SHADOW_PARALLEL_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--ignored", "--nocapture"])
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        println!("{}", String::from_utf8_lossy(&result.stdout));
        return;
    }
    let mut builder = EventLoop::<GpuEvent>::with_user_event();
    builder.with_any_thread(true);
    let event_loop = builder.build().unwrap();
    let mut probe = Probe {
        proxy: event_loop.create_proxy(),
        verified: false,
    };
    event_loop.run_app(&mut probe).unwrap();
    assert!(probe.verified);
}

struct Probe {
    proxy: EventLoopProxy<GpuEvent>,
    verified: bool,
}

impl ApplicationHandler<GpuEvent> for Probe {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        let window = Arc::new(
            event_loop
                .create_window(crate::app_startup::window_attributes(false).with_inner_size(SIZE))
                .unwrap(),
        );
        let content = lit_shadow_content();
        // telemetry 打开:生产帧的并行路径会经过「Frame 起点时间戳延迟/
        // 首个级联 CB 携带 + Shadow 段时间戳写进级联 CB」的路由。
        let features = RendererFeatures {
            bloom: entry_bloom(&content),
            fog: FogSettings::DISABLED,
            shadow_probe: false,
            ibl_probe: false,
            telemetry: true,
        };
        let mut renderer = pollster::block_on(Renderer::new_candidate(
            window,
            self.proxy.clone(),
            180,
            &content,
            content.initial_view(),
            features,
        ))
        .unwrap();
        renderer.activate_surface();
        present(&mut renderer);
        println!("production frame with parallel cascade shadow: GPU scopes clean");

        let cascade_count = renderer.shadow_map.layer_views.len();
        assert!(cascade_count >= 2, "fixture must drive multiple cascades");
        let dirty_mask: u16 = (u16::MAX >> (16 - cascade_count)) as u16;
        let shadow_scene = crate::shadow_pass::CascadeScene {
            shadow_map: &renderer.shadow_map,
            scene: &renderer.scene,
            culling: &renderer.culling,
            lod: renderer.lod.as_ref(),
            pipelines: &renderer.pipelines,
        };

        // 串行参照:单 encoder 依序编码(生产并行化前的原路径)。
        let serial_started = Instant::now();
        let mut serial_encoder =
            renderer
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("shadow determinism serial reference"),
                });
        crate::shadow_pass::encode_shadow_cascades(&mut serial_encoder, &shadow_scene, dirty_mask);
        renderer
            .queue
            .submit([serial_encoder.finish()])
            .wait_for_completion(&renderer.device);
        let serial_elapsed = serial_started.elapsed();
        let serial_depths = read_cascade_depths(&renderer, cascade_count);
        assert!(
            serial_depths.iter().any(|&byte| byte != 0xFF),
            "serial reference depth is degenerate far-plane; shadow scene did not render"
        );

        // 并行:executor 线程各持独立 CommandEncoder,按级联升序提交。
        let parallel_started = Instant::now();
        let parallel_buffers = crate::shadow_pass::encode_shadow_cascades_parallel(
            &renderer.device,
            4,
            &shadow_scene,
            dirty_mask,
            None,
        )
        .expect("parallel cascade encode must succeed");
        assert_eq!(parallel_buffers.len(), cascade_count);
        renderer
            .queue
            .submit(parallel_buffers)
            .wait_for_completion(&renderer.device);
        let parallel_elapsed = parallel_started.elapsed();
        let parallel_depths = read_cascade_depths(&renderer, cascade_count);
        assert_eq!(
            serial_depths, parallel_depths,
            "parallel cascade encoding must be bit-identical to serial"
        );

        // 带时间戳路由的并行编码:GPU 时间戳写进级联 command buffer,
        // 贴图产物仍必须逐位一致。
        let stamper = renderer
            .telemetry
            .as_ref()
            .and_then(crate::telemetry::FrameTelemetry::gpu_segment_stamper);
        let routed_depths = if let Some(stamper) = stamper {
            let timestamps = crate::shadow_pass::CascadeShadowTimestamps {
                stamper: &stamper,
                frame_begin_on_first: true,
            };
            let buffers = crate::shadow_pass::encode_shadow_cascades_parallel(
                &renderer.device,
                4,
                &shadow_scene,
                dirty_mask,
                Some(timestamps),
            )
            .expect("timestamp-routed parallel encode must succeed");
            renderer
                .queue
                .submit(buffers)
                .wait_for_completion(&renderer.device);
            Some(read_cascade_depths(&renderer, cascade_count))
        } else {
            None
        };
        if let Some(routed_depths) = &routed_depths {
            assert_eq!(
                serial_depths, *routed_depths,
                "timestamp-routed parallel encode changed shadow output"
            );
        }

        let speedup = serial_elapsed.as_secs_f64() / parallel_elapsed.as_secs_f64();
        println!(
            "cascade shadow encode evidence: cascades={cascade_count} serial={serial_elapsed:?} parallel(4 executors)={parallel_elapsed:?} encode_speedup={speedup:.2}x timestamp_routed_bitwise_match={} depths_nonzero_bytes={}",
            routed_depths.is_some(),
            serial_depths.iter().filter(|&&byte| byte != 0xFF).count()
        );
        self.verified = true;
        event_loop.exit();
    }

    fn window_event(
        &mut self,
        _: &ActiveEventLoop,
        _: winit::window::WindowId,
        _: winit::event::WindowEvent,
    ) {
    }
}

trait WaitForCompletion {
    fn wait_for_completion(self, device: &wgpu::Device);
}

impl WaitForCompletion for wgpu::SubmissionIndex {
    fn wait_for_completion(self, device: &wgpu::Device) {
        device
            .poll(wgpu::PollType::Wait {
                submission_index: Some(self),
                timeout: Some(Duration::from_secs(5)),
            })
            .expect("GPU submission must complete");
    }
}

/// 读取全部级联层的深度贴图字节(每层行距对齐 256)。
fn read_cascade_depths(renderer: &Renderer, cascade_count: usize) -> Vec<u8> {
    let texture = &renderer.shadow_map._texture;
    let width = texture.width();
    let height = texture.height();
    let bytes_per_row = (width * 4).div_ceil(256) * 256;
    let layer_bytes = u64::from(bytes_per_row) * u64::from(height);
    let buffer = renderer.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("parallel cascade shadow depth readback"),
        size: layer_bytes * cascade_count as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = renderer
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("parallel cascade shadow depth copy"),
        });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::DepthOnly,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(bytes_per_row),
                rows_per_image: Some(height),
            },
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: cascade_count as u32,
        },
    );
    renderer.queue.submit([encoder.finish()]);
    let (sender, receiver) = mpsc::sync_channel(1);
    buffer.map_async(wgpu::MapMode::Read, .., move |result| {
        let _ = sender.send(result);
    });
    renderer
        .device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
    receiver.recv().unwrap().unwrap();
    let bytes = buffer.get_mapped_range(..).unwrap().to_vec();
    buffer.unmap();
    bytes
}

fn present(renderer: &mut Renderer) {
    for _ in 0..30 {
        match renderer.render_internal(true, true) {
            RenderOutcome::Presented => return,
            RenderOutcome::Skipped => std::thread::sleep(Duration::from_millis(10)),
            RenderOutcome::Failed(error) => panic!("GPU frame failed: {error}"),
            _ => panic!("GPU surface recovery unexpectedly required"),
        }
    }
    panic!("surface never presented");
}
