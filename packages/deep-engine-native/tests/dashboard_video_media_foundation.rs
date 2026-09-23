#![cfg(windows)]

use deep_engine_native::{
    dashboard_runtime::{
        DashboardRuntime, DashboardVideoCommand, dashboard_video_drag_command,
        dashboard_video_key_command,
    },
    dashboard_video::{
        DashboardVideoFrameTexture, DashboardVideoDecoder, decode_first_packaged_mp4_frame,
    },
    runtime_package::{
        DashboardNode, DashboardPage, DashboardRuntimeV1, DashboardVideoDiagnostic,
        DashboardVideoMedia, DashboardVideoPlayback as DashboardVideoIntent, DashboardVideoSource,
        DashboardVideoState, LoadedDashboard,
    },
};
use std::{collections::BTreeMap, path::PathBuf, time::Duration};

const SAMPLE_SHA256: &str = "cc0f524262f2ae97402ca8280556059c3d60cb3d25fec9309ff3b55ca974f593";
/// 合成音轨样本 `tests/fixtures/audio-track-sample.mp4` 的内容哈希。
/// 样本档案(来源/授权/格式/预期内容)见 tests/fixtures/README.md。
const AUDIO_SAMPLE_SHA256: &str = "81afc6e84e23536c6b1056f84051a8fa3fb4eafbb4280c0c89ef7eea1e43dc9f";

fn fixture_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative)
}

fn sample_bytes() -> Vec<u8> {
    std::fs::read(fixture_path("../../apps/web/public/showcase/line-loop.mp4"))
        .expect("real H.264 MP4 fixture")
}

fn packaged_media(bytes: &[u8]) -> DashboardVideoMedia {
    DashboardVideoMedia {
        id: format!("media.{SAMPLE_SHA256}"),
        revision: 1,
        format: "mp4-isobmff".into(),
        mime: "video/mp4".into(),
        byte_length: bytes.len(),
        sha256: SAMPLE_SHA256.into(),
        data_base64: base64(bytes),
    }
}

fn runtime(
    media: DashboardVideoMedia,
    autoplay: bool,
    muted: bool,
    loop_enabled: bool,
) -> DashboardRuntime {
    runtime_with_fit(media, autoplay, muted, loop_enabled, "cover")
}

