use super::*;
#[path = "package_shader_fixture.rs"]
mod shader_fixture;
use crate::app::{NativeAppSetup, watch_thread::WatchThread};
use crate::{player_content::PlayerContent, renderer::RendererFeatures};
use deep_engine_native::runtime_package::{
    parse_and_validate_runtime_package, plan_runtime_package_resource_diff, runtime_content_sha256,
    runtime_package_sha256,
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use winit::{
    application::ApplicationHandler,
    event_loop::{ActiveEventLoop, EventLoop},
    platform::windows::EventLoopBuilderExtWindows,
};

#[test]
#[ignore = "requires a real Windows GPU surface"]
fn scene_package_publishes_after_present() {
    run(false);
}

#[test]
#[ignore = "requires a real Windows GPU surface and shader pipelines"]
fn shader_package_publishes_after_present() {
    run(true);
}

fn run(shader: bool) {
    const CHILD: &str = "DEEP_PACKAGE_PRESENT_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let name = if shader {
            "shader_package_publishes_after_present"
        } else {
            "scene_package_publishes_after_present"
        };
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                &format!("app::package_live::present_tests::{name}"),
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
    let mut builder = EventLoop::<GpuEvent>::with_user_event();
    builder.with_any_thread(true);
    let event_loop = builder.build().unwrap();
    let content = content(shader, 0);
    let published = Arc::new(RwLock::new(content.runtime_package().unwrap().clone()));
    let mailbox = LatestMailbox::default();
    let transport = PackageLiveTransport {
        _watcher: WatchThread::spawn(|_| {}),
        mailbox: mailbox.clone(),
        published: published.clone(),
        retry: None,
    };
    let app = NativeApp::new(
        content,
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
            package_live_transport: Some(transport),
            telemetry_report: false,
            selection_probe: false,
            section_probe: false,
            chart_key_probe: false,
        },
    );
    let mut probe = Probe {
        app,
        mailbox,
        published,
        shader,
        verified: false,
    };
    event_loop.run_app(&mut probe).unwrap();
    assert!(probe.verified);
}

struct Probe {
    app: NativeApp,
    mailbox: LatestMailbox<WatchedPackage>,
    published: Arc<RwLock<RuntimePackageSnapshot>>,
    shader: bool,
    verified: bool,
}
impl ApplicationHandler<GpuEvent> for Probe {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        self.app.resumed(event_loop);
        let old_hash = self.published.read().unwrap().package_hash.clone();
        let size = self.app.window.as_ref().unwrap().inner_size();
        let old_id = self.app.renderer.as_ref().unwrap().id();
        let before = self.app.renderer.as_ref().unwrap().scene_update_evidence();
        self.app
            .renderer
            .as_mut()
            .unwrap()
            .resize(winit::dpi::PhysicalSize::new(0, 0))
            .unwrap();
        for generation in 1..=2 {
            let next = content(self.shader, generation);
            let snapshot = next.runtime_package().unwrap().clone();
            let plan = plan_runtime_package_resource_diff(
                &self.published.read().unwrap().resource_index,
                &snapshot.resource_index,
            )
            .unwrap();
            assert_eq!(plan.entries.len(), 1);
            assert_eq!(
                plan.entries[0].kind,
                if self.shader {
                    deep_engine_native::runtime_package::RuntimeResourceKind::ShaderPackage
                } else {
                    deep_engine_native::runtime_package::RuntimeResourceKind::RenderPacket
                }
            );
            self.mailbox.push(
                generation,
                WatchedPackage {
                    content: Box::new(next),
                    snapshot,
                    plan,
                },
            );
            apply_latest(&mut self.app);
            assert_eq!(
                self.app
                    .content
                    .active()
                    .runtime_package()
                    .unwrap()
                    .package_hash,
                old_hash
            );
            assert_eq!(self.published.read().unwrap().package_hash, old_hash);
            assert_eq!(self.app.packet_coalescer.published(), 0);
            assert_eq!(
                self.app
                    .renderer
                    .as_ref()
                    .unwrap()
                    .scene_update_evidence()
                    .cache_live,
                before.cache_live
            );
            assert!(matches!(
                self.app
                    .package_live_transport
                    .as_ref()
                    .unwrap()
                    .retry
                    .as_ref()
                    .unwrap()
                    .3,
                RetryKind::Scene
            ));
        }
        assert!(retry(&mut self.app, event_loop, Instant::now()));
        self.app.renderer.as_mut().unwrap().resize(size).unwrap();
        for _ in 0..30 {
            if !retry(
                &mut self.app,
                event_loop,
                Instant::now() + Duration::from_secs(1),
            ) {
                break;
            }
        }
        assert_eq!(self.app.packet_coalescer.published(), 2);
        assert_eq!(self.app.renderer.as_ref().unwrap().id(), old_id);
        assert_eq!(
            self.published.read().unwrap().package_hash,
            content(self.shader, 2)
                .runtime_package()
                .unwrap()
                .package_hash
        );
        assert_eq!(
            self.app
                .content
                .active()
                .runtime_package()
                .unwrap()
                .package_hash,
            self.published.read().unwrap().package_hash
        );
        assert!(
            self.app
                .package_live_transport
                .as_ref()
                .unwrap()
                .retry
                .is_none()
        );
        println!(
            "runtime package present barrier: shader={} skipped generations 1/2 retained snapshots; generation 2 presented with renderer reused",
            self.shader
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

fn content(shader: bool, revision: u64) -> PlayerContent {
    let bytes: &[u8] = if shader {
        include_bytes!("../../tests/fixtures/runtime-package-shader-v2.json")
    } else {
        include_bytes!("../../tests/fixtures/runtime-package-v1.json")
    };
    let mut value: Value = serde_json::from_slice(bytes).unwrap();
    if revision > 0 {
        let id = if shader {
            value["entrypoints"]["shaderPackages"][0]
                .as_str()
                .unwrap()
                .to_owned()
        } else {
            value["entrypoints"]["renderPacket"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        if shader {
            shader_fixture::dim_color(&mut value["payloads"][&id], revision);
        } else {
            value["payloads"][&id]["instances"][0]["transform"][12] = json!(revision as f64);
        }
        let hash = runtime_content_sha256(&value["payloads"][&id]);
        for resource in value["resources"].as_array_mut().unwrap() {
            if resource["id"] == id {
                resource["contentHash"]["value"] = json!(hash);
                resource["revision"] = json!(resource["revision"].as_u64().unwrap() + revision);
            }
        }
        value["packageHash"]["value"] = json!(runtime_package_sha256(&value).unwrap());
    }
    PlayerContent::from_package(
        parse_and_validate_runtime_package(&serde_json::to_vec(&value).unwrap()).unwrap(),
    )
    .unwrap()
}
