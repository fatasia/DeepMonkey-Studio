use deep_engine_native::mesh_abi::{CAMERA_FAR, CAMERA_FOCAL, CAMERA_NEAR};
use deep_engine_native::player_view::PlayerView;

use super::megalights_gpu::{
    combined_clip_to_view, invert4, multiply4, pack_ris_params, world_to_view,
};
use super::megalights_runtime::to_view;

/// M·inv(M) = I(投影×视图组合矩阵量级下 1e-4;f32 余子母式落点)。
#[test]
fn invert4_roundtrips_camera_matrix() {
    let view = PlayerView {
        yaw: 0.7,
        pitch: -0.25,
        focal: CAMERA_FOCAL,
        near: CAMERA_NEAR,
        far: CAMERA_FAR,
        ..PlayerView::default()
    };
    let eye = view.eye();
    let aspect = 8.0f32 / 6.0;
    // 复刻 gpu_resources::frame_data_with_camera 的列主序 viewProjection 前 4 行。
    let [right, up, forward] = view.basis();
    let depth = view.far / (view.far - view.near);
    let mut projection = [[0.0f32; 4]; 4];
    for axis in 0..3 {
        projection[axis] = [
            view.focal / aspect * right[axis],
            view.focal * up[axis],
            depth * forward[axis],
            forward[axis],
        ];
    }
    projection[3] = std::array::from_fn(|row| {
        -(0..3)
            .map(|axis| projection[axis][row] * eye[axis])
            .sum::<f32>()
    });
    projection[3][2] -= view.near * depth;

    let inverse = invert4(&projection).expect("camera projection must be invertible");
    let identity = multiply4(&projection, &inverse);
    for (col, column) in identity.iter().enumerate() {
        for (row, value) in column.iter().enumerate() {
            let expected = f32::from(col == row);
            assert!(
                (*value - expected).abs() <= 1e-4,
                "M·inv(M)[{col}][{row}] = {} != {expected}",
                *value
            );
        }
    }
}

/// world_to_view 与灯池视空间变换(to_view)同一刚体口径——GPU 重建表面与
/// CPU 灯池必须落在同一视空间,否则 n·l 语义分裂。
#[test]
fn world_to_view_matches_pool_view_transform() {
    let view = PlayerView {
        yaw: 1.1,
        pitch: 0.3,
        target: [0.4, -0.2, 0.7],
        distance: 3.5,
        ..PlayerView::default()
    };
    for world in [[0.0, 0.0, 0.0], [1.5, -0.7, 2.3], [-2.0, 0.9, -1.1]] {
        let matrix = world_to_view(view);
        let expected = to_view(view, world, true);
        let point = [world[0], world[1], world[2], 1.0f32];
        let mut transformed = [0.0f64; 4];
        for row in 0..4 {
            transformed[row] = (0..4)
                .map(|col| f64::from(matrix[col][row]) * f64::from(point[col]))
                .sum();
        }
        for axis in 0..3 {
            assert!(
                (transformed[axis] - expected[axis]).abs() <= 1e-5,
                "world_to_view axis {axis}: {} vs {}",
                transformed[axis],
                expected[axis]
            );
        }
    }
}

/// clip → view 组合矩阵闭环:视空间点 → 世界点 → NDC → 组合矩阵重建 →
/// 原视空间点(重建核的数学主轴;真机腿在同一定义上以 GPU 深度纹理再验)。
#[test]
fn combined_clip_to_view_recovers_view_positions() {
    let view = PlayerView {
        yaw: 0.4,
        pitch: -0.15,
        ..PlayerView::default()
    };
    let eye = view.eye();
    let aspect = 8.0f32 / 6.0;
    let [right, up, forward] = view.basis();
    let depth = view.far / (view.far - view.near);
    let mut projection = [[0.0f32; 4]; 4];
    for axis in 0..3 {
        projection[axis] = [
            view.focal / aspect * right[axis],
            view.focal * up[axis],
            depth * forward[axis],
            forward[axis],
        ];
    }
    projection[3] = std::array::from_fn(|row| {
        -(0..3)
            .map(|axis| projection[axis][row] * eye[axis])
            .sum::<f32>()
    });
    projection[3][2] -= view.near * depth;
    let combined = combined_clip_to_view(view, &projection).expect("combined");

    for view_point in [[0.0f64, 0.0, -3.0], [0.8, -0.5, -2.4], [-1.1, 0.6, -4.5]] {
        // 视空间 → 世界(R 行 = right/up/−forward;world = Rᵀ·v + eye)。
        let [r, u, f] = view.basis();
        let rows = [r, u, [-f[0], -f[1], -f[2]]];
        let world: [f32; 3] = std::array::from_fn(|axis| {
            (0..3)
                .map(|k| rows[k][axis] * view_point[k] as f32)
                .sum::<f32>()
                + eye[axis]
        });
        // 世界 → NDC(投影;重建核取 uv 中心化后的同一 NDC 约定)。
        let mut clip = [0.0f64; 4];
        for row in 0..4 {
            clip[row] = (0..3)
                .map(|col| f64::from(projection[col][row]) * f64::from(world[col]))
                .sum::<f64>()
                + f64::from(projection[3][row]);
        }
        let ndc = [clip[0] / clip[3], clip[1] / clip[3], clip[2] / clip[3], 1.0];
        // 组合矩阵重建(核内 clipped/w 同式)。
        let mut rebuilt = [0.0f64; 4];
        for row in 0..4 {
            rebuilt[row] = (0..4)
                .map(|col| f64::from(combined[col][row]) * ndc[col])
                .sum::<f64>();
        }
        for axis in 0..3 {
            rebuilt[axis] /= rebuilt[3];
            assert!(
                (rebuilt[axis] - view_point[axis]).abs() <= 2e-4,
                "combined 重建视点 axis {axis}: {} vs {}",
                rebuilt[axis],
                view_point[axis]
            );
        }
    }
}

/// RIS 参数位型契约:整数 u32 位型 + 浮点 f32 位型(全 f32 位型会把 lightCount
/// 读成 96.0f32≈11.2 亿 → 穷举腿近似无限循环,2026-10-07 真机破案)。
#[test]
fn pack_ris_params_mixed_bit_layout() {
    let params = pack_ris_params(8, 6, 12, 44, true, true, true, 0.5);
    assert_eq!(params[0], 8);
    assert_eq!(params[1], 6);
    assert_eq!(params[2], 12);
    assert_eq!(params[3], 44);
    assert_eq!(params[4], 1);
    assert_eq!(params[5], 1);
    assert_eq!(params[6], 1);
    assert_eq!(params[7], 1.0f32.to_bits(), "visibilitySlot 恒 1.0");
    assert_eq!(params[8], 0.5f32.to_bits());
    assert_eq!(params[9], 0, "visibilityEnabled = 0(M1 逐位)");
    assert!(params[10..].iter().all(|word| *word == 0));
}
