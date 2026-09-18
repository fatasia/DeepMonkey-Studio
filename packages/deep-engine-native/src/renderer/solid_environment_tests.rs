use super::*;
use crate::events::RenderOutcome;
use deep_engine_native::runtime_package::{
    parse_and_validate_runtime_package, runtime_content_sha256, runtime_package_sha256,
};
use serde_json::{Value, json};
use winit::{
    application::ApplicationHandler,
    event_loop::{ActiveEventLoop, EventLoop},
    platform::windows::EventLoopBuilderExtWindows,
};

fn content(color: [f64; 3]) -> PlayerContent {
    lit_content(color, None, None)
}
fn lit_content(
    color: [f64; 3],
    lighting: Option<Value>,
    receive_shadow: Option<bool>,
) -> PlayerContent {
    lit_content_flags(color, lighting, receive_shadow, None)
}
fn lit_content_flags(
    color: [f64; 3],
    lighting: Option<Value>,
    receive_shadow: Option<bool>,
    cast_shadow: Option<bool>,
) -> PlayerContent {
    lit_content_modify(color, lighting, receive_shadow, cast_shadow, |_| {})
}
fn lit_content_modify(
    color: [f64; 3],
    lighting: Option<Value>,
    receive_shadow: Option<bool>,
    cast_shadow: Option<bool>,
    modify: impl FnOnce(&mut Value),
) -> PlayerContent {
    lit_content_environment(color, lighting, receive_shadow, cast_shadow, modify, None)
}
fn lit_content_environment(
    color: [f64; 3],
    lighting: Option<Value>,
    receive_shadow: Option<bool>,
    cast_shadow: Option<bool>,
    modify: impl FnOnce(&mut Value),
    ibl: Option<Value>,
) -> PlayerContent {
    let mut package: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/runtime-package-v1.json")).unwrap();
    let old = package["entrypoints"]["environment"]
        .as_str()
        .unwrap()
        .to_owned();
    package["payloads"].as_object_mut().unwrap().remove(&old);
    package["entrypoints"]["environment"] = json!("scene.environment");
    let mut value = json!({"schema":"deep-engine.solid-environment","schemaVersion":1,"id":"scene.environment","revision":1,
        "kind":"solid-background-no-ibl","backgroundSrgb":color,"outputTransform":"native-aces-v1"});
    if let Some(lighting) = lighting {
        let many = lighting.get("localLights").is_some();
        let shadows = lighting["localLights"]
            .as_array()
            .is_some_and(|lights| lights.iter().any(|light| light["castShadow"] == true));
        let point_shadows = lighting["localLights"].as_array().is_some_and(|lights| {
            lights
                .iter()
                .any(|light| light["castShadow"] == true && light["kind"] == "point")
        });
        value["schemaVersion"] = json!(if point_shadows {
            5
        } else if shadows {
            4
        } else if many {
            3
        } else {
            2
        });
        value["outputTransform"] = json!(if point_shadows {
            "native-aces-local-shadows-v5"
        } else if shadows {
            "native-aces-spot-shadows-v4"
        } else if many {
            "native-aces-lights-v3"
        } else {
            "native-aces-light-v2"
        });
        value["lighting"] = lighting;
    }
    modify(&mut package["payloads"]["scene.main"]);
    if let Some(mut ibl) = ibl {
        ibl["id"] = json!("scene.environment");
        value["schemaVersion"] = json!(6);
        value["kind"] = json!("solid-background-prefiltered-ibl");
        value["outputTransform"] = json!("native-aces-hdr-v6");
        value["ibl"] = ibl;
    }
    {
        for instance in package["payloads"]["scene.main"]["instances"]
            .as_array_mut()
            .unwrap()
        {
            if let Some(receive) = receive_shadow {
                instance["receiveShadow"] = json!(receive);
            }
            if let Some(cast) = cast_shadow {
                instance["castShadow"] = json!(cast);
            }
        }
        let hash = runtime_content_sha256(&package["payloads"]["scene.main"]);
        for resource in package["resources"].as_array_mut().unwrap() {
            if resource["id"] == "scene.main" {
                resource["contentHash"]["value"] = json!(hash);
            }
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
fn validated_package_retains_authored_background_and_zero_ibl() {
    let value = content([0.1, 0.2, 0.3]);
    assert!(value.background.is_some());
    assert_eq!(value.environment.id, "scene.environment");
    for cube in [&value.environment.specular, &value.environment.diffuse] {
        assert!(
            cube.mips
                .iter()
                .all(|mip| mip.texels.iter().all(|texel| texel[..3] == [0.0; 3]))
        );
    }
    assert!(!entry_bloom(&value).is_active());
    assert!(!value.packet().instances.is_empty());
    let legacy = PlayerContent::from_package(
        parse_and_validate_runtime_package(include_bytes!(
            "../../tests/fixtures/runtime-package-v1.json"
        ))
        .unwrap(),
    )
    .unwrap();
    assert!(legacy.background.is_none());
    assert!(entry_bloom(&legacy).is_active());
    assert_ne!(legacy.environment.id, value.environment.id);
}

#[test]
#[ignore = "real Windows GPU surface, authored background resize and transactional rollback"]
fn solid_background_survives_resize_and_failed_replacement() {
    let child = "DEEP_SOLID_ENVIRONMENT_CHILD";
    if std::env::var_os(child).is_none() {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "renderer::solid_environment_tests::solid_background_survives_resize_and_failed_replacement", "--ignored", "--nocapture"])
            .env(child, "1").output().unwrap();
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
    let events = builder.build().unwrap();
    let mut probe = Probe {
        proxy: events.create_proxy(),
        verified: false,
    };
    events.run_app(&mut probe).unwrap();
    assert!(probe.verified);
}

struct Probe {
    proxy: EventLoopProxy<GpuEvent>,
    verified: bool,
}
impl ApplicationHandler<GpuEvent> for Probe {
    fn resumed(&mut self, events: &ActiveEventLoop) {
        let window = Arc::new(
            events
                .create_window(
                    crate::app_startup::window_attributes(false)
                        .with_inner_size(PhysicalSize::new(640, 480)),
                )
                .unwrap(),
        );
        if std::env::var_os("DEEP_ENGINE_TEST_HDR_ONLY").is_some() {
            hdr_material_tests::verify(window, self.proxy.clone());
            self.verified = true;
            events.exit();
            return;
        }
        let old = content([0.1, 0.2, 0.3]);
        let next = content([0.3, 0.2, 0.1]);
        let features = RendererFeatures {
            bloom: entry_bloom(&old),
            fog: FogSettings::DISABLED,
            shadow_probe: false,
            ibl_probe: false,
            telemetry: false,
        };
        let unsupported = RendererFeatures {
            bloom: deep_engine_native::bloom::BloomSettings::default(),
            ..features
        };
        assert!(
            pollster::block_on(Renderer::new_candidate(
                window.clone(),
                self.proxy.clone(),
                1,
                &old,
                old.initial_view(),
                unsupported
            ))
            .is_err()
        );
        verify_profile_transition(window.clone(), self.proxy.clone(), &old);
        directional_tests::verify(window.clone(), self.proxy.clone());
        local_tests::verify(window.clone(), self.proxy.clone());
        spot_shadow_tests::verify(window.clone(), self.proxy.clone());
        spot_shadow_tests::verify_point(window.clone(), self.proxy.clone());
        point_shadow_faces_tests::verify(window.clone(), self.proxy.clone());
        hdr_material_tests::verify(window.clone(), self.proxy.clone());
        let mut renderer = pollster::block_on(Renderer::new_candidate(
            window,
            self.proxy.clone(),
            1,
            &old,
            old.initial_view(),
            features,
        ))
        .unwrap();
        renderer.activate_surface();
        present(&mut renderer);
        let first = corner(&renderer);
        assert_color(first, old.background.unwrap());
        renderer.resize(PhysicalSize::new(800, 600)).unwrap();
        present(&mut renderer);
        assert_eq!(corner(&renderer), first);
        pollster::block_on(renderer.replace_dropped_package(&old, &next)).unwrap();
        present(&mut renderer);
        assert_color(corner(&renderer), next.background.unwrap());
        assert_ne!(corner(&renderer), first);
        renderer.resize(PhysicalSize::new(0, 0)).unwrap();
        assert!(pollster::block_on(renderer.replace_dropped_package(&next, &old)).is_err());
        assert_eq!(renderer.forward_targets.background, next.background);
        renderer.resize(PhysicalSize::new(640, 480)).unwrap();
        present(&mut renderer);
        assert_color(corner(&renderer), next.background.unwrap());
        pollster::block_on(renderer.replace_dropped_package(&next, &old)).unwrap();
        present(&mut renderer);
        assert_eq!(corner(&renderer), first);
        println!(
            "solid environment GPU: authored HDR corner, resize, replacement, zero-surface rejection and LKG restoration passed"
        );
        self.verified = true;
        events.exit();
    }
    fn window_event(
        &mut self,
        _: &ActiveEventLoop,
        _: winit::window::WindowId,
        _: winit::event::WindowEvent,
    ) {
    }
}
#[path = "directional_lighting_tests.rs"]
mod directional_tests;
#[path = "hdr_material_tests.rs"]
mod hdr_material_tests;
#[path = "local_lighting_tests.rs"]
mod local_tests;
#[path = "point_shadow_faces_tests.rs"]
mod point_shadow_faces_tests;
#[path = "spot_shadow_tests.rs"]
mod spot_shadow_tests;
fn verify_profile_transition(
    window: Arc<Window>,
    proxy: EventLoopProxy<GpuEvent>,
    solid: &PlayerContent,
) {
    let legacy = PlayerContent::from_package(
        parse_and_validate_runtime_package(include_bytes!(
            "../../tests/fixtures/runtime-package-v1.json"
        ))
        .unwrap(),
    )
    .unwrap();
    let host = RendererFeatures {
        bloom: deep_engine_native::bloom::BloomSettings::default(),
        fog: FogSettings::exponential(0.02, [0.1, 0.2, 0.3]).unwrap(),
        shadow_probe: false,
        ibl_probe: false,
        telemetry: false,
    };
    let mut active = pollster::block_on(Renderer::new_candidate(
        window.clone(),
        proxy.clone(),
        40,
        &legacy,
        legacy.initial_view(),
        host.for_content(&legacy),
    ))
    .unwrap();
    active.activate_surface();
    present(&mut active);
    assert!(active.bloom.is_some());
    assert!(active.fog.density() > 0.0);
    assert!(active.requires_content_rebuild(solid));
    let previous = corner(&active);
    let mut candidate = pollster::block_on(Renderer::new_candidate(
        window.clone(),
        proxy.clone(),
        41,
        solid,
        solid.initial_view(),
        host.for_content(solid),
    ))
    .unwrap();
    assert!(candidate.bloom.is_none());
    assert_eq!(candidate.fog.density(), 0.0);
    candidate.verify_candidate_frame().unwrap();
    active.resize(PhysicalSize::new(0, 0)).unwrap();
    assert!(!matches!(
        active.present_replacement(&mut candidate),
        RenderOutcome::Presented
    ));
    assert!(active.bloom.is_some());
    assert!(active.forward_targets.background.is_none());
    active.resize(PhysicalSize::new(640, 480)).unwrap();
    present(&mut active);
    assert_eq!(corner(&active), previous);
    assert!(matches!(
        active.present_replacement(&mut candidate),
        RenderOutcome::Presented
    ));
    active = candidate;
    assert_color(corner(&active), solid.background.unwrap());
    assert!(active.requires_content_rebuild(&legacy));
    let mut restored = pollster::block_on(Renderer::new_candidate(
        window,
        proxy,
        42,
        &legacy,
        legacy.initial_view(),
        host.for_content(&legacy),
    ))
    .unwrap();
    assert!(matches!(
        active.present_replacement(&mut restored),
        RenderOutcome::Presented
    ));
    assert!(restored.bloom.is_some());
    assert_eq!(restored.fog, host.fog);
    assert_eq!(corner(&restored), previous);
}
fn present(renderer: &mut Renderer) {
    assert!(matches!(
        renderer.render_internal(true, true),
        RenderOutcome::Presented
    ));
}

/// 与 lit_content 同源构造，但环境 payload 换成 v7 作者雾档；除雾外与
/// `content(背景色)` 的 v1 包逐字节等价，保证像素差异只来自雾。
fn authored_fog_content(density: f64, color: [f64; 3]) -> PlayerContent {
    let mut package: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/runtime-package-v1.json")).unwrap();
    let old = package["entrypoints"]["environment"]
        .as_str()
        .unwrap()
        .to_owned();
    package["payloads"].as_object_mut().unwrap().remove(&old);
    package["entrypoints"]["environment"] = json!("scene.environment");
    let value = json!({"schema":"deep-engine.solid-environment","schemaVersion":7,
        "id":"scene.environment","revision":1,"kind":"solid-background-no-ibl",
        "outputTransform":"native-aces-fog-v7","backgroundSrgb":[0.05,0.05,0.08],
        "fog":{"schemaVersion":1,"kind":"exp2","colorLinearRgb":color,"density":density}});
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

/// 全屏读回 resolved 前向目标（HDR half RGBA），行序 RGB。
fn readback(renderer: &Renderer, size: PhysicalSize<u32>) -> Vec<[f32; 3]> {
    let (width, height) = (size.width.max(1), size.height.max(1));
    let bytes_per_row = (width as usize * 8).div_ceil(256) * 256;
    let buffer = renderer.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("solid environment fog readback"),
        size: (bytes_per_row * height as usize) as u64,
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
                bytes_per_row: Some(bytes_per_row as u32),
                rows_per_image: Some(height),
            },
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );
    renderer.queue.submit([encoder.finish()]);
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
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
    let mut pixels = Vec::with_capacity((width * height) as usize);
    for row in 0..height as usize {
        for column in 0..width as usize {
            let start = row * bytes_per_row + column * 8;
            pixels.push([0, 2, 4].map(|offset| {
                crate::hdr_readback::half_to_f32(u16::from_le_bytes([
                    bytes[start + offset],
                    bytes[start + offset + 1],
                ]))
            }));
        }
    }
    pixels
}

fn distance_to(a: [f32; 3], b: [f32; 3]) -> f32 {
    (0..3)
        .map(|axis| (a[axis] - b[axis]).powi(2))
        .sum::<f32>()
        .sqrt()
}

/// 与雾色距离缩短最多的对照像素，作为最强雾效证据。
struct StrongestFoggedPixel {
    index: usize,
    amount: f32,
    baseline: [f32; 3],
    fogged: [f32; 3],
    drift: f32,
}

#[test]
#[ignore = "real Windows GPU surface, authored exp2 fog assembly and pixel readback"]
fn authored_exp2_fog_assembles_frame_and_shades_forward_pixels() {
    let child = "DEEP_AUTHORED_FOG_CHILD";
    if std::env::var_os(child).is_none() {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "renderer::solid_environment_tests::authored_exp2_fog_assembles_frame_and_shades_forward_pixels",
                "--ignored",
                "--nocapture",
            ])
            .env(child, "1")
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
    let events = builder.build().unwrap();
    let mut probe = FogProbe {
        proxy: events.create_proxy(),
        verified: false,
    };
    events.run_app(&mut probe).unwrap();
    assert!(probe.verified);
}

