use super::*;
use crate::{events::RenderOutcome, hdr_readback::HdrReadbackPair};
use deep_engine_native::runtime_package::{
    parse_and_validate_runtime_package, runtime_content_sha256, runtime_package_sha256,
};
use serde_json::{Value, json};

fn package(dark: bool, shader: bool) -> PlayerContent {
    let mut p: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/runtime-package-prefiltered-ibl-v1.json"
    ))
    .unwrap();
    let id = p["entrypoints"]["environment"].as_str().unwrap().to_owned();
    for cube in if dark {
        vec!["specular", "diffuse"]
    } else {
        vec![]
    } {
        for mip in p["payloads"][&id][cube]["mips"].as_array_mut().unwrap() {
            let data = mip["dataBase64"].as_str().unwrap();
            mip["dataBase64"] = json!(
                data.chars()
                    .map(|c| if c == '=' { '=' } else { 'A' })
                    .collect::<String>()
            );
        }
    }
    if shader {
        let source: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/runtime-package-shader-v2.json"
        ))
        .unwrap();
        let environment = p["payloads"][&id].clone();
        p = source;
        let old_id = p["entrypoints"]["environment"].as_str().unwrap().to_owned();
        p["entrypoints"]["environment"] = json!(id);
        p["payloads"].as_object_mut().unwrap().remove(&old_id);
        p["payloads"][&id] = environment;
        for r in p["resources"].as_array_mut().unwrap() {
            if r["id"] == old_id {
                r["id"] = json!(id);
            }
        }
        let bound: Vec<String> = p["materialBindings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["materialId"].as_str().unwrap().to_owned())
            .collect();
        let scene_id = p["entrypoints"]["renderPacket"]
            .as_str()
            .unwrap()
            .to_owned();
        p["payloads"][&scene_id]["instances"]
            .as_array_mut()
            .unwrap()
            .retain(|i| bound.iter().any(|b| i["material"] == *b));
        let scene_hash = runtime_content_sha256(&p["payloads"][&scene_id]);
        for r in p["resources"].as_array_mut().unwrap() {
            if r["id"] == scene_id {
                r["contentHash"]["value"] = json!(scene_hash);
            }
        }
    }
    let hash = runtime_content_sha256(&p["payloads"][&id]);
    for r in p["resources"].as_array_mut().unwrap() {
        if r["id"] == id {
            r["contentHash"]["value"] = json!(hash);
        }
    }
    p["resources"]
        .as_array_mut()
        .unwrap()
        .sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    p["packageHash"]["value"] = json!(runtime_package_sha256(&p).unwrap());
    PlayerContent::from_package(
        parse_and_validate_runtime_package(&serde_json::to_vec(&p).unwrap()).unwrap(),
    )
    .unwrap()
}

impl Renderer {
    pub(crate) fn verify_environment_transaction_pixels(&mut self, active: &PlayerContent) {
        self.verify_environment_pair(active, &package(true, false), false);
        let shader = package(false, true);
        pollster::block_on(self.replace_dropped_package(active, &shader)).unwrap();
        self.verify_environment_pair(&shader, &package(true, true), true);
        pollster::block_on(self.replace_dropped_package(&shader, active)).unwrap();
    }

    fn verify_environment_pair(
        &mut self,
        active: &PlayerContent,
        dark: &PlayerContent,
        shader: bool,
    ) {
        assert_eq!(active.environment.id, dark.environment.id);
        assert_eq!(active.environment.revision, dark.environment.revision);
        assert_ne!(active.environment.provenance, dark.environment.provenance);
        let original_identity = self.ibl.identity.clone();
        let original_renderer = self.id;
        let changed = HdrReadbackPair::new(&self.device, self.size, "IBL same identity revision");
        let restored = HdrReadbackPair::new(&self.device, self.size, "IBL rollback");
        assert!(matches!(
            self.render_internal(true, false),
            RenderOutcome::Presented
        ));
        self.capture_environment(&changed, true);
        self.capture_environment(&restored, true);
        pollster::block_on(self.replace_dropped_package(active, dark)).unwrap();
        if shader {
            let materials = self.scene.shader_materials.as_ref().unwrap();
            assert!(materials.isolated.is_empty());
            assert_eq!(materials.fallback_materials, 0);
        }
        assert_ne!(original_identity, self.ibl.identity);
        assert_eq!(self.id, original_renderer);
        assert!(matches!(
            self.render_internal(true, false),
            RenderOutcome::Presented
        ));
        self.capture_environment(&changed, false);
        let result = changed.finish(&self.device, "IBL changed").unwrap();
        assert!(
            result.changed_pixels > 4,
            "IBL was not consumed: {} pixels",
            result.changed_pixels
        );
        assert!(result.first_luminance > result.second_luminance);
        pollster::block_on(self.replace_dropped_package(dark, active)).unwrap();
        let size = self.size;
        self.resize(PhysicalSize::new(0, 0)).unwrap();
        assert!(pollster::block_on(self.replace_dropped_package(active, dark)).is_err());
        assert_eq!(self.ibl.identity, original_identity);
        self.resize(size).unwrap();
        assert!(matches!(
            self.render_internal(true, false),
            RenderOutcome::Presented
        ));
        self.capture_environment(&restored, false);
        let rollback = restored.finish(&self.device, "IBL rollback").unwrap();
        assert_eq!(rollback.changed_pixels, 0);
        println!(
            "native IBL same-device pixels OK: shader={shader} changed={} luminance={}/{} rollback=0 payload hash refresh=true",
            result.changed_pixels, result.first_luminance, result.second_luminance
        );
    }

    fn capture_environment(&self, capture: &HdrReadbackPair, first: bool) {
        let mut encoder = self.device.create_command_encoder(&Default::default());
        let texture = self.forward_targets.resolved_texture();
        if first {
            capture.copy_first(&mut encoder, texture);
        } else {
            capture.copy_second(&mut encoder, texture);
        }
        self.queue.submit([encoder.finish()]);
    }
}
