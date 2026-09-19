use super::*;
use crate::{app::NativeAppSetup, events::GpuEvent};
use winit::{
    application::ApplicationHandler,
    event_loop::{ActiveEventLoop, EventLoop},
    platform::windows::EventLoopBuilderExtWindows,
};

#[test]
#[ignore = "requires a real Windows UIA client and GPU window"]
fn product_window_publishes_and_updates_chart_semantics() {
    const CHILD: &str = "DEEP_PRODUCT_UIA_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "app::accessibility::tests::product_window_publishes_and_updates_chart_semantics",
                "--ignored",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        println!("{}", String::from_utf8_lossy(&output.stdout));
        return;
    }
    let mut ir = deep_engine_native::chart::parse_chart_ir(include_bytes!(
        "../../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    ir.legend.visible = true;
    let mut builder = EventLoop::<GpuEvent>::with_user_event();
    builder.with_any_thread(true);
    let event_loop = builder.build().unwrap();
    let app = NativeApp::new(
        crate::player_content::PlayerContent::from_chart(ir).unwrap(),
        event_loop.create_proxy(),
        NativeAppSetup {
            dynamic_playback: None,
            state_ops: None,
            smoke_frame: true,
            features: crate::renderer::RendererFeatures {
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
            telemetry_prepare_replay: false,
            telemetry_report: false,
            selection_probe: false,
            section_probe: false,
            chart_key_probe: false,
        },
    );
    let mut probe = Probe {
        app,
        verified: false,
        phase: 0,
        receiver: None,
        deadline: std::time::Instant::now() + std::time::Duration::from_secs(20),
    };
    event_loop.run_app(&mut probe).unwrap();
    assert!(probe.verified);
}

struct Probe {
    app: NativeApp,
    verified: bool,
    phase: u8,
    receiver: Option<std::sync::mpsc::Receiver<Vec<String>>>,
    deadline: std::time::Instant,
}
impl Probe {
    fn query(&mut self) {
        let window = self.app.window.as_ref().unwrap();
        let RawWindowHandle::Win32(handle) = window.window_handle().unwrap().as_raw() else {
            panic!("Win32")
        };
        let hwnd = handle.hwnd.get();
        let proxy = self.app.proxy.clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        self.receiver = Some(receiver);
        std::thread::spawn(move || {
            sender.send(walk(hwnd)).unwrap();
            assert!(proxy.send_event(GpuEvent::LiveProbeCheckpoint).is_ok());
        });
    }
}
impl ApplicationHandler<GpuEvent> for Probe {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        self.app.resumed(event_loop);
        assert!(
            self.app
                .accessibility
                .as_ref()
                .unwrap()
                .bridge
                .is_attached()
        );
        self.query();
    }
    fn user_event(&mut self, event_loop: &ActiveEventLoop, _: GpuEvent) {
        let Ok(names) = self.receiver.as_ref().unwrap().try_recv() else {
            return;
        };
        match self.phase {
            0 => {
                assert!(names.iter().any(|name| name == "Deep Engine"));
                let legend = super::super::window_events::legend_snapshot(&self.app).unwrap();
                let first = &legend.items[0];
                assert!(
                    names
                        .iter()
                        .any(|name| name.contains(&first.label) && name.contains("visible"))
                );
                let deep_engine_native::native_ui::LegendCommand::Toggle(series_id) =
                    first.command.clone()
                else {
                    panic!("series item")
                };
                super::super::chart::update(&mut self.app, |chart| {
                    chart.dispatch(deep_engine_native::chart::ChartAction::ToggleLegend {
                        series_id,
                    })
                });
                self.app.about_to_wait(event_loop);
            }
            1 => {
                let legend = super::super::window_events::legend_snapshot(&self.app).unwrap();
                assert!(
                    names.iter().any(
                        |name| name.contains(&legend.items[0].label) && name.contains("hidden")
                    )
                );
                let loaded =
                    deep_engine_native::runtime_package::parse_and_validate_runtime_package(
                        include_bytes!("../../tests/fixtures/runtime-package-v1.json"),
                    )
                    .unwrap();
                self.app.content.publish(
                    1,
                    crate::player_content::PlayerContent::from_package(loaded).unwrap(),
                );
                self.app.about_to_wait(event_loop);
            }
            2 => {
                assert!(!names.iter().any(|name| name == "chart legend"));
                annotation_events(&mut self.app, event_loop);
                self.app.accessibility.take();
            }
            3 => {
                assert!(!names.iter().any(|name| name == "Deep Engine"));
                println!(
                    "product winit UIA: attached; real client read chart/legend; toggle updated hidden state; package replacement removed stale nodes; detached"
                );
                self.verified = true;
                event_loop.exit();
                return;
            }
            _ => unreachable!(),
        }
        self.phase += 1;
        self.query();
    }
    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        assert!(
            std::time::Instant::now() < self.deadline,
            "UIA query timed out in phase {}",
            self.phase
        );
        event_loop.set_control_flow(winit::event_loop::ControlFlow::WaitUntil(self.deadline));
    }
    fn window_event(
        &mut self,
        _: &ActiveEventLoop,
        _: winit::window::WindowId,
        _: winit::event::WindowEvent,
    ) {
    }
}