fn runtime_with_fit(
    media: DashboardVideoMedia,
    autoplay: bool,
    muted: bool,
    loop_enabled: bool,
    fit: &str,
) -> DashboardRuntime {
    let diagnostic = DashboardVideoDiagnostic {
        node_id: "node.video".into(),
        source_node_id: "author.video".into(),
        source: DashboardVideoSource {
            uri: Some("/assets/projects/p/assets/line-loop".into()),
            availability: "packaged".into(),
            packaged: true,
            resource_id: Some(media.id.clone()),
        },
        playback: DashboardVideoIntent {
            fit: fit.into(),
            autoplay,
            muted,
            r#loop: loop_enabled,
        },
        state: DashboardVideoState {
            status: if muted || media.id == format!("media.{AUDIO_SAMPLE_SHA256}") { "ready" } else { "blocked" }.into(),
            transport: if muted || media.id == format!("media.{AUDIO_SAMPLE_SHA256}") {
                if autoplay { "autoplay" } else { "poster" }
            } else {
                "unavailable"
            }
            .into(),
            position_seconds: 0.0,
            duration_seconds: None,
            reason: if muted || media.id == format!("media.{AUDIO_SAMPLE_SHA256}") {
                "native-video-runtime-ready"
            } else {
                "native-video-audio-unavailable"
            }
            .into(),
            missing_capabilities: if muted || media.id == format!("media.{AUDIO_SAMPLE_SHA256}") {
                vec![]
            } else {
                vec!["audio-output".into()]
            },
        },
    };
    DashboardRuntime::new(LoadedDashboard {
        document: DashboardRuntimeV1 {
            media: vec![media],
            videos: vec![diagnostic],
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
    .unwrap()
}

#[test]
fn real_packaged_h264_first_frame_decodes_and_uploads_to_gpu() {
    let bytes = sample_bytes();
    assert_eq!(bytes.len(), 39_837);
    let frame = decode_first_packaged_mp4_frame(&packaged_media(&bytes))
        .expect("Media Foundation must decode the packaged sample");
    assert_eq!((frame.width, frame.height), (960, 540));
    assert_eq!(frame.row_bytes, 960 * 4);
    assert_eq!(frame.timestamp_100ns, 0);
    assert_eq!(frame.pixels.len(), 960 * 540 * 4);
    assert!(
        frame
            .pixels
            .chunks_exact(4)
            .any(|pixel| pixel[0] != pixel[1] || pixel[1] != pixel[2]),
        "the decoded frame must contain real non-greyscale image data"
    );

    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::DX12;
    let instance = wgpu::Instance::new(descriptor);
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: None,
        force_fallback_adapter: false,
        apply_limit_buckets: false,
    }))
    .expect("DX12 hardware adapter");
    assert_ne!(adapter.get_info().device_type, wgpu::DeviceType::Cpu);
    let (device, queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
            .expect("DX12 device");

    let resident = DashboardVideoFrameTexture::new(&device, &queue, &frame)
        .expect("decoded frame GPU texture upload");
    assert_eq!(resident.update_serial(), 1);
    assert_eq!(resident.last_timestamp_100ns(), 0);

    let aligned_row = frame.row_bytes.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
        * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("dashboard video real-frame readback"),
        size: aligned_row as u64 * frame.height as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("dashboard video real-frame copy"),
    });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: resident.texture(),
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(aligned_row),
                rows_per_image: Some(frame.height),
            },
        },
        wgpu::Extent3d {
            width: frame.width,
            height: frame.height,
            depth_or_array_layers: 1,
        },
    );
    queue.submit([encoder.finish()]);
    let (sender, receiver) = std::sync::mpsc::channel();
    readback.map_async(wgpu::MapMode::Read, .., move |result| {
        sender.send(result).unwrap();
    });
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    receiver.recv().unwrap().unwrap();
    let mapped = readback.get_mapped_range(..).unwrap();
    for row in 0..frame.height as usize {
        let gpu_start = row * aligned_row as usize;
        let cpu_start = row * frame.row_bytes as usize;
        assert_eq!(
            &mapped[gpu_start..gpu_start + frame.row_bytes as usize],
            &frame.pixels[cpu_start..cpu_start + frame.row_bytes as usize]
        );
    }
}

#[test]
fn decode_boundary_rejects_content_address_mismatch() {
    let bytes = sample_bytes();
    let mut media = packaged_media(&bytes);
    media.sha256.replace_range(..2, "00");
    assert!(decode_first_packaged_mp4_frame(&media).is_err());
}

fn media_from_fixture(bytes: &[u8], sha256: &str) -> DashboardVideoMedia {
    DashboardVideoMedia {
        id: format!("media.{sha256}"),
        revision: 1,
        format: "mp4-isobmff".into(),
        mime: "video/mp4".into(),
        byte_length: bytes.len(),
        sha256: sha256.into(),
        data_base64: base64(bytes),
    }
}

#[test]
fn silent_sample_reports_no_audio_track() {
    // 无音轨的纯 H.264 样本必须显式报告"无音轨",无声原因是源属性而非默认遗漏。
    let bytes = sample_bytes();
    let mut decoder = DashboardVideoDecoder::new(&media_from_fixture(&bytes, SAMPLE_SHA256))
        .expect("open silent sample");
    assert_eq!(decoder.audio_track(), None);
    assert!(decoder.next_frame().unwrap().is_some());
}

#[test]
fn synthetic_audio_sample_probes_track_and_sample_rate() {
    // 合成 AAC 样本验证音轨探测管道:音轨存在性 + 采样率读取。
    // 音频轨道探测是编译/校验合同；真实设备出声仍由单独的 ignored
    // hardware test 取证。
    let bytes = std::fs::read(fixture_path("tests/fixtures/audio-track-sample.mp4"))
        .expect("synthetic audio-track fixture");
    let mut decoder = DashboardVideoDecoder::new(&media_from_fixture(&bytes, AUDIO_SAMPLE_SHA256))
        .expect("open synthetic audio sample");
    let track = decoder
        .audio_track()
        .expect("synthetic sample must expose its audio track");
    assert_eq!(track.sample_rate, 44_100);
    // 音轨存在不影响视频解码与静音播放合同。
    assert!(decoder.next_frame().unwrap().is_some());
}

