use super::*;
fn content() -> PlayerContent {
    PlayerContent::from_package(
        deep_engine_native::runtime_package::parse_and_validate_runtime_package(include_bytes!(
            "../tests/fixtures/runtime-package-camera-v3.json"
        ))
        .unwrap(),
    )
    .unwrap()
}
#[test]
fn camera_reload_preserves_user_view_unless_authored_camera_changes() {
    let old = content();
    let mut next = content();
    let mut user = old.initial_view();
    user.yaw += 0.3;
    assert_eq!(next.view_after_reload(&old, user), user);
    next.authored_view.as_mut().unwrap().pitch += 0.2;
    assert_eq!(next.view_after_reload(&old, user), next.initial_view());
    next.authored_view = None;
    assert_eq!(next.view_after_reload(&old, user), Default::default());
    assert!((old.initial_view().eye()[0] - 12.0).abs() < 0.00001);
}

#[test]
fn typescript_v5_package_validates_hashes_and_restores_world_camera() {
    let package = deep_engine_native::runtime_package::parse_and_validate_runtime_package(
        include_bytes!("../tests/fixtures/runtime-package-camera-v3-coordinates.json"),
    )
    .unwrap();
    let camera = package.camera.as_ref().unwrap();
    assert_eq!(camera.schema_version, 2);
    assert_eq!(
        camera.coordinate_frame.as_ref().unwrap().origin_array(),
        [1e9, -1e9, 1e9]
    );
    assert_eq!(camera.position, [12.0, 8.0, 16.0]);
    let content = PlayerContent::from_package(package).unwrap();
    assert_eq!(
        content.local_to_world([12.0, 8.0, 16.0]).unwrap(),
        [1e9 + 12.0, -1e9 + 8.0, 1e9 + 16.0]
    );
    assert_eq!(content.world_to_local([1e9, -1e9, 1e9]).unwrap(), [0.0; 3]);
    assert_eq!(content.initial_view().target, [0.0; 3]);
    assert!(content.runtime_package().is_some());
}

fn shifted_content(shift: f64) -> PlayerContent {
    let mut package = deep_engine_native::runtime_package::parse_and_validate_runtime_package(
        include_bytes!("../tests/fixtures/runtime-package-camera-v3.json"),
    )
    .unwrap();
    let frame = serde_json::from_value(serde_json::json!({"schemaVersion":1,
        "profile":{"id":"scene-local-coordinates-v1","unit":"scene-unit","originGrid":1000,
            "maxRoundTripError":0.000001,"maxFloat32CoordinateError":0.001},
        "origin":{"x":1e9+shift,"y":1e9,"z":1e9}}))
    .unwrap();
    let camera = package.camera.as_mut().unwrap();
    camera.schema_version = 2;
    camera.coordinate_frame = Some(frame);
    camera.position[0] -= shift;
    camera.target[0] -= shift;
    for instance in &mut package.render_packet.instances {
        instance.transform[12] -= shift as f32;
    }
    PlayerContent::from_package(package).unwrap()
}

#[test]
fn frame_reload_preserves_orbit_and_world_target_with_stable_object_ids() {
    let old = shifted_content(0.0);
    let next = shifted_content(1000.0);
    let mut user = old.initial_view();
    user.yaw += 0.3;
    user.pitch += 0.1;
    user.target = [0.125, -2.25, 10.5];
    user.distance *= 2.0;
    let moved = next.view_after_reload(&old, user);
    assert_eq!(moved.target, [-999.875, -2.25, 10.5]);
    assert_eq!(moved.yaw, user.yaw);
    assert_eq!(moved.pitch, user.pitch);
    assert_eq!(moved.distance, user.distance);
    assert_eq!(
        next.local_to_world(moved.target.map(f64::from)).unwrap(),
        old.local_to_world(user.target.map(f64::from)).unwrap()
    );
    for (before, after) in old.packet().instances.iter().zip(&next.packet().instances) {
        assert_eq!(before.id, after.id);
        let before_world = old
            .local_to_world([
                before.transform[12] as f64,
                before.transform[13] as f64,
                before.transform[14] as f64,
            ])
            .unwrap();
        let after_world = next
            .local_to_world([
                after.transform[12] as f64,
                after.transform[13] as f64,
                after.transform[14] as f64,
            ])
            .unwrap();
        for axis in 0..3 {
            assert!(
                (before_world[axis] - after_world[axis]).abs()
                    <= deep_engine_native::runtime_coordinates::MAX_FLOAT32_COORDINATE_ERROR
            );
        }
    }
    assert_eq!(old.view_after_reload(&next, moved), user);
}

#[test]
fn frame_reload_resets_changed_camera_and_unrepresentable_or_clipped_user_view() {
    let old = shifted_content(0.0);
    let mut next = shifted_content(1_000_000.0);
    let mut user = old.initial_view();
    user.target[0] = 0.01;
    assert_eq!(next.view_after_reload(&old, user), next.initial_view());
    user.target = [0.0; 3];
    user.clipping = [0.0, 1.0, 0.0, 2.0];
    assert_eq!(next.view_after_reload(&old, user), next.initial_view());
    user.clipping = [0.0; 4];
    next.authored_camera.as_mut().unwrap().position[1] += 1.0;
    assert_eq!(next.view_after_reload(&old, user), next.initial_view());
}
