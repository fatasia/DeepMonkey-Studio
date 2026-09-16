use super::Renderer;
use crate::{events::RenderOutcome, hdr_readback::HdrReadbackPair, player_content::PlayerContent};
use deep_engine_native::runtime_package::{runtime_content_sha256, runtime_package_sha256};
use serde_json::{Value, json};
use std::path::Path;

fn write_package(path: &Path, scaled: bool) -> PlayerContent {
    let mut p: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/runtime-package-prefiltered-ibl-v1.json"
    ))
    .unwrap();
    let scene = p["entrypoints"]["renderPacket"]
        .as_str()
        .unwrap()
        .to_owned();
    if scaled {
        for g in p["payloads"][&scene]["geometries"].as_array_mut().unwrap() {
            for vertex in g["vertices"].as_array_mut().unwrap().chunks_exact_mut(6) {
                vertex[0] = json!(vertex[0].as_f64().unwrap() * 0.55);
            }
        }
        p["payloads"][&scene]["textures"][0]["data"][0] = json!(64);
    }
    let hash = runtime_content_sha256(&p["payloads"][&scene]);
    for r in p["resources"].as_array_mut().unwrap() {
        if r["id"] == scene {
            r["contentHash"]["value"] = json!(hash);
        }
    }
    p["packageHash"]["value"] = json!(runtime_package_sha256(&p).unwrap());
    std::fs::write(path, serde_json::to_vec(&p).unwrap()).unwrap();
    crate::runtime_package_startup::load_auto(path)
        .unwrap()
        .into_content()
}

impl Renderer {
    pub(crate) fn verify_source_domain_pixels(&mut self, initial: &PlayerContent) {
        // The enclosing child test owns and removes this isolated LOCALAPPDATA.
        let root = std::path::PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap());
        let a_path = root.join("project-a.runtime.json");
        let b_path = root.join("project-b.runtime.json");
        let mut a = write_package(&a_path, false);
        let mut b = write_package(&b_path, true);
        assert_eq!(a.packet().geometries[0].id, b.packet().geometries[0].id);
        assert_eq!(
            a.packet().geometries[0].revision,
            b.packet().geometries[0].revision
        );
        assert_ne!(a.resource_domain(), b.resource_domain());
        let budget = self._scene_cache.budget_bytes();
        let baseline_live = self._scene_cache.live_resources();
        let id = self.id;
        let changed = HdrReadbackPair::new(&self.device, self.size, "source domains");
        let restored = HdrReadbackPair::new(&self.device, self.size, "source rollback");
        pollster::block_on(self.replace_dropped_package(initial, &a)).unwrap();
        self.present_source(&mut a);
        self.capture_source(&changed, true);
        self.capture_source(&restored, true);
        let drift = write_package(&a_path, true);
        assert_eq!(a.resource_domain(), drift.resource_domain());
        assert!(
            pollster::block_on(self.replace_dropped_package(&a, &drift))
                .unwrap_err()
                .contains("different content")
        );
        assert_eq!(self._scene_cache.active_domain(), a.resource_domain());
        // A failed preview must not reserve B's revisions or change A's namespace.
        let size = self.size;
        self.resize(winit::dpi::PhysicalSize::new(0, 0)).unwrap();
        assert!(pollster::block_on(self.replace_dropped_package(&a, &b)).is_err());
        assert_eq!(self._scene_cache.active_domain(), a.resource_domain());
        self.resize(size).unwrap();
        self._scene_cache.budget_bytes = self._scene_cache.live_bytes();
        assert!(
            pollster::block_on(self.replace_dropped_package(&a, &b))
                .unwrap_err()
                .contains("resident budget")
        );
        assert_eq!(self._scene_cache.active_domain(), a.resource_domain());
        self._scene_cache.budget_bytes = budget;
        pollster::block_on(self.replace_dropped_package(&a, &b)).unwrap();
        self.present_source(&mut b);
        self.capture_source(&changed, false);
        let difference = changed.finish(&self.device, "different projects").unwrap();
        assert!(difference.changed_pixels > 4);
        assert_eq!(id, self.id);
        assert_eq!(self._scene_cache.budget_bytes(), budget);
        std::fs::write(&b_path, "broken source").unwrap();
        let recovered = crate::runtime_package_startup::load_auto(&b_path)
            .unwrap()
            .into_content();
        assert_eq!(recovered.resource_domain(), b.resource_domain());
        assert!(
            recovered
                .startup_notice
                .as_deref()
                .unwrap()
                .contains("last-known-good")
        );
        assert!(pollster::block_on(self.replace_dropped_package(&b, &drift)).is_err());
        pollster::block_on(self.replace_dropped_package(&b, &a)).unwrap();
        self.present_source(&mut a);
        self.capture_source(&restored, false);
        assert_eq!(
            restored
                .finish(&self.device, "same source restore")
                .unwrap()
                .changed_pixels,
            0
        );
        assert!(pollster::block_on(self.replace_dropped_package(&a, &drift)).is_err());
        let old_domains = self._scene_cache.domains.clone();
        while self._scene_cache.domains.len() < 256 {
            self._scene_cache.domains.insert(format!(
                "retained-domain-{}",
                self._scene_cache.domains.len()
            ));
        }
        let other = write_package(&root.join("project-c.runtime.json"), false);
        assert!(
            pollster::block_on(self.replace_dropped_package(&a, &other))
                .unwrap_err()
                .contains("source-domain budget")
        );
        self._scene_cache.domains = old_domains;
        pollster::block_on(self.replace_dropped_package(&a, initial)).unwrap();
        assert_eq!(self._scene_cache.live_resources(), baseline_live);
        println!(
            "native source-domain GPU OK: changed={} rollback=0 same-source-drift=rejected recovered-source=stable global-budget=retained",
            difference.changed_pixels
        );
    }

    fn present_source(&mut self, content: &mut PlayerContent) {
        for _ in 0..30 {
            match self.render(true) {
                RenderOutcome::Presented => {
                    crate::runtime_package_startup::presented(content);
                    return;
                }
                RenderOutcome::Skipped => std::thread::sleep(std::time::Duration::from_millis(10)),
                _ => panic!("source-domain present failed"),
            }
        }
        panic!("source-domain present timed out");
    }
    fn capture_source(&self, capture: &HdrReadbackPair, first: bool) {
        let mut encoder = self.device.create_command_encoder(&Default::default());
        if first {
            capture.copy_first(&mut encoder, self.forward_targets.resolved_texture());
        } else {
            capture.copy_second(&mut encoder, self.forward_targets.resolved_texture());
        }
        self.queue.submit([encoder.finish()]);
    }
}
