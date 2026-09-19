use super::*;
#[path = "package_environment_fixture.rs"]
mod environment_fixture;
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
    run(false, false);
}

#[test]
#[ignore = "requires a real Windows GPU surface and shader pipelines"]
fn shader_package_publishes_after_present() {
    run(true, false);
}

#[test]
#[ignore = "requires a real Windows GPU surface and full renderer replacement"]
fn full_package_publishes_after_present() {
    run(false, true);
}

fn run(shader: bool, full: bool) {
    const CHILD: &str = "DEEP_PACKAGE_PRESENT_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let name = if full {
            "full_package_publishes_after_present"
        } else if shader {
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
    let content = fixture(shader, full, 0);
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
            dynamic_playback: None,
            state_ops: None,
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
            telemetry_prepare_replay: None,
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
        full,
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
    full: bool,
    verified: bool,
}
impl ApplicationHandler<GpuEvent> for Probe {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        self.app.resumed(event_loop);
        let old_hash = self.published.read().unwrap().package_hash.clone();
        let size = self.app.window.as_ref().unwrap().inner_size();
        let old_id = self.app.renderer.as_ref().unwrap().id();
        let old_environment = self
            .app
            .renderer
            .as_ref()
            .unwrap()
            .ibl_summary()
            .0
            .to_owned();
        let next_id = self.app.next_renderer_id;
        let before = self.app.renderer.as_ref().unwrap().scene_update_evidence();
        self.app
            .renderer
            .as_mut()
            .unwrap()
            .resize(winit::dpi::PhysicalSize::new(0, 0))
            .unwrap();
        for generation in 1..=2 {
            let next = fixture(self.shader, self.full, generation);
            let snapshot = next.runtime_package().unwrap().clone();
            let plan = plan_runtime_package_resource_diff(
                &self.published.read().unwrap().resource_index,
                &snapshot.resource_index,
            )
            .unwrap();
            if !self.full {
                assert_eq!(plan.entries.len(), 1);
                assert_eq!(
                    plan.entries[0].kind,
                    if self.shader {
                        deep_engine_native::runtime_package::RuntimeResourceKind::ShaderPackage
                    } else {
                        deep_engine_native::runtime_package::RuntimeResourceKind::RenderPacket
                    }
                );
            }
            self.mailbox.push(
                generation,
                WatchedPackage {
                    base_package_hash: None,
                    content: Box::new(next),
                    snapshot,
                    plan,
                },
            );
            apply_latest(&mut self.app);
            if self.full {
                assert_eq!(
                    self.app.next_renderer_id, next_id,
                    "zero-size retry allocated a renderer"
                );
            }
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
                RetryKind::Scene | RetryKind::Full(_)
            ));
        }
        assert!(retry(&mut self.app, event_loop, Instant::now()));
        self.app.renderer.as_mut().unwrap().resize(size).unwrap();
        if self.full {
            full::SKIP_PRESENTATIONS.with(|remaining| remaining.set(2));
            for _ in 0..2 {
                assert!(retry(
                    &mut self.app,
                    event_loop,
                    Instant::now() + Duration::from_secs(1)
                ));
                assert_eq!(
                    self.app.next_renderer_id,
                    next_id + 1,
                    "skipped presentation rebuilt candidate device"
                );
                assert_eq!(self.published.read().unwrap().package_hash, old_hash);
                assert_eq!(self.app.renderer.as_ref().unwrap().id(), old_id);
                assert_eq!(
                    self.app.renderer.as_ref().unwrap().ibl_summary().0,
                    old_environment
                );
            }
            // 第二版已持有 GPU 候选时第三版到达：旧候选不得再呈现或发布。
            let next = fixture(false, true, 3);
            let snapshot = next.runtime_package().unwrap().clone();
            let plan = plan_runtime_package_resource_diff(
                &self.published.read().unwrap().resource_index,
                &snapshot.resource_index,
            )
            .unwrap();
            full::SKIP_PRESENTATIONS.with(|remaining| remaining.set(1));
            self.mailbox.push(
                3,
                WatchedPackage {
                    base_package_hash: None,
                    content: Box::new(next),
                    snapshot,
                    plan,
                },
            );
            apply_latest(&mut self.app);
            assert_eq!(self.app.next_renderer_id, next_id + 2);
            let pending = self
                .app
                .package_live_transport
                .as_ref()
                .unwrap()
                .retry
                .as_ref()
                .unwrap();
            assert_eq!(pending.1, 3);
            assert!(
                matches!(&pending.3, RetryKind::Full(Some(renderer)) if renderer.id() == next_id + 1)
            );
            assert_eq!(self.app.packet_coalescer.published(), 0);
            assert_eq!(self.published.read().unwrap().package_hash, old_hash);
            full::RECOVER_PRESENTATION.with(|recover| recover.set(true));
            assert!(retry(
                &mut self.app,
                event_loop,
                Instant::now() + Duration::from_secs(1)
            ));
            assert_eq!(self.app.next_renderer_id, next_id + 2);
            assert_eq!(self.published.read().unwrap().package_hash, old_hash);
            assert!(matches!(
                self.app
                    .package_live_transport
                    .as_ref()
                    .unwrap()
                    .retry
                    .as_ref()
                    .unwrap()
                    .3,
                RetryKind::Full(None)
            ));
        }
        for _ in 0..30 {
            if !retry(
                &mut self.app,
                event_loop,
                Instant::now() + Duration::from_secs(1),
            ) {
                break;
            }
        }
        let final_generation = if self.full { 3 } else { 2 };
        assert_eq!(self.app.packet_coalescer.published(), final_generation);
        if self.full {
            assert_eq!(self.app.next_renderer_id, next_id + 3);
            let expected = fixture(false, true, final_generation);
            let renderer = self.app.renderer.as_ref().unwrap();
            assert_eq!(renderer.ibl_summary().0, expected.environment.id);
            assert_eq!(renderer.ibl_summary().1, expected.environment.revision);
            renderer.verify_environment_source(&expected.environment);
            assert_eq!(self.app.content.active().environment, expected.environment);
        }
        assert_eq!(
            self.app.renderer.as_ref().unwrap().id() == old_id,
            !self.full
        );
        assert_eq!(
            self.published.read().unwrap().package_hash,
            fixture(self.shader, self.full, final_generation)
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
            "runtime package present barrier: shader={} full={} skipped generations retained snapshots; generation {} presented",
            self.shader, self.full, final_generation
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

fn fixture(shader: bool, full: bool, revision: u64) -> PlayerContent {
    if full {
        let bytes: &[u8] = if revision == 0 {
            include_bytes!("../../tests/fixtures/runtime-package-coordinate-origin-a.json")
        } else {
            include_bytes!("../../tests/fixtures/runtime-package-coordinate-origin-b.json")
        };
        let mut value: Value = serde_json::from_slice(bytes).unwrap();
        if revision > 0 {
            value["payloads"]["scene.camera"]["revision"] = json!(1 + revision);
            let camera_hash = runtime_content_sha256(&value["payloads"]["scene.camera"]);
            let old: Value = serde_json::from_slice(include_bytes!(
                "../../tests/fixtures/runtime-package-coordinate-origin-a.json"
            ))
            .unwrap();
            for resource in value["resources"].as_array_mut().unwrap() {
                let previous = old["resources"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|item| item["id"] == resource["id"])
                    .unwrap();
                if previous["contentHash"] != resource["contentHash"] {
                    resource["revision"] = json!(resource["revision"].as_u64().unwrap() + revision);
                }
                if resource["id"] == "scene.camera" {
                    resource["contentHash"]["value"] = json!(camera_hash);
                }
            }
            environment_fixture::replace_environment(&mut value, revision);
            value["packageHash"]["value"] = json!(runtime_package_sha256(&value).unwrap());
        }
        return PlayerContent::from_package(
            parse_and_validate_runtime_package(&serde_json::to_vec(&value).unwrap()).unwrap(),
        )
        .unwrap();
    }
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
