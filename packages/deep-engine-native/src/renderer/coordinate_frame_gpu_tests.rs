use super::*;
use crate::{events::RenderOutcome, hdr_readback::half_to_f32};
use std::{sync::mpsc, time::Duration};
use winit::{
    application::ApplicationHandler,
    event_loop::{ActiveEventLoop, EventLoop},
    platform::windows::EventLoopBuilderExtWindows,
};

// Frozen before the first run: HDR texture readback, not an OS screenshot.
const SIZE: PhysicalSize<u32> = PhysicalSize::new(640, 480);
const MAX_CHANGED_FRACTION: f64 = 0.01;
const MAX_LUMINANCE_RELATIVE_ERROR: f64 = 0.001;
const TEST: &str = "renderer::coordinate_frame_gpu_tests::origin_reload_preserves_presented_scene_and_failed_candidate_keeps_frame";

#[test]
fn both_fixture_hashes_validate_and_world_instance_positions_are_identical() {
    let old = load("runtime-package-coordinate-origin-a.json");
    let next = load("runtime-package-coordinate-origin-b.json");
    assert_eq!(old.packet().instances.len(), 1);
    assert_eq!(next.packet().instances.len(), 1);
    let before = &old.packet().instances[0];
    let after = &next.packet().instances[0];
    assert_eq!(before.id, after.id);
    assert_eq!(before.geometry, after.geometry);
    assert_eq!(before.material, after.material);
    assert_eq!(
        old.local_to_world([
            before.transform[12] as f64,
            before.transform[13] as f64,
            before.transform[14] as f64
        ])
        .unwrap(),
        next.local_to_world([
            after.transform[12] as f64,
            after.transform[13] as f64,
            after.transform[14] as f64
        ])
        .unwrap()
    );
    assert_eq!(
        old.local_to_world(old.initial_view().target.map(f64::from))
            .unwrap(),
        next.local_to_world(next.initial_view().target.map(f64::from))
            .unwrap()
    );
}

#[test]
#[ignore = "requires a real Windows GPU surface; coordinate-frame HDR comparison"]
fn origin_reload_preserves_presented_scene_and_failed_candidate_keeps_frame() {
    const CHILD: &str = "DEEP_COORDINATE_FRAME_CHILD";
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
                .create_window(
                    crate::app_startup::window_attributes(false)
                        .with_inner_size(SIZE)
                        .with_min_inner_size(SIZE),
                )
                .unwrap(),
        );
        let old = load("runtime-package-coordinate-origin-a.json");
        let next = load("runtime-package-coordinate-origin-b.json");
        assert!(!old.packet().instances.is_empty());
        assert_ne!(old.coordinate_frame(), next.coordinate_frame());
        assert_eq!(
            old.packet()
                .instances
                .iter()
                .map(|i| &i.id)
                .collect::<Vec<_>>(),
            next.packet()
                .instances
                .iter()
                .map(|i| &i.id)
                .collect::<Vec<_>>()
        );
        let mut user = old.initial_view();
        user.yaw += 0.125;
        user.pitch += 0.0625;
        user.distance *= 1.125;
        let rebased = next.view_after_reload(&old, user);
        assert_eq!(rebased.yaw, user.yaw);
        assert_eq!(rebased.pitch, user.pitch);
        assert_eq!(rebased.distance, user.distance);
        assert_eq!(
            old.local_to_world(user.target.map(f64::from)).unwrap(),
            next.local_to_world(rebased.target.map(f64::from)).unwrap()
        );
        let features = RendererFeatures {
            bloom: Default::default(),
            fog: deep_engine_native::fog::FogSettings::DISABLED,
            shadow_probe: false,
            ibl_probe: false,
            telemetry: false,
        };
        let mut active = pollster::block_on(Renderer::new_candidate(
            window.clone(),
            self.proxy.clone(),
            1,
            &old,
            user,
            features,
        ))
        .unwrap();
        assert_eq!(active.size, SIZE);
        active.verify_candidate_frame().unwrap();
        active.activate_surface();
        present(&mut active);
        let before = capture(&active);
        assert_visible(&before);
        let mut candidate = pollster::block_on(Renderer::new_candidate(
            window.clone(),
            self.proxy.clone(),
            2,
            &next,
            rebased,
            features,
        ))
        .unwrap();
        candidate.verify_candidate_frame().unwrap();
        // Same full-candidate order as package_live: verify offscreen before replacing the active renderer.
        drop(active);
        candidate.activate_surface();
        present(&mut candidate);
        let after = capture(&candidate);
        assert_visible(&after);
        let (fraction, relative) = compare(&before, &after);
        assert!(
            fraction <= MAX_CHANGED_FRACTION,
            "origin changed HDR pixel fraction {fraction} > {MAX_CHANGED_FRACTION}"
        );
        assert!(
            relative <= MAX_LUMINANCE_RELATIVE_ERROR,
            "origin changed HDR luminance {relative} > {MAX_LUMINANCE_RELATIVE_ERROR}"
        );
        let mut rejected = pollster::block_on(Renderer::new_candidate(
            window,
            self.proxy.clone(),
            3,
            &old,
            user,
            features,
        ))
        .unwrap();
        rejected.resize(PhysicalSize::new(0, 0)).unwrap();
        assert!(rejected.verify_candidate_frame().is_err());
        drop(rejected);
        present(&mut candidate);
        let rollback = capture(&candidate);
        assert_eq!(
            after, rollback,
            "failed unpublished candidate changed active HDR frame"
        );
        println!(
            "coordinate frame GPU verified: 640x480 actual surface presented old/new/after-failure; HDR changed_fraction={fraction} luminance_relative={relative} rollback_changed=0 thresholds=0.01/0.001; texture readback, not OS screenshot"
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

fn load(file: &str) -> PlayerContent {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(file);
    PlayerContent::from_package(
        deep_engine_native::runtime_package::load_and_validate_runtime_package(path).unwrap(),
    )
    .unwrap()
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

fn capture(renderer: &Renderer) -> Vec<u8> {
    let row_bytes = SIZE.width * 8; // 640 * RGBA16F is already 256-byte aligned.
    let buffer = renderer.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("coordinate frame HDR readback"),
        size: u64::from(row_bytes * SIZE.height),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = renderer.device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: renderer.forward_targets.resolved_texture(),
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(row_bytes),
                rows_per_image: Some(SIZE.height),
            },
        },
        wgpu::Extent3d {
            width: SIZE.width,
            height: SIZE.height,
            depth_or_array_layers: 1,
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

fn luminance(pixel: &[u8]) -> f64 {
    let channel = |i| {
        let v = half_to_f32(u16::from_le_bytes([pixel[i], pixel[i + 1]]));
        assert!(v.is_finite());
        f64::from(v)
    };
    channel(0) * 0.2126 + channel(2) * 0.7152 + channel(4) * 0.0722
}

fn assert_visible(bytes: &[u8]) {
    assert!(
        bytes
            .chunks_exact(8)
            .filter(|pixel| *pixel != &bytes[..8])
            .count()
            > 64,
        "HDR scene is flat or empty"
    );
}

fn compare(first: &[u8], second: &[u8]) -> (f64, f64) {
    assert_eq!(first.len(), second.len());
    let mut changed = 0;
    let mut a = 0.0;
    let mut b = 0.0;
    for (left, right) in first.chunks_exact(8).zip(second.chunks_exact(8)) {
        if left != right {
            changed += 1;
        }
        a += luminance(left);
        b += luminance(right);
    }
    assert!(a > 0.0);
    (changed as f64 / (first.len() / 8) as f64, (a - b).abs() / a)
}