#[test]
fn formal_dashboard_runtime_advances_real_frames_on_a_monotonic_muted_loop() {
    let bytes = sample_bytes();
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::DX12;
    let instance = wgpu::Instance::new(descriptor);
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: None,
        force_fallback_adapter: false,
        apply_limit_buckets: false,
    }))
    .expect("DX12 hardware adapter");
    let (device, queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
            .expect("DX12 device");

    let start = Duration::from_secs(10);
    let dashboard = runtime(packaged_media(&bytes), true, true, true);
    let mut playback = dashboard
        .prepare_video_playback("node.video", &device, &queue, start)
        .expect("formal Dashboard Runtime video playback");
    assert!(playback.autoplay());
    assert!(playback.is_muted());
    assert!(playback.loop_enabled());

    let first = playback.advance_to(&queue, start).unwrap();
    assert!(!first.texture_updated);
    assert_eq!((first.texture_serial, first.presentation_100ns), (1, 0));
    let second = playback
        .advance_to(&queue, start + Duration::from_millis(100))
        .unwrap();
    assert!(second.texture_updated);
    assert_eq!(second.texture_serial, 2);
    assert!(second.presentation_100ns > first.presentation_100ns);
    let third = playback
        .advance_to(&queue, start + Duration::from_millis(200))
        .unwrap();
    assert!(third.texture_updated);
    assert_eq!(third.texture_serial, 3);
    assert!(third.presentation_100ns > second.presentation_100ns);
    let placement = playback.placement(540.0, 540.0).unwrap();
    assert_eq!(placement.destination, [0.0, 0.0, 540.0, 540.0]);
    assert!((placement.uv[0] - 0.21875).abs() < 0.00001);
    assert!((placement.uv[2] - 0.5625).abs() < 0.00001);

    let contain_dashboard = runtime_with_fit(packaged_media(&bytes), false, true, false, "contain");
    let contain = contain_dashboard
        .prepare_video_playback("node.video", &device, &queue, start)
        .unwrap()
        .placement(540.0, 540.0)
        .unwrap();
    assert_eq!(contain.destination, [0.0, 118.125, 540.0, 303.75]);
    assert_eq!(contain.uv, [0.0, 0.0, 1.0, 1.0]);
    let fill_dashboard = runtime_with_fit(packaged_media(&bytes), false, true, false, "fill");
    let fill = fill_dashboard
        .prepare_video_playback("node.video", &device, &queue, start)
        .unwrap()
        .placement(540.0, 540.0)
        .unwrap();
    assert_eq!(fill.destination, [0.0, 0.0, 540.0, 540.0]);
    assert_eq!(fill.uv, [0.0, 0.0, 1.0, 1.0]);

    let looped = playback
        .advance_to(&queue, start + Duration::from_secs(13))
        .unwrap();
    assert!(looped.texture_updated);
    assert!(looped.completed_loops >= 1);
    assert!(looped.presentation_100ns > third.presentation_100ns);
    assert!(looped.position_100ns < 2 * 10_000_000);
    assert!(!looped.ended);
    assert!(
        playback
            .advance_to(&queue, start + Duration::from_secs(12))
            .is_err(),
        "the media clock must reject backwards host time"
    );

    let lifecycle_dashboard = runtime(packaged_media(&bytes), true, true, true);
    let mut lifecycle = lifecycle_dashboard
        .prepare_video_playback("node.video", &device, &queue, start)
        .unwrap();
    let suspended = lifecycle
        .suspend_for_lifecycle(&queue, start + Duration::from_millis(100))
        .unwrap();
    let held = lifecycle
        .advance_to(&queue, start + Duration::from_secs(2))
        .unwrap();
    assert_eq!(held.texture_serial, suspended.texture_serial);
    assert_eq!(held.presentation_100ns, suspended.presentation_100ns);
    lifecycle
        .resume_from_lifecycle(start + Duration::from_secs(2))
        .unwrap();
    let resumed = lifecycle
        .advance_to(&queue, start + Duration::from_millis(2_100))
        .unwrap();
    assert!(resumed.texture_updated);
    assert!(resumed.presentation_100ns > held.presentation_100ns);

    let paused_dashboard = runtime(packaged_media(&bytes), false, true, true);
    let mut paused = paused_dashboard
        .prepare_video_playback("node.video", &device, &queue, start)
        .unwrap();
    let paused_state = paused
        .advance_to(&queue, start + Duration::from_secs(2))
        .unwrap();
    assert!(!paused_state.texture_updated);
    assert_eq!(paused_state.texture_serial, 1);
    assert!(!paused_state.playing);
    assert!(paused_state.duration_100ns > 10_000_000);
    let played = paused
        .control(
            &queue,
            start + Duration::from_secs(2),
            DashboardVideoCommand::Play,
        )
        .unwrap();
    assert!(played.playing);
    let after_play = paused
        .advance_to(&queue, start + Duration::from_millis(2_100))
        .unwrap();
    assert!(after_play.texture_updated);
    let held = paused
        .control(
            &queue,
            start + Duration::from_millis(2_100),
            DashboardVideoCommand::Pause,
        )
        .unwrap();
    assert!(!held.playing);
    let still_held = paused
        .advance_to(&queue, start + Duration::from_secs(3))
        .unwrap();
    assert_eq!(still_held.texture_serial, held.texture_serial);
    assert_eq!(still_held.position_100ns, held.position_100ns);
    paused
        .control(
            &queue,
            start + Duration::from_secs(3),
            DashboardVideoCommand::Play,
        )
        .unwrap();
    let resumed_play = paused
        .advance_to(&queue, start + Duration::from_millis(3_100))
        .unwrap();
    assert!(resumed_play.presentation_100ns > held.presentation_100ns);
    let seeked = paused
        .control(
            &queue,
            start + Duration::from_millis(3_100),
            DashboardVideoCommand::SeekTo100ns(10_000_000),
        )
        .unwrap();
    assert!(seeked.texture_updated);
    assert!((seeked.position_100ns - 10_000_000).abs() <= 1_000_000);
    assert!(seeked.presentation_100ns > resumed_play.presentation_100ns);
    let clamped = paused
        .control(
            &queue,
            start + Duration::from_millis(3_100),
            DashboardVideoCommand::SeekTo100ns(i64::MAX),
        )
        .unwrap();
    assert!(clamped.position_100ns < clamped.duration_100ns);
    assert_eq!(
        dashboard_video_key_command("ArrowLeft", false),
        Some(DashboardVideoCommand::SeekBy100ns(-50_000_000))
    );
    assert_eq!(
        dashboard_video_key_command("Space", false),
        Some(DashboardVideoCommand::Toggle)
    );
    assert_eq!(
        dashboard_video_drag_command(0.5, clamped.duration_100ns).unwrap(),
        DashboardVideoCommand::SeekTo100ns(clamped.duration_100ns / 2)
    );
    assert_eq!(
        dashboard_video_drag_command(2.0, clamped.duration_100ns).unwrap(),
        DashboardVideoCommand::SeekTo100ns(clamped.duration_100ns)
    );

    let audible_dashboard = runtime(packaged_media(&bytes), true, false, true);
    assert!(
        audible_dashboard
            .prepare_video_playback("node.video", &device, &queue, start)
            .is_err(),
        "a packaged video without an audio track must fail closed when authored unmuted"
    );
}

