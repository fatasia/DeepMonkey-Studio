//! C3 切片三(2026-09-19)真实 Renderer 接线验证(真实窗口 + 真实 GPU):
//! receive-shadow-only → 单行词 31 原位写(阴影版本不失效);cast 阴影标志
//! 与 LOD-only → 资源复用刷新 staging(Replace payload,零资源重上传);
//! 多维度同帧/合同外变化 → 全量路径回落。子进程模式沿用
//! material_uniform_fastpath_gpu_tests(需要真实 Windows GPU surface)。

use super::scene_update_stage::StagedRenderPacketUpdate;
use super::*;
use crate::events::GpuEvent;
use winit::{
    application::ApplicationHandler,
    event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy},
    platform::windows::EventLoopBuilderExtWindows,
};

const TEST: &str = "renderer::scene_incremental_fastpath_gpu_tests::scene_incremental_fastpaths_route_and_publish";

#[test]
#[ignore = "requires a real Windows GPU surface"]
fn scene_incremental_fastpaths_route_and_publish() {
    const CHILD: &str = "DEEP_SCENE_INCREMENTAL_CHILD";
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

fn receive_off(packet: &deep_engine_native::contract::RenderPacket) -> deep_engine_native::contract::RenderPacket {
    let mut next = packet.clone();
    next.instances[0].receive_shadow = Some(false);
    next
}

fn cast_off(packet: &deep_engine_native::contract::RenderPacket) -> deep_engine_native::contract::RenderPacket {
    let mut next = packet.clone();
    next.instances[0].cast_shadow = Some(false);
    next
}

fn content_of(packet: deep_engine_native::contract::RenderPacket) -> PlayerContent {
    PlayerContent::from_packet(packet, None)
}


/// 枚举无 Debug(GpuScene 等 GPU 资源不可格式化);只输出变体名。
fn variant_name(staged: &StagedRenderPacketUpdate) -> &'static str {
    match staged {
        StagedRenderPacketUpdate::Noop => "Noop",
        StagedRenderPacketUpdate::Replace(_) => "Replace",
        StagedRenderPacketUpdate::TransformRefresh(_) => "TransformRefresh",
        StagedRenderPacketUpdate::MaterialUniformRefresh(_) => "MaterialUniformRefresh",
        StagedRenderPacketUpdate::ShadowFlagRefresh(_) => "ShadowFlagRefresh",
    }
}

impl ApplicationHandler<GpuEvent> for Probe {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        let window = Arc::new(
            event_loop
                .create_window(crate::app_startup::window_attributes(true))
                .unwrap(),
        );
        let content = load_textured_with_lod_target();
        let features = RendererFeatures {
            bloom: deep_engine_native::bloom::BloomSettings::DISABLED,
            fog: deep_engine_native::fog::FogSettings::DISABLED,
            shadow_probe: false,
            ibl_probe: false,
            telemetry: false,
        };
        let mut renderer = pollster::block_on(Renderer::new_candidate(
            window,
            self.proxy.clone(),
            1,
            &content,
            content.initial_view(),
            features,
        ))
        .unwrap();
        renderer.verify_candidate_frame().unwrap();

        let mut current = content.packet().clone();

        // 1) receive-shadow-only:单行词 31 原位写;caster 集合不变 → 阴影
        //    版本必须保持;rows 与 recompute_surface_flags 逐位一致。
        let shadow_before = renderer.scene_update_evidence().shadow_version;
        let variant = receive_off(&current);
        let staged = pollster::block_on(renderer.stage_render_packet_update(
            &current,
            &content_of(variant.clone()),
        ))
        .unwrap();
        let refresh = match &staged {
            StagedRenderPacketUpdate::ShadowFlagRefresh(refresh) => refresh,
            other => panic!("expected ShadowFlagRefresh, got {}", variant_name(other)),
        };
        assert_eq!(refresh.rows.len(), 1);
        assert_eq!(refresh.rows[0].0, 0);
        assert_eq!(
            refresh.rows[0].1,
            deep_engine_native::scene::recompute_surface_flags(
                &variant.materials
                    .iter()
                    .find(|material| material.id == variant.instances[0].material)
                    .unwrap(),
                Some(false),
            )
        );
        renderer.publish_render_packet_update(staged).unwrap();
        let shadow_after = renderer.scene_update_evidence().shadow_version;
        assert_eq!(
            shadow_after.scene, shadow_before.scene,
            "receive-only change must not invalidate the shadow scene version"
        );
        let restaged = pollster::block_on(renderer.stage_render_packet_update(
            &variant,
            &content_of(variant.clone()),
        ))
        .unwrap();
        assert!(matches!(restaged, StagedRenderPacketUpdate::Noop));
        current = variant;

