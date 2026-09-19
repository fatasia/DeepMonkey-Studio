//! C3 uniform-only 材质快路径的真实 Renderer 接线验证(真实窗口 + 真实
//! GPU):stage 分类 → MaterialUniformRefresh rows → publish 原位写缓冲 →
//! 内容键推进 → 阴影版本失效 → 各类结构/实例词变化回落全量路径。
//! 摄动一律落在材质 uniform(纹理变换块)内;base_color/metallic 走实例
//! 缓冲词 24..36,由 instance_material_words_unchanged 守卫单独拦截。
//! 子进程模式沿用 content_profile_gpu_tests(需要真实 Windows GPU surface)。

use super::scene_update_stage::StagedRenderPacketUpdate;
use super::*;
use crate::events::GpuEvent;
use winit::{
    application::ApplicationHandler,
    event_loop::{ActiveEventLoop, EventLoop},
    platform::windows::EventLoopBuilderExtWindows,
};

const TEST: &str = "renderer::material_uniform_fastpath_gpu_tests::uniform_only_material_update_takes_the_incremental_path";

#[test]
#[ignore = "requires a real Windows GPU surface"]
fn uniform_only_material_update_takes_the_incremental_path() {
    const CHILD: &str = "DEEP_MATERIAL_FASTPATH_CHILD";
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
                .create_window(crate::app_startup::window_attributes(true))
                .unwrap(),
        );
        // 带纹理 fixture:材质 uniform(纹理变换块)才有可摄动的数值。
        let content = load_textured();
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

        let previous = content.packet().clone();
        assert!(!previous.materials.is_empty());
        assert!(previous.materials[0].base_color_texture.is_some());
        let variant = with_base_color_offset(&previous, 0.375);
        let variant_content = PlayerContent::from_packet(variant.clone(), None);

        // 1) uv 数值变化必须被分类为 MaterialUniformRefresh,rows 与
        //    prepare_material_uniform 的输出逐位一致。
        let shadow_before = renderer.scene_update_evidence().shadow_version;
        let staged =
            pollster::block_on(renderer.stage_render_packet_update(&previous, &variant_content))
                .unwrap();
        let refresh = match &staged {
            StagedRenderPacketUpdate::MaterialUniformRefresh(refresh) => refresh,
            StagedRenderPacketUpdate::Noop => {
                panic!("expected MaterialUniformRefresh, got Noop")
            }
            StagedRenderPacketUpdate::TransformRefresh(_) => {
                panic!("expected MaterialUniformRefresh, got TransformRefresh")
            }
            StagedRenderPacketUpdate::Replace(_) => {
                panic!("expected MaterialUniformRefresh, got Replace")
            }
        };
        assert_eq!(refresh.rows.len(), 1);
        assert_eq!(refresh.rows[0].0, 0);
        assert_eq!(
            refresh.rows[0].1,
            deep_engine_native::pbr_texture::prepare_material_uniform(&variant.materials[0])
                .unwrap()
        );
        assert_eq!(
            refresh.scene_content_key,
            variant_content.scene_content_key()
        );

        // 2) publish 成功且阴影场景版本失效。
        renderer.publish_render_packet_update(staged).unwrap();
        let shadow_after = renderer.scene_update_evidence().shadow_version;
        assert_ne!(shadow_after.scene, shadow_before.scene);

        // 3) 内容键已推进:同一对 packet 再次 stage 必须是 Noop。
        let restaged =
            pollster::block_on(renderer.stage_render_packet_update(&previous, &variant_content))
                .unwrap();
        assert!(matches!(restaged, StagedRenderPacketUpdate::Noop));

        // 4) 反向(变体→原始)再次走快路径。
        let back_content = PlayerContent::from_packet(previous.clone(), None);
        let staged_back =
            pollster::block_on(renderer.stage_render_packet_update(&variant, &back_content))
                .unwrap();
        assert!(matches!(
            staged_back,
            StagedRenderPacketUpdate::MaterialUniformRefresh(_)
        ));
        renderer.publish_render_packet_update(staged_back).unwrap();

        // 5) uv 变化 + metallic 同帧:uniform 分类 UniformOnly,但 metallic
        //    走实例缓冲词,instance_material_words_unchanged 守卫必须回落
        //    全量 Replace(否则实例词更新会被静默丢失)。
        let mut words_moved = variant.clone();
        words_moved.materials[0].metallic = 1.0 - words_moved.materials[0].metallic;
        let words_content = PlayerContent::from_packet(words_moved, None);
        let staged_words =
            pollster::block_on(renderer.stage_render_packet_update(&previous, &words_content))
                .unwrap();
        assert!(matches!(staged_words, StagedRenderPacketUpdate::Replace(_)));
        renderer.publish_render_packet_update(staged_words).unwrap();

        // 6) transform 与 uv 同帧:transform 快路径不得吞掉材质变化,必须
        //    回落全量 Replace。
        let mut both = previous.clone();
        both.instances[0].transform[12] += 0.1;
        both = with_base_color_offset(&both, 0.25);
        let both_content = PlayerContent::from_packet(both, None);
        let staged_both =
            pollster::block_on(renderer.stage_render_packet_update(&previous, &both_content))
                .unwrap();
        assert!(matches!(staged_both, StagedRenderPacketUpdate::Replace(_)));
        renderer.publish_render_packet_update(staged_both).unwrap();

        // 7) 实例材质引用变化(实例 diff Structural)必须回落全量 Replace。
        let mut swapped = previous.clone();
        swapped.materials[0].id = "rematerialized-pbr".into();
        for instance in swapped.instances.iter_mut() {
            instance.material = swapped.materials[0].id.clone();
        }
        let swapped_content = PlayerContent::from_packet(swapped, None);
        let staged_swap =
            pollster::block_on(renderer.stage_render_packet_update(&previous, &swapped_content))
                .unwrap();
        assert!(matches!(staged_swap, StagedRenderPacketUpdate::Replace(_)));
        renderer.publish_render_packet_update(staged_swap).unwrap();

        // 8) 纹理引用解析失败(合同之外)必须回落全量路径并由全量校验呈现
        //    错误,而不是快路径静默通过。
        let mut broken = previous.clone();
        broken.materials[0].base_color_texture = Some(deep_engine_native::contract::TextureSlot {
            texture: "texture/does-not-exist".into(),
            tex_coord: None,
            offset: None,
            scale: None,
            rotation: None,
        });
        let broken_content = PlayerContent::from_packet(broken, None);
        assert!(
            pollster::block_on(renderer.stage_render_packet_update(&previous, &broken_content),)
                .is_err()
        );

        println!(
            "C3 material fastpath verified: refresh→publish→Noop→reverse refresh→words-guard/transform/instance fallbacks→missing-texture error"
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

/// 把第一个材质的 baseColor uv offset x 分量设为 `x`(无 offset 视为 0)。
fn with_base_color_offset(
    packet: &deep_engine_native::contract::RenderPacket,
    x: f32,
) -> deep_engine_native::contract::RenderPacket {
    let mut next = packet.clone();
    let slot = next.materials[0].base_color_texture.as_mut().unwrap();
    let y = slot.offset.unwrap_or([0.0, 0.0])[1];
    slot.offset = Some([x, y]);
    next
}

fn load_textured() -> PlayerContent {
    let (packet, _) = deep_engine_native::contract::load_and_validate(
        deep_engine_native::contract::default_textured_fixture_path(),
    )
    .unwrap();
    PlayerContent::from_packet(packet, None)
}