#[test]
#[ignore = "requires a Windows default audio output device"]
fn real_audio_track_enters_native_playback_and_follows_transport() {
    let bytes = std::fs::read(fixture_path("tests/fixtures/audio-track-sample.mp4"))
        .expect("synthetic AAC audio-track fixture");
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::DX12;
    let instance = wgpu::Instance::new(descriptor);
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: None,
        force_fallback_adapter: false,
        apply_limit_buckets: false,
    }))
    .expect("DX12 hardware adapter");
    let (device, queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
            .expect("DX12 device");
    let dashboard = runtime(
        media_from_fixture(&bytes, AUDIO_SAMPLE_SHA256),
        true,
        false,
        true,
    );
    let mut playback = dashboard
        .prepare_video_playback("node.video", &device, &queue, Duration::from_secs(1))
        .expect("default audio output and AAC decoder");
    assert!(!playback.is_muted());
    assert!(playback.is_playing());
    let paused = playback
        .control(
            &queue,
            Duration::from_secs(1),
            DashboardVideoCommand::Pause,
        )
        .expect("pause audio and video together");
    assert!(!paused.playing);
    let resumed = playback
        .control(
            &queue,
            Duration::from_secs(2),
            DashboardVideoCommand::Play,
        )
        .expect("resume audio and video together");
    assert!(resumed.playing);
}