        // 2) cast 阴影标志:批键变化 → 资源复用刷新 staging(Replace payload,
        //    零几何/纹理/材质上传);阴影版本必须失效。
        let shadow_before = renderer.scene_update_evidence().shadow_version;
        let variant = cast_off(&current);
        let staged = pollster::block_on(renderer.stage_render_packet_update(
            &current,
            &content_of(variant.clone()),
        ))
        .unwrap();
        let payload = match &staged {
            StagedRenderPacketUpdate::Replace(payload) => payload,
            other => panic!("expected Replace (resource-reuse refresh), got {}", variant_name(other)),
        };
        assert!(payload.staged_via_resource_reuse);
        let metrics = renderer.publish_render_packet_update(staged).unwrap();
        assert_eq!(metrics.geometry_uploads, 0);
        assert_eq!(metrics.texture_uploads, 0);
        assert_eq!(metrics.material_uploads, 0);
        assert_ne!(
            renderer.scene_update_evidence().shadow_version.scene,
            shadow_before.scene,
            "cast-flag change must invalidate the shadow scene version"
        );
        let restaged = pollster::block_on(renderer.stage_render_packet_update(
            &variant,
            &content_of(variant.clone()),
        ))
        .unwrap();
        assert!(matches!(restaged, StagedRenderPacketUpdate::Noop));
        current = variant;

        // 3) LOD-only:同一刷新通道(重 prepare + 重 culling/lod,资源全复用)。
        let variant =
            crate::gpu_scene_cache_test_support::with_lod_profile(&current);
        let staged = pollster::block_on(renderer.stage_render_packet_update(
            &current,
            &content_of(variant.clone()),
        ))
        .unwrap();
        let payload = match &staged {
            StagedRenderPacketUpdate::Replace(payload) => payload,
            other => panic!("expected Replace (resource-reuse refresh), got {}", variant_name(other)),
        };
        assert!(payload.staged_via_resource_reuse);
        let metrics = renderer.publish_render_packet_update(staged).unwrap();
        assert_eq!(metrics.geometry_uploads, 0);
        assert_eq!(metrics.texture_uploads, 0);
        assert_eq!(metrics.material_uploads, 0);
        let restaged = pollster::block_on(renderer.stage_render_packet_update(
            &variant,
            &content_of(variant.clone()),
        ))
        .unwrap();
        assert!(matches!(restaged, StagedRenderPacketUpdate::Noop));
        current = variant;

        // 4) 多维度同帧(receive + transform)保守归 Structural → 全量路径。
        let mut mixed = current.clone();
        mixed.instances[0].receive_shadow = Some(true);
        mixed.instances[0].transform[12] += 0.1;
        let staged = pollster::block_on(renderer.stage_render_packet_update(
            &current,
            &content_of(mixed.clone()),
        ))
        .unwrap();
        let payload = match &staged {
            StagedRenderPacketUpdate::Replace(payload) => payload,
            other => panic!("expected Replace (full path), got {}", variant_name(other)),
        };
        assert!(!payload.staged_via_resource_reuse);
        renderer.publish_render_packet_update(staged).unwrap();

        // 5) 帧仍可呈现:增量状态(词 31 原位写 + 刷新后的 culling/lod/阴影)
        //    在真实渲染管线下自洽。
        renderer.verify_candidate_frame().unwrap();

        println!(
            "C3 scene incremental fastpaths verified: receive-only word write (shadow kept) → cast refresh reuse → lod refresh reuse → mixed fallback → frame presents"
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

fn load_textured_with_lod_target() -> PlayerContent {
    let (packet, _) = deep_engine_native::contract::load_and_validate(
        deep_engine_native::contract::default_textured_fixture_path(),
    )
    .unwrap();
    // 预置未引用的 LOD 目标几何:LOD profile 需要三角数严格递减的两级,
    // 内置夹具只有单几何;先补目标,LOD-only 变体就不再动几何列表。
    PlayerContent::from_packet(crate::gpu_scene_cache_test_support::with_lod_target(&packet), None)
}
