//! P1-01 resize→layout_revision 接线:单调推进、同尺寸去重、非 resize 路径不动版本。
//! headless App(window/renderer 为 None)纯 CPU 运行,不依赖 GPU surface。
//! 断言合并为单个 #[test]:Windows winit EventLoop 进程内不可重建(先例
//! package_present_tests 为此才用子进程隔离),此处一个 loop 跑完全部断言。
//! GPU 窗口端到端失败注入沿用 P0-05 矩阵口径,不在此伪装覆盖。
use super::*;
use crate::app::NativeAppSetup;
use crate::renderer::RendererFeatures;
use deep_engine_native::chart::ChartAction;
use winit::{event_loop::EventLoop, platform::windows::EventLoopBuilderExtWindows};

#[test]
fn resize_wiring_advances_layout_revision_and_excludes_non_resize_paths() {
    let ir = deep_engine_native::chart::parse_chart_ir(include_bytes!(
        "../../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    let mut builder = EventLoop::<GpuEvent>::with_user_event();
    builder.with_any_thread(true);
    let event_loop = builder.build().unwrap();
    let mut app = NativeApp::new(
        crate::player_content::PlayerContent::from_chart(ir).unwrap(),
        event_loop.create_proxy(),
        NativeAppSetup {
            smoke_frame: false,
            features: RendererFeatures {
                bloom: Default::default(),
                fog: deep_engine_native::fog::FogSettings::DISABLED,
                shadow_probe: false,
                ibl_probe: false,
                telemetry: false,
            },
            shadow_update_probe: None,
            packet_live_probe: None,
            packet_live_transport: None,
            package_live_transport: None,
            telemetry_report: false,
            selection_probe: false,
            section_probe: false,
            chart_key_probe: false,
        },
    );

    // resize 单调推进 + 同尺寸去重。
    let before = app.content.active().epoch.layout_revision;
    app.resize(winit::dpi::PhysicalSize::new(1280, 720));
    assert_eq!(
        app.content.active().epoch.layout_revision,
        before + 1,
        "首次物理尺寸确立即布局变化,必须推进"
    );
    // 同尺寸重复事件(ScaleFactorChanged 回环、平台重发)不得 bump。
    app.resize(winit::dpi::PhysicalSize::new(1280, 720));
    assert_eq!(
        app.content.active().epoch.layout_revision,
        before + 1,
        "同尺寸重复事件不得推进 layout_revision"
    );
    app.resize(winit::dpi::PhysicalSize::new(800, 600));
    assert_eq!(
        app.content.active().epoch.layout_revision,
        before + 2,
        "尺寸再次变化必须单调推进"
    );

    // 非 resize 路径:交互动作走 chart::update,要么无内容变化(Ok(false) 直通),
    // 要么因 renderer 未就绪失败返回——两条分支都不得触碰 layout_revision。
    let after_resize = app.content.active().epoch.layout_revision;
    crate::app::chart::update(&mut app, |chart| chart.dispatch(ChartAction::HoverEnd));
    crate::app::chart::update(&mut app, |chart| {
        chart.dispatch(ChartAction::ToggleLegend {
            series_id: "bar".into(),
        })
    });
    assert_eq!(
        app.content.active().epoch.layout_revision,
        after_resize,
        "非 resize 的 chart 动作不得推进 layout_revision"
    );
}
