use super::*;
use crate::local_lighting::{LocalLight, LocalLightKind};
fn light() -> LocalLight {
    LocalLight {
        kind: LocalLightKind::Spot,
        position: [0.0, 4.0, 3.0],
        direction: [0.0, -0.8, -0.6],
        radiance: [4.0; 3],
        ground_radiance: None,
        shadow_softness: None,
        range: 12.0,
        decay: 2.0,
        inner_cos: 0.8,
        outer_cos: 0.5,
        cast_shadow: true,
        ies: None,
    }
}
fn project(matrix: Matrix, point: [f32; 3]) -> [f32; 3] {
    let clip: [f32; 4] = std::array::from_fn(|row| {
        matrix[0][row] * point[0]
            + matrix[1][row] * point[1]
            + matrix[2][row] * point[2]
            + matrix[3][row]
    });
    [clip[0] / clip[3], clip[1] / clip[3], clip[2] / clip[3]]
}
#[test]
fn spot_projection_has_expected_depth_and_translates_with_the_world() {
    let source = light();
    let matrix = spot_matrix(source.clone()).unwrap();
    let center = project(matrix, [0.0; 3]);
    assert!(
        center[0].abs() < 0.00001
            && center[1].abs() < 0.00001
            && center[2] > 0.0
            && center[2] < 1.0
    );
    let shifted = LocalLight {
        position: [100.0, 204.0, -297.0],
        ..source.clone()
    };
    let moved = project(spot_matrix(shifted).unwrap(), [100.0, 200.0, -300.0]);
    for i in 0..3 {
        assert!((center[i] - moved[i]).abs() < 0.0001);
    }
    let vertical = LocalLight {
        direction: [0.0, -1.0, 0.0],
        ..source.clone()
    };
    assert!(
        spot_matrix(vertical)
            .unwrap()
            .iter()
            .flatten()
            .all(|v| v.is_finite())
    );
}
#[test]
fn rejects_more_than_four_shadow_views_before_gpu_allocation() {
    let local = serde_json::json!({"kind":"spot","position":[0,4,3],"direction":[0,-0.8,-0.6],"radiance":[4,4,4],"range":12,"decay":2,"innerCos":0.8,"outerCos":0.5,"castShadow":true});
    let lighting = |count| serde_json::json!({"direction":[0,1,0],"radiance":[0,0,0],"exposure":1.05,"shadows":false,"localLights":vec![local.clone();count]});
    let valid: crate::scene_lighting::DirectionalLighting =
        serde_json::from_value(lighting(4)).unwrap();
    let mut frame = crate::mesh_abi::frame_uniform(1.0, 0.0);
    valid.apply(&mut frame);
    assert_eq!(frame_matrices(&frame).len(), 4);
    assert!(
        serde_json::from_value::<crate::scene_lighting::DirectionalLighting>(lighting(5)).is_err()
    );
}

#[test]
fn point_faces_cover_six_axes_and_keep_world_translation() {
    let source = LocalLight {
        kind: LocalLightKind::Point,
        ..light()
    };
    let faces = matrices(source.clone()).unwrap();
    assert_eq!(faces.len(), 6);
    for (face, direction) in faces.into_iter().zip(POINT_DIRECTIONS) {
        let target = std::array::from_fn(|i| source.position[i] + direction[i] * 2.0);
        let center = project(face, target);
        assert!(
            center[0].abs() < 1e-5 && center[1].abs() < 1e-5 && center[2] > 0.0 && center[2] < 1.0
        );
        let shifted = LocalLight {
            position: std::array::from_fn(|i| source.position[i] + [100.0, 200.0, -300.0][i]),
            ..source.clone()
        };
        let moved = project(
            projection(shifted, direction, 1.0).unwrap(),
            std::array::from_fn(|i| target[i] + [100.0, 200.0, -300.0][i]),
        );
        assert!((0..3).all(|i| (center[i] - moved[i]).abs() < 1e-4));
    }
    let mut combined = vec![light(); 4];
    combined.push(source.clone());
    assert!(validate_budget(&combined));
    // 第 5 盏灯超预算:validate_budget 必须拒绝(下方 lighting 仍可 apply,validate 独立拒绝)。
    combined.push(light());
    assert!(!validate_budget(&combined));
    let lighting = crate::scene_lighting::DirectionalLighting {
        direction: [0.0, 1.0, 0.0],
        radiance: [0.0; 3],
        exposure: 1.05,
        shadows: false,
        global_illumination_intensity: None,
        light_profiles: None,
        local_lights: {
            let mut lights: [LocalLight; crate::local_lighting::MAX_LOCAL_LIGHTS] =
                std::array::from_fn(|_| LocalLight::default());
            for (slot, item) in combined.iter().enumerate() {
                lights[slot] = item.clone();
            }
            lights
        },
    };
    let mut frame = crate::mesh_abi::frame_uniform(1.0, 0.0);
    lighting.apply(&mut frame);
    assert_eq!(frame_matrices(&frame).len(), 10);
    assert!(!validate_budget(&combined));
}
