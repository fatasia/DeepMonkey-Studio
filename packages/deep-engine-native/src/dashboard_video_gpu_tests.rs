use super::*;
use crate::{deep2d_gpu::Deep2dGpuPainter, deep2d_gpu_cache::Deep2dGpuAssetCache};
use deep_engine_native::runtime_package::{
    DashboardNode, DashboardPage, DashboardRuntimeV1, DashboardVideoDiagnostic,
    DashboardVideoMedia, DashboardVideoPlayback as VideoIntent, DashboardVideoSource,
    DashboardVideoState, LoadedDashboard,
};
use std::{collections::BTreeMap, sync::Arc, time::Duration};

const SAMPLE_SHA256: &str = "cc0f524262f2ae97402ca8280556059c3d60cb3d25fec9309ff3b55ca974f593";

fn sample_runtime() -> DashboardRuntime {
    let bytes = std::fs::read(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/web/public/showcase/line-loop.mp4"),
    )
    .expect("real H.264 MP4 fixture");
    let media = DashboardVideoMedia {
        id: format!("media.{SAMPLE_SHA256}"),
        revision: 1,
        format: "mp4-isobmff".into(),
        mime: "video/mp4".into(),
        byte_length: bytes.len(),
        sha256: SAMPLE_SHA256.into(),
        data_base64: base64(&bytes),
    };
    DashboardRuntime::new(LoadedDashboard {
        document: DashboardRuntimeV1 {
            media: vec![media.clone()],
            videos: vec![DashboardVideoDiagnostic {
                node_id: "node.video".into(),
                source_node_id: "author.video".into(),
                source: DashboardVideoSource {
                    uri: Some("/assets/line-loop.mp4".into()),
                    availability: "packaged".into(),
                    packaged: true,
                    resource_id: Some(media.id),
                },
                playback: VideoIntent {
                    fit: "cover".into(),
                    autoplay: true,
                    muted: true,
                    r#loop: true,
                },
                state: DashboardVideoState {
                    status: "ready".into(),
                    transport: "autoplay".into(),
                    position_seconds: 0.0,
                    duration_seconds: None,
                    reason: "native-video-runtime-ready".into(),
                    missing_capabilities: vec![],
                },
            }],
            text_inputs: vec![],
            text_input: None,
            tables: vec![],
            schema: "deep-engine.dashboard-runtime".into(),
            schema_version: 1,
            id: "dashboard.runtime".into(),
            revision: 1,
            document_id: "dashboard.document".into(),
            document_revision: 1,
            entry_page_id: "page.main".into(),
            pages: vec![DashboardPage {
                id: "page.main".into(),
                width: 960.0,
                height: 540.0,
                nodes: vec![DashboardNode {
                    id: "node.video".into(),
                    revision: 1,
                    frame: [0.0, 0.0, 960.0, 540.0],
                    clip: None,
                    z_order: 0,
                    visible: true,
                    hit_id: None,
                    deep2d: None,
                    chart: None,
                    chart_sim: None,
                }],
            }],
            filter: None,
        },
        deep2d: BTreeMap::new(),
        charts: BTreeMap::new(),
        simulations: BTreeMap::new(),
    })
    .expect("video dashboard runtime")
}

fn gpu() -> (wgpu::Device, wgpu::Queue) {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::DX12;
    let instance = wgpu::Instance::new(descriptor);
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: None,
        force_fallback_adapter: false,
        apply_limit_buckets: false,
    }))
    .expect("DX12 adapter");
    pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
        .expect("DX12 device")
}