#[test]
#[ignore = "requires a Windows default audio output device"]
fn formal_exe_audio_device_switch_long_stability_and_av_sync() {
    let bytes = std::fs::read(fixture_path("tests/fixtures/audio-track-sample.mp4"))
        .expect("synthetic AAC audio-track fixture");
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::DX12;
    let instance = wgpu::Instance::new(descriptor);
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: None,
        force_fallback_adapter: false,
        apply_limit_buckets: false,
    }))
    .expect("DX12 hardware adapter");
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
        .expect("DX12 device");
    let dashboard = runtime(media_from_fixture(&bytes, AUDIO_SAMPLE_SHA256), true, false, true);
    let mut playback = dashboard
        .prepare_video_playback("node.video", &device, &queue, Duration::from_secs(1))
        .expect("default audio output and AAC decoder");
    let devices = deep_engine_native::dashboard_audio::DashboardAudioTrack::output_devices()
        .expect("enumerate Windows output devices");
    assert!(!devices.is_empty(), "at least the default output must be listed");
    let initial_device = playback.audio_device_name().unwrap_or("unknown").to_string();
    let mut switched = false;
    for device_name in devices.iter().filter(|name| name.as_str() != initial_device) {
        playback
            .switch_audio_device(&queue, Duration::from_secs(1), device_name)
            .expect("switch audio device and preserve transport");
        assert_eq!(playback.audio_device_name(), Some(device_name.as_str()));
        switched = true;
        break;
    }

    // Real-time soak: advance the same packaged EXE playback path for 30 s,
    // sample the output clock and bound A/V drift to 150 ms.
    let max_drift_100ns = formal_soak_av_drift(&mut playback, &queue, Duration::from_secs(30)).max_100ns;
    println!("audio formal clocks: video={} audio={:?} drift={}", playback.state().position_100ns, playback.audio_position_100ns(), max_drift_100ns);
    assert!(max_drift_100ns <= 1_500_000, "A/V drift exceeded 150 ms: {max_drift_100ns} 100ns");
    println!(
        "formal native EXE audio: device={initial_device}; switched={switched}; soak_seconds=30; max_av_drift_ms={:.1}",
        max_drift_100ns as f64 / 10_000.0
    );
}

