use super::*;
use crate::player_content::PlayerContent;
use crate::player_measurement::Measurement;

fn content(bytes: &[u8]) -> PlayerContent {
    PlayerContent::from_package(
        deep_engine_native::runtime_package::parse_and_validate_runtime_package(bytes).unwrap(),
    )
    .unwrap()
}
fn project(view: PlayerView, size: [u32; 2], local: [f64; 3]) -> [f64; 2] {
    let eye = view.eye().map(f64::from);
    let delta: [f64; 3] = std::array::from_fn(|axis| local[axis] - eye[axis]);
    let [right, up, forward] = view.basis();
    let dot = |axis: [f32; 3]| (0..3).map(|i| delta[i] * axis[i] as f64).sum::<f64>();
    let depth = dot(forward);
    let x = dot(right) * view.focal as f64 / depth / (size[0] as f64 / size[1] as f64);
    let y = dot(up) * view.focal as f64 / depth;
    [
        (x + 1.0) * 0.5 * size[0] as f64,
        (1.0 - y) * 0.5 * size[1] as f64,
    ]
}
#[test]
fn real_rebased_box_picks_restore_world_points_and_measure_with_fixed_budgets() {
    let a = content(include_bytes!(
        "../tests/fixtures/runtime-package-coordinate-origin-a.json"
    ));
    let b = content(include_bytes!(
        "../tests/fixtures/runtime-package-coordinate-origin-b.json"
    ));
    let points: [[f64; 3]; 2] = [[0.25, 0.125, 2.0], [0.875, -0.25, 2.0]];
    let expected_distance = (0..3)
        .map(|i| (points[0][i] - points[1][i]).powi(2))
        .sum::<f64>()
        .sqrt();
    let mut all_hits = Vec::new();
    let mut max_point_error = 0.0_f64;
    let mut max_roundtrip_error = 0.0_f64;
    let mut max_distance_error = 0.0_f64;
    for content in [&a, &b] {
        for size in [[480, 800], [1280, 720]] {
            let mut measure = Measurement::default();
            measure.toggle();
            let mut hits = Vec::new();
            for point in points {
                let world = point.map(|value| value + 1e9);
                let local = content.world_to_local(world).unwrap();
                let pixel = project(content.initial_view(), size, local);
                let hit =
                    pick_world(content, content.initial_view(), size, pixel).unwrap_or_else(|| {
                        panic!(
                            "missing hit local={local:?} size={size:?} pixel={pixel:?} raw={:?}",
                            pick(content.packet(), content.initial_view(), size, pixel)
                        )
                    });
                assert_eq!(hit.local.id, "box");
                for axis in 0..3 {
                    max_point_error =
                        max_point_error.max((hit.world_point[axis] - world[axis]).abs());
                    assert!(
                        (hit.world_point[axis] - world[axis]).abs() <= 0.001,
                        "axis {axis}: {:?} vs {world:?}",
                        hit.world_point
                    );
                }
                let roundtrip = content.world_to_local(hit.world_point).unwrap();
                for (axis, value) in roundtrip.iter().enumerate() {
                    max_roundtrip_error =
                        max_roundtrip_error.max((*value - hit.local.point[axis] as f64).abs());
                    assert!((*value - hit.local.point[axis] as f64).abs() <= 1e-6);
                }
                measure.hit(hit.world_point);
                hits.push(hit.world_point);
            }
            assert!((measure.distance.unwrap() - expected_distance).abs() <= 0.004);
            max_distance_error =
                max_distance_error.max((measure.distance.unwrap() - expected_distance).abs());
            all_hits.push(hits);
        }
    }
    for hits in &all_hits[1..] {
        for point in 0..2 {
            for axis in 0..3 {
                assert!((hits[point][axis] - all_hits[0][point][axis]).abs() <= 0.001);
            }
        }
    }
    let mut rebased_measure = Measurement::default();
    rebased_measure.toggle();
    rebased_measure.hit(all_hits[0][0]);
    rebased_measure.hit(all_hits[2][1]);
    assert!((rebased_measure.distance.unwrap() - expected_distance).abs() <= 0.004);
    max_distance_error =
        max_distance_error.max((rebased_measure.distance.unwrap() - expected_distance).abs());
    println!(
        "world tools error: point={max_point_error:.12} roundtrip={max_roundtrip_error:.12} distance={max_distance_error:.12}"
    );
}
#[test]
fn world_boundary_rejects_empty_clipped_and_failed_frame_conversion() {
    let bytes = include_bytes!("../tests/fixtures/runtime-package-coordinate-origin-a.json");
    let scene = content(bytes);
    let view = scene.initial_view();
    assert!(pick_world(&scene, view, [100, 100], [0.0, 0.0]).is_none());
    let mut clipped = view;
    clipped.clipping = [0.0, 0.0, 0.0, -1.0];
    assert!(pick_world(&scene, clipped, [100, 100], [50.0, 50.0]).is_none());
    let mut package =
        deep_engine_native::runtime_package::parse_and_validate_runtime_package(bytes).unwrap();
    package.render_packet.instances.clear();
    assert!(
        pick_world(
            &PlayerContent::from_package(package).unwrap(),
            view,
            [100, 100],
            [50.0, 50.0]
        )
        .is_none()
    );
    let mut package =
        deep_engine_native::runtime_package::parse_and_validate_runtime_package(bytes).unwrap();
    package
        .camera
        .as_mut()
        .unwrap()
        .coordinate_frame
        .as_mut()
        .unwrap()
        .origin
        .x = 1e20;
    package.camera.as_mut().unwrap().position = [16384.0, 16384.0, 32768.0];
    package.camera.as_mut().unwrap().target = [0.0; 3];
    let invalid = PlayerContent::from_package(package).unwrap();
    assert!(pick(invalid.packet(), view, [100, 100], [50.0, 50.0]).is_some());
    assert!(pick_world(&invalid, view, [100, 100], [50.0, 50.0]).is_none());
}