#[test]
fn real_mp4_frames_compose_through_the_deep2d_gpu_pass() {
    let runtime = sample_runtime();
    let (device, queue) = gpu();
    let painter = Deep2dGpuPainter::new(
        &device,
        &queue,
        wgpu::TextureFormat::Rgba8UnormSrgb,
        runtime.content(),
        &Arc::new(Deep2dGpuAssetCache::new()),
    )
    .expect("Deep2D video slot painter");
    let slots = painter.dashboard_video_slots();
    assert_eq!(slots.len(), 1);
    let mut compositor = DashboardVideoGpuCompositor::new(
        &device,
        &queue,
        wgpu::TextureFormat::Rgba8UnormSrgb,
        &runtime,
        slots,
        painter.logical_size(),
    )
    .expect("video compositor")
    .expect("playable video compositor");
    assert_eq!(compositor.layer_indices().collect::<Vec<_>>(), vec![0]);
    assert!(
        !compositor
            .sync_slots(&device, slots, painter.logical_size())
            .unwrap()
    );
    assert!(!compositor.advance(&queue).unwrap());
    std::thread::sleep(Duration::from_millis(90));
    assert!(compositor.advance(&queue).unwrap());
    let mut uploaded = compositor.uploaded_frames();
    // 负载下 Media Foundation 可能已预取多帧，"90ms 内至多一帧"的时序假设
    // 会在全量并行测试下误报：这里排空至 advance 稳定为 false（行为不变量），
    // 而不是断言单次调用内至多消费一帧。
    let mut settled = 0usize;
    while compositor.advance(&queue).unwrap() {
        settled += 1;
        assert!(
            settled < 8,
            "video advance must settle, not stream without pacing"
        );
        uploaded = compositor.uploaded_frames();
    }
    assert_eq!(compositor.uploaded_frames(), uploaded);

    let paused = compositor
        .control("node.video", &queue, DashboardVideoCommand::Pause)
        .unwrap();
    assert!(!paused.playing);
    std::thread::sleep(Duration::from_millis(50));
    // A frame already queued before the pause may be consumed once. Drain it,
    // then verify that the paused stream stays frozen on the next tick.
    let _ = compositor.advance(&queue).unwrap();
    let paused_uploaded = compositor.uploaded_frames();
    std::thread::sleep(Duration::from_millis(50));
    assert!(!compositor.advance(&queue).unwrap());
    assert_eq!(compositor.uploaded_frames(), paused_uploaded);
    uploaded = paused_uploaded;
    assert!(
        compositor
            .control("node.video", &queue, DashboardVideoCommand::Play)
            .unwrap()
            .playing
    );
    std::thread::sleep(Duration::from_millis(90));
    assert!(compositor.advance(&queue).unwrap());
    uploaded = compositor.uploaded_frames();
    let seeked = compositor
        .control(
            "node.video",
            &queue,
            DashboardVideoCommand::SeekTo100ns(10_000_000),
        )
        .unwrap();
    assert!(seeked.texture_updated);
    assert!((seeked.position_100ns - 10_000_000).abs() <= 1_000_000);
    assert_eq!(compositor.uploaded_frames(), uploaded + 1);
    uploaded += 1;

    compositor.suspend(&queue).unwrap();
    std::thread::sleep(Duration::from_millis(50));
    assert!(!compositor.advance(&queue).unwrap());
    assert_eq!(compositor.uploaded_frames(), uploaded);
    compositor.resume().unwrap();

    let mut replacement = slots.to_vec();
    replacement[0].frame = [120.0, 60.0, 480.0, 270.0];
    assert!(
        compositor
            .sync_slots(&device, &replacement, painter.logical_size())
            .unwrap()
    );
    assert!(
        !compositor
            .sync_slots(&device, &replacement, painter.logical_size())
            .unwrap()
    );
    compositor
        .sync_slots(&device, slots, painter.logical_size())
        .unwrap();
    compositor.update_frame_uniform(&queue, (960, 540));

    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("dashboard video compositor proof"),
        size: wgpu::Extent3d {
            width: 960,
            height: 540,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8UnormSrgb,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = target.create_view(&Default::default());
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let colors = [Some(wgpu::RenderPassColorAttachment {
            view: &view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                store: wgpu::StoreOp::Store,
            },
        })];
        drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("dashboard video compositor clear"),
            color_attachments: &colors,
            depth_stencil_attachment: None,
            ..Default::default()
        }));
    }
    painter.draw_with_dashboard_videos(&mut encoder, &view, (960, 540), Some(&compositor));
    let aligned_row = (960_u32 * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
        * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("dashboard video compositor readback"),
        size: u64::from(aligned_row) * 540,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    encoder.copy_texture_to_buffer(
        target.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(aligned_row),
                rows_per_image: Some(540),
            },
        },
        wgpu::Extent3d {
            width: 960,
            height: 540,
            depth_or_array_layers: 1,
        },
    );
    queue.submit([encoder.finish()]);
    let (sender, receiver) = std::sync::mpsc::channel();
    readback.map_async(wgpu::MapMode::Read, .., move |result| {
        sender.send(result).unwrap();
    });
    device
        .poll(wgpu::PollType::wait_indefinitely())
        .expect("GPU composition completes");
    receiver.recv().unwrap().unwrap();
    let pixels = readback.get_mapped_range(..).unwrap();
    assert!(
        (0..540_usize).any(|row| pixels
            [row * aligned_row as usize..row * aligned_row as usize + 960 * 4]
            .chunks_exact(4)
            .any(|pixel| pixel[..3] != [0, 0, 0])),
        "the formal Deep2D pass must contain decoded MP4 pixels"
    );
    drop(pixels);
    readback.unmap();

    drop(compositor);
    let recovered = DashboardVideoGpuCompositor::new(
        &device,
        &queue,
        wgpu::TextureFormat::Rgba8UnormSrgb,
        &runtime,
        slots,
        painter.logical_size(),
    )
    .expect("device recovery rebuild")
    .expect("recovered compositor");
    assert_eq!(recovered.layer_indices().collect::<Vec<_>>(), vec![0]);
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0];
        let b = chunk.get(1).copied().unwrap_or(0);
        let c = chunk.get(2).copied().unwrap_or(0);
        output.push(ALPHABET[(a >> 2) as usize] as char);
        output.push(ALPHABET[(((a & 3) << 4) | (b >> 4)) as usize] as char);
        output.push(if chunk.len() > 1 {
            ALPHABET[(((b & 15) << 2) | (c >> 6)) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            ALPHABET[(c & 63) as usize] as char
        } else {
            '='
        });
    }
    output
}