#[test]
#[ignore = "requires a Windows default audio output device; real-time 30-minute soak"]
fn formal_exe_audio_thirty_minute_stability_soak() {
    let soak_seconds = std::env::var("DEEP_AUDIO_SOAK_SECONDS")
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|seconds| *seconds > 0)
        .unwrap_or(1800);
    let bytes = std::fs::read(fixture_path("tests/fixtures/audio-track-sample.mp4"))
        .expect("synthetic AAC audio-track fixture");
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::DX12;
    let instance = wgpu::Instance::new(descriptor);
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: None,
        force_fallback_adapter: false,
        apply_limit_buckets: false,
    }))
    .expect("DX12 hardware adapter");
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
        .expect("DX12 device");
    let dashboard = runtime(media_from_fixture(&bytes, AUDIO_SAMPLE_SHA256), true, false, true);
    let mut playback = dashboard
        .prepare_video_playback("node.video", &device, &queue, Duration::from_secs(1))
        .expect("default audio output and AAC decoder");
    let devices = deep_engine_native::dashboard_audio::DashboardAudioTrack::output_devices()
        .expect("enumerate Windows output devices");
    assert!(!devices.is_empty(), "at least the default output must be listed");
    let initial_device = playback.audio_device_name().unwrap_or("unknown").to_string();
    let mut switched = false;
    for device_name in devices.iter().filter(|name| name.as_str() != initial_device) {
        playback
            .switch_audio_device(&queue, Duration::from_secs(1), device_name)
            .expect("switch audio device and preserve transport");
        assert_eq!(playback.audio_device_name(), Some(device_name.as_str()));
        switched = true;
        break;
    }

    let stats = formal_soak_av_drift(&mut playback, &queue, Duration::from_secs(soak_seconds));
    let max_drift_ms = stats.max_100ns as f64 / 10_000.0;
    let mean_drift_ms = if stats.samples > 0 {
        stats.sum_100ns as f64 / stats.samples as f64 / 10_000.0
    } else {
        0.0
    };
    println!(
        "audio 30-minute clocks: video={} audio={:?} samples={} max_drift_ms={max_drift_ms:.1} mean_drift_ms={mean_drift_ms:.1}",
        playback.state().position_100ns,
        playback.audio_position_100ns(),
        stats.samples,
    );
    // 证据先于断言落盘:长稳失败也必须留下可审计的偏差记录。
    let passed = stats.max_100ns <= 1_500_000;
    let evidence = format!(
        "{{\n  \"schema\": \"deep-engine.native-audio-30min-soak-evidence\",\n  \"date\": \"2026-09-23\",\n  \"test\": \"formal_exe_audio_thirty_minute_stability_soak\",\n  \"result\": \"{}\",\n  \"platform\": \"Windows DX12\",\n  \"device\": \"{initial_device}\",\n  \"deviceSwitch\": {switched},\n  \"soakSeconds\": {soak_seconds},\n  \"samples\": {},\n  \"maxAvDriftMs\": {max_drift_ms:.1},\n  \"meanAvDriftMs\": {mean_drift_ms:.1},\n  \"avDriftLimitMs\": 150.0,\n  \"resync\": \"threshold-100ms; in-place seek first, reopen-at-position fallback\"\n}}\n",
        if passed { "passed" } else { "failed" },
        stats.samples
    );
    std::fs::write(
        fixture_path("../../test-output/native-audio-30min-soak-evidence-2026-09-23.json"),
        evidence,
    )
    .expect("write 30-minute soak evidence JSON");
    assert!(passed, "A/V drift exceeded 150 ms over {soak_seconds} s: {} 100ns", stats.max_100ns);
    println!(
        "formal native EXE audio 30-minute soak: device={initial_device}; switched={switched}; soak_seconds={soak_seconds}; samples={}; max_av_drift_ms={max_drift_ms:.1}; mean_av_drift_ms={mean_drift_ms:.1}",
        stats.samples
    );
}

struct AudioSoakDrift {
    max_100ns: i64,
    sum_100ns: i64,
    samples: usize,
    /// 逃逸样本(>阈值):(t 秒, 漂移 100ns),用于定位单次尖峰成因。
    escapes: Vec<(f64, i64)>,
}

// Real-time soak shared by the 30 s formal gate and the 30-minute stability
// soak: advance the packaged EXE playback path, sample the output clock and
// bound A/V drift to 150 ms.
fn formal_soak_av_drift(
    playback: &mut deep_engine_native::dashboard_runtime::DashboardVideoPlayback,
    queue: &wgpu::Queue,
    soak: Duration,
) -> AudioSoakDrift {
    let start = std::time::Instant::now();
    let mut stats = AudioSoakDrift {
        max_100ns: 0,
        sum_100ns: 0,
        samples: 0,
        escapes: Vec::new(),
    };
    while start.elapsed() < soak {
        let tick = Duration::from_secs(1) + start.elapsed();
        let state = playback.advance_to(queue, tick).expect("stable media advance");
        if let Some(audio) = playback.audio_position_100ns() {
            let duration = playback.duration_100ns().max(1);
            let video = state.position_100ns.rem_euclid(duration);
            let audio = audio.rem_euclid(duration);
            let direct = (audio - video).abs();
            let wrapped = duration - direct;
            let drift = direct.min(wrapped);
            if drift > 1_000_000 {
                stats.escapes.push((start.elapsed().as_secs_f64(), drift));
            }
            stats.max_100ns = stats.max_100ns.max(drift);
            stats.sum_100ns += drift;
            stats.samples += 1;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    stats
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0];
        let b = chunk.get(1).copied().unwrap_or(0);
        let c = chunk.get(2).copied().unwrap_or(0);
        output.push(ALPHABET[(a >> 2) as usize] as char);
        output.push(ALPHABET[(((a & 0x03) << 4) | (b >> 4)) as usize] as char);
        output.push(if chunk.len() > 1 {
            ALPHABET[(((b & 0x0f) << 2) | (c >> 6)) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            ALPHABET[(c & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    output
}
