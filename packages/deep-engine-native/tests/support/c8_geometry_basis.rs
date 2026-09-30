use deep_engine_native::{fog::FogSettings, mesh_abi::FrameUniform, player_view::PlayerView};
use winit::dpi::PhysicalSize;

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    (0..3).map(|i| a[i] * b[i]).sum()
}
fn unit(a: [f32; 3]) -> [f32; 3] {
    let length = dot(a, a).sqrt();
    a.map(|x| x / length)
}
fn recovered(frame: &FrameUniform) -> [[f32; 3]; 3] {
    let forward = unit(std::array::from_fn(|i| frame[i][3]));
    let x: [f32; 3] = std::array::from_fn(|i| frame[i][0]);
    let parallel = dot(x, forward);
    let right = unit(std::array::from_fn(|i| x[i] - forward[i] * parallel));
    let up = unit([
        right[1] * forward[2] - right[2] * forward[1],
        right[2] * forward[0] - right[0] * forward[2],
        right[0] * forward[1] - right[1] * forward[0],
    ]);
    [right, up, forward.map(|v| -v)]
}

#[test]
fn native_geometry_basis_recovers_true_player_camera_with_projection_jitter() {
    let mut raw_mismatches = 0;
    for yaw in [-1.2, 0.0, 0.55, 2.4] {
        for pitch in [
            -std::f32::consts::FRAC_PI_2,
            -0.7,
            0.0,
            0.7,
            std::f32::consts::FRAC_PI_2,
        ] {
            for (width, height) in [(1920, 1080), (128, 2048), (2048, 128)] {
                for (focal, near, far) in [(1.2, 0.05, 100_000.0), (3.0, 0.5, 200.0)] {
                    let view = PlayerView {
                        yaw,
                        pitch,
                        focal,
                        near,
                        far,
                        target: [9.0, 3.0, -7.0],
                        ..Default::default()
                    };
                    let source = crate::gpu_resources::frame_data_with_camera(
                        PhysicalSize::new(width, height),
                        view,
                        FogSettings::DISABLED,
                    );
                    let [right, up, forward] = view.basis();
                    let oracle = [right, up, forward.map(|v| -v)];
                    for jitter in [[0.0, 0.0], [0.125, -0.25], [-0.25, 0.125]] {
                        let mut frame = source;
                        // Perspective clip-space jitter: x/y += jitter * clip.w, including translation.
                        for column in &mut frame[..4] {
                            column[0] += jitter[0] * column[3];
                            column[1] += jitter[1] * column[3];
                        }
                        let basis = recovered(&frame);
                        for (actual, expected) in basis
                            .into_iter()
                            .flatten()
                            .zip(oracle.into_iter().flatten())
                        {
                            assert!(
                                (actual - expected).abs() <= 2e-6,
                                "basis drift {actual} vs {expected}"
                            );
                        }
                        let row_y: [f32; 3] =
                            std::array::from_fn(|i| (frame[i][1] - jitter[1] * forward[i]) / focal);
                        for (actual, expected) in row_y.into_iter().zip(up) {
                            assert!((actual - expected).abs() <= 2e-6);
                        }
                        for normal in [
                            [0.0, 0.0, 1.0],
                            unit([0.4, -0.7, 0.2]),
                            unit([-0.3, 0.1, 0.9]),
                        ] {
                            let actual = basis.map(|axis| dot(axis, normal));
                            let expected = oracle.map(|axis| dot(axis, normal));
                            assert!(
                                actual
                                    .into_iter()
                                    .zip(expected)
                                    .all(|(a, b)| (a - b).abs() <= 2e-6)
                            );
                            let raw = unit(std::array::from_fn(|row| {
                                (0..3).map(|i| frame[i][row] * normal[i]).sum()
                            }));
                            if raw
                                .into_iter()
                                .zip(expected)
                                .any(|(a, b)| (a - b).abs() > 0.01)
                            {
                                raw_mismatches += 1;
                            }
                        }
                    }
                }
            }
        }
    }
    assert!(
        raw_mismatches > 100,
        "raw VP negative control did not expose projection contamination"
    );
}

pub(super) fn analytic_normal(x: usize, y: usize, focal: f64) -> [f64; 3] {
    let world_x = ((x as f64 + 0.5) / 64.0 - 1.0) * 4.0 / focal;
    let world_y = (1.0 - (y as f64 + 0.5) / 64.0) * 4.0 / focal;
    let n = [0.8 * world_x, 0.8 * world_y, 1.0];
    let length = n.into_iter().map(|v| v * v).sum::<f64>().sqrt();
    n.map(|v| v / length)
}

pub(super) fn derivative_interval(x: usize, y: usize, focal: f64) -> [f64; 2] {
    let (qx, qy) = (x & !1, y & !1);
    let n00 = analytic_normal(qx, qy, focal);
    let n10 = analytic_normal(qx + 1, qy, focal);
    let n01 = analytic_normal(qx, qy + 1, focal);
    let n11 = analytic_normal(qx + 1, qy + 1, focal);
    let magnitude =
        |a: [f64; 3], b: [f64; 3]| (0..3).map(|i| (a[i] - b[i]).abs()).fold(0.0_f64, f64::max);
    let dx = [magnitude(n00, n10), magnitude(n01, n11)];
    let dy = [magnitude(n00, n01), magnitude(n10, n11)];
    [
        dx.into_iter()
            .fold(f64::INFINITY, f64::min)
            .max(dy.into_iter().fold(f64::INFINITY, f64::min)),
        dx.into_iter()
            .fold(0.0_f64, f64::max)
            .max(dy.into_iter().fold(0.0_f64, f64::max)),
    ]
}
