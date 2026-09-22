use super::*;
use crate::shadow_dirty::ShadowCaster;
use std::{hint::black_box, time::Instant};

struct Views(Vec<[[f32; 4]; 4]>);
impl ShadowViewSource for Views {
    fn cascade_count(&self) -> u32 {
        self.0.len() as u32
    }
    fn cascade_view_projection(&self, index: usize) -> [[f32; 4]; 4] {
        self.0[index]
    }
    fn shadow_map_size(&self) -> u32 {
        2048
    }
}
fn fixture() -> (ShadowCasterSet, Views) {
    let casters = (0..10_000)
        .map(|index| {
            let mut instance = [0.0; deep_engine_native::scene::PACKED_INSTANCE_FLOATS];
            instance[0] = 1.0;
            instance[5] = 1.0;
            instance[10] = 1.0;
            instance[3] = (index % 100) as f32 * 0.02 - 1.0;
            instance[7] = (index / 100) as f32 * 0.02 - 1.0;
            instance[11] = 0.5;
            ShadowCaster {
                instance,
                bound: [0.0, 0.0, 0.0, 0.01],
                fingerprint: index,
            }
        })
        .collect();
    let matrix = [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ];
    (
        ShadowCasterSet {
            casters,
            ..Default::default()
        },
        Views(vec![matrix; 14]),
    )
}

#[test]
fn cached_keys_match_full_scan_for_camera_and_scene_changes() {
    let (mut set, mut views) = fixture();
    for step in 0..20 {
        for index in 0..4 {
            views.0[index][3][0] = step as f32 * 0.01;
        }
        if step == 10 {
            // prepare 在任何几何/变换/投影资格变更后创建全新集合。
            let mut casters = set.casters.clone();
            casters[0].fingerprint += 1;
            casters[0].instance[3] = 100.0;
            set = ShadowCasterSet {
                casters,
                ..Default::default()
            };
        }
        let cached = set.keys(&views, step).unwrap();
        let reference = ShadowCasterSet {
            casters: set.casters.clone(),
            ..Default::default()
        };
        assert_eq!(cached, reference.keys(&views, step).unwrap());
        assert_eq!(set.view_keys.borrow().len(), 14);
    }
    views.0.truncate(4);
    set.keys(&views, 0).unwrap();
    assert_eq!(set.view_keys.borrow().len(), 4);
    views.0[0][0][0] = f32::NAN;
    assert!(set.keys(&views, 0).is_err());
}

#[test]
#[ignore = "focused release CPU benchmark; reports local key generation, not whole-frame FPS"]
fn benchmark_shadow_key_reuse() {
    for mode in ["static", "camera", "object"] {
        let (set, mut views) = fixture();
        let iterations = 120;
        let mut measured = Vec::new();
        for cached in [false, true] {
            set.view_keys.borrow_mut().clear();
            let start = Instant::now();
            for step in 0..iterations {
                if mode == "camera" {
                    for index in 0..4 {
                        views.0[index][3][0] = step as f32 * 0.001;
                    }
                }
                // 物体更新的 prepare 建立新集合，因此每步没有可复用视图。
                if !cached || mode == "object" {
                    set.view_keys.borrow_mut().clear();
                }
                black_box(set.keys(black_box(&views), 7).unwrap());
            }
            measured.push(start.elapsed().as_secs_f64() * 1000.0 / iterations as f64);
        }
        println!(
            "shadow key benchmark mode={mode} casters=10000 views=14 baseline_ms={:.6} cached_ms={:.6} reduction={:.2}%",
            measured[0],
            measured[1],
            (1.0 - measured[1] / measured[0]) * 100.0
        );
    }
}