struct FogProbe {
    proxy: EventLoopProxy<GpuEvent>,
    verified: bool,
}
impl ApplicationHandler<GpuEvent> for FogProbe {
    fn resumed(&mut self, events: &ActiveEventLoop) {
        let window = Arc::new(
            events
                .create_window(
                    crate::app_startup::window_attributes(false)
                        .with_inner_size(PhysicalSize::new(640, 480)),
                )
                .unwrap(),
        );
        const FOG_DENSITY: f64 = 0.35;
        const FOG_COLOR: [f64; 3] = [0.9, 0.45, 0.1];
        let fogged = authored_fog_content(FOG_DENSITY, FOG_COLOR);
        let plain = content([0.05, 0.05, 0.08]);
        let fog = fogged.fog.expect("v7 package carries author fog");
        assert!(fog.is_authored());
        assert_eq!(fog.density(), FOG_DENSITY as f32);
        // 宿主档带 legacy 输出雾：作者雾必须在装配时替换它，而不是叠加。
        let host = RendererFeatures {
            bloom: entry_bloom(&fogged),
            fog: FogSettings::exponential(0.02, [1.0, 0.0, 0.0]).unwrap(),
            shadow_probe: false,
            ibl_probe: false,
            telemetry: false,
        };
        let effective = host.for_content(&fogged);
        assert!(effective.fog.is_authored());
        assert_eq!(effective.fog, fog);
        assert!(!effective.bloom.is_active());
        let mut renderer = pollster::block_on(Renderer::new_candidate(
            window.clone(),
            self.proxy.clone(),
            50,
            &fogged,
            fogged.initial_view(),
            effective,
        ))
        .unwrap();
        renderer.activate_surface();
        assert!(renderer.fog.is_authored());
        assert_eq!(
            renderer.camera_frame_for_test()
                [deep_engine_native::mesh_abi::FRAME_FOG_PROJECTION_ROW],
            [0.1, 100.0, 2.0, 0.0],
            "authored fog projection row must flag exp2 with the real camera range"
        );
        present(&mut renderer);
        // 背景不受作者雾影响（片元 HDR 域合成、混合之前）。
        assert_color(corner(&renderer), fogged.background.unwrap());
        // 全屏读回对照：与无雾 v1 包（同背景同内容）逐像素比，雾只允许把
        // 物体像素拉向雾色（|p'-fog| <= |p-fog|），背景像素逐字节不变。
        let size = PhysicalSize::new(640u32, 480u32);
        let fogged_pixels = readback(&renderer, size);
        let mut plain_renderer = pollster::block_on(Renderer::new_candidate(
            window.clone(),
            self.proxy.clone(),
            51,
            &plain,
            plain.initial_view(),
            RendererFeatures {
                bloom: entry_bloom(&plain),
                fog: FogSettings::DISABLED,
                shadow_probe: false,
                ibl_probe: false,
                telemetry: false,
            },
        ))
        .unwrap();
        // 候选帧只渲染前向目标、不占用窗口 surface（surface 归 fogged renderer）。
        plain_renderer.verify_candidate_frame().unwrap();
        let plain_pixels = readback(&plain_renderer, size);
        let fog_color: [f32; 3] = fog.color();
        let mut changed = 0usize;
        let mut best: Option<StrongestFoggedPixel> = None;
        for (index, fogged_pixel) in fogged_pixels.iter().enumerate() {
            let baseline = plain_pixels[index];
            let drift = distance_to(*fogged_pixel, baseline);
            assert!(
                distance_to(*fogged_pixel, fog_color) <= distance_to(baseline, fog_color) + 1e-4,
                "pixel {index} drifted away from fog color: {fogged_pixel:?} vs {baseline:?}"
            );
            if drift > 1e-4 {
                changed += 1;
                let axis = (0..3)
                    .max_by(|a, b| {
                        (fog_color[*a] - baseline[*a])
                            .abs()
                            .total_cmp(&(fog_color[*b] - baseline[*b]).abs())
                    })
                    .unwrap();
                let amount =
                    (fogged_pixel[axis] - baseline[axis]) / (fog_color[axis] - baseline[axis]);
                if best.as_ref().is_none_or(|best| amount > best.amount) {
                    best = Some(StrongestFoggedPixel {
                        index,
                        amount,
                        baseline,
                        fogged: *fogged_pixel,
                        drift,
                    });
                }
            }
        }
        assert!(changed > 0, "authored fog changed no pixel across 640x480");
        let StrongestFoggedPixel {
            index,
            amount,
            baseline,
            fogged: fogged_pixel,
            drift,
        } = best.unwrap();
        let x = (index as u32) % size.width;
        let y = (index as u32) / size.width;
        println!(
            "fog GPU: changed={changed}/{} pixels; strongest pixel ({x},{y}) baseline={baseline:?} fogged={fogged_pixel:?} fogColor={fog_color:?} amount={amount:.4} drift={drift:.4}",
            fogged_pixels.len()
        );
        // 宿主雾 DISABLED 的 plain 渲染器：作者雾差异必须走整重建，预览路径拒绝。
        assert!(plain_renderer.requires_content_rebuild(&fogged));
        assert!(!renderer.requires_content_rebuild(&fogged));
        assert!(
            pollster::block_on(plain_renderer.replace_dropped_package(&plain, &fogged)).is_err(),
            "authored fog change must require a full renderer transaction"
        );
        println!(
            "authored fog GPU: density={FOG_DENSITY} color={FOG_COLOR:?} projection row=[0.1,100,2,0], background untouched, rebuild guard holds"
        );
        self.verified = true;
        events.exit();
    }
    fn window_event(
        &mut self,
        _: &ActiveEventLoop,
        _: winit::window::WindowId,
        _: winit::event::WindowEvent,
    ) {
    }
}

fn assert_color(actual: [f32; 3], expected: [f64; 3]) {
    for axis in 0..3 {
        assert!(
            (f64::from(actual[axis]) - expected[axis]).abs() < 0.001,
            "{actual:?} != {expected:?}"
        );
    }
}
fn corner(renderer: &Renderer) -> [f32; 3] {
    let buffer = renderer.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("solid background corner"),
        size: 256,
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
                bytes_per_row: Some(256),
                rows_per_image: Some(1),
            },
        },
        wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: 1,
        },
    );
    renderer.queue.submit([encoder.finish()]);
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
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
    [0, 2, 4]
        .map(|i| crate::hdr_readback::half_to_f32(u16::from_le_bytes([bytes[i], bytes[i + 1]])))
}