fn annotation_events(app: &mut NativeApp, event_loop: &ActiveEventLoop) {
    use winit::{
        event::{Ime, WindowEvent},
        keyboard::KeyCode,
    };
    let id = app.window.as_ref().unwrap().id();
    app.state.selected = Some(app.content.active().packet().instances[0].id.clone());
    app.state.selected_point = Some([0.0; 3]);
    assert!(super::super::annotations::key(app, KeyCode::KeyA, None));
    app.window_event(
        event_loop,
        id,
        WindowEvent::Ime(Ime::Preedit("zhong".into(), None)),
    );
    assert_eq!(app.state.annotations.draft.as_ref().unwrap().label, "");
    app.window_event(
        event_loop,
        id,
        WindowEvent::Ime(Ime::Commit("中文e\u{301}👨‍👩‍👧‍👦".into())),
    );
    assert_eq!(
        app.state.annotations.draft.as_ref().unwrap().label,
        "中文e\u{301}👨‍👩‍👧‍👦"
    );
    assert!(super::super::annotations::key(
        app,
        KeyCode::Backspace,
        None
    ));
    assert_eq!(
        app.state.annotations.draft.as_ref().unwrap().label,
        "中文e\u{301}"
    );
    app.window_event(
        event_loop,
        id,
        WindowEvent::Ime(Ime::Preedit("uncommitted".into(), None)),
    );
    app.window_event(event_loop, id, WindowEvent::Focused(false));
    assert_eq!(app.state.annotations.preedit, "");
    app.window_event(event_loop, id, WindowEvent::Ime(Ime::Commit("迟到".into())));
    assert_eq!(
        app.state.annotations.draft.as_ref().unwrap().label,
        "中文e\u{301}"
    );
    app.window_event(event_loop, id, WindowEvent::Focused(true));
    app.window_event(
        event_loop,
        id,
        WindowEvent::Ime(Ime::Commit(" שלום".into())),
    );
    assert_eq!(
        app.state.annotations.draft.as_ref().unwrap().label,
        "中文e\u{301} שלום"
    );
    assert!(super::super::annotations::key(app, KeyCode::Escape, None));
    assert!(app.state.annotations.draft.is_none());
    assert!(app.annotation_editor.is_none());
    println!(
        "product winit annotation IME: composition/commit/grapheme backspace/blur/late commit/refocus/cancel verified"
    );
}

fn walk(hwnd: isize) -> Vec<String> {
    use windows::Win32::{System::Com::*, UI::Accessibility::*};
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap();
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).unwrap();
        let element = automation
            .ElementFromHandle(windows::Win32::Foundation::HWND(hwnd as *mut _))
            .unwrap();
        let found = element
            .FindAll(
                TreeScope_Subtree,
                &automation.CreateTrueCondition().unwrap(),
            )
            .unwrap();
        let names = (0..found.Length().unwrap())
            .map(|index| {
                found
                    .GetElement(index)
                    .unwrap()
                    .CurrentName()
                    .unwrap()
                    .to_string()
            })
            .collect();
        drop(found);
        drop(element);
        drop(automation);
        CoUninitialize();
        names
    }
}
