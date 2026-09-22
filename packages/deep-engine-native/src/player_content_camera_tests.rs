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

fn controlled_package(
    controls: deep_engine_native::runtime_camera::RuntimeCameraControls,
) -> deep_engine_native::runtime_package::LoadedRuntimePackage {
    let mut package = deep_engine_native::runtime_package::parse_and_validate_runtime_package(
        include_bytes!("../tests/fixtures/runtime-package-camera-v3.json"),
    )
    .unwrap();
    let camera = package.camera.as_mut().unwrap();
    camera.schema_version = 4;
    camera.controls = Some(controls);
    package
}

fn collision_packet() -> deep_engine_native::contract::RenderPacket {
    serde_json::from_value(serde_json::json!({
        "schema":"deep-engine.render-packet", "version":1,
        "geometries":[{"id":"wall", "revision":0,
            "vertices":[-10.,-10.,3.,0.,0.,1., 10.,-10.,3.,0.,0.,1., 0.,10.,3.,0.,0.,1.],
            "indices":[0,1,2]}],
        "materials":[],
        "instances":[{"id":"wall-instance", "geometry":"wall", "material":"unused",
            "transform":[1.,0.,0.,0., 0.,1.,0.,0., 0.,0.,1.,0., 0.,0.,0.,1.]}]
    }))
    .unwrap()
}

#[test]
fn camera_v4_controls_enter_player_content_and_constrain_initial_view() {
    let controls = deep_engine_native::runtime_camera::RuntimeCameraControls {
        min_distance: 2.0,
        max_distance: 3.0,
        min_polar_angle_degrees: 40.0,
        max_polar_angle_degrees: 50.0,
        walk_speed: 4.0,
        fly_speed: 15.0,
        ..Default::default()
    };
    let content = PlayerContent::from_package(controlled_package(controls)).unwrap();
    assert_eq!(content.camera_controls(), controls);
    assert_eq!(content.initial_view().distance, 3.0);
    assert!((content.initial_view().pitch.to_degrees() - 40.0).abs() < 0.0001);
}

#[test]
fn camera_v5_saved_views_enter_player_content_in_author_order() {
    let mut package = controlled_package(Default::default());
    let camera = package.camera.as_mut().unwrap();
    camera.schema_version = 5;
    camera.camera_views = Some(vec![
        deep_engine_native::runtime_camera::RuntimeCameraView {
            id: "overview".into(),
            name: "Overview".into(),
            position: [12.0, 8.0, 16.0],
            target: [0.0; 3],
        },
        deep_engine_native::runtime_camera::RuntimeCameraView {
            id: "detail".into(),
            name: "Detail".into(),
            position: [3.0, 2.0, 1.0],
            target: [1.0, 0.0, 0.0],
        },
    ]);
    camera.default_camera_view_id = Some("overview".into());
    let content = PlayerContent::from_package(package).unwrap();
    assert_eq!(content.camera_view_count(), 2);
    let (id, name, view) = content.camera_view(1).unwrap();
    assert_eq!((id, name), ("detail", "Detail"));
    assert_eq!(view.target, [1.0, 0.0, 0.0]);
    assert!(content.camera_view(2).is_none());
}

#[test]
fn camera_v4_consumes_simple_native_navigation_and_rejects_ground_solver_fields() {
    for mode in [
        deep_engine_native::runtime_camera::RuntimeCameraMode::FirstPerson,
        deep_engine_native::runtime_camera::RuntimeCameraMode::ThirdPerson,
    ] {
        let controls = deep_engine_native::runtime_camera::RuntimeCameraControls {
            mode,
            ..Default::default()
        };
        assert!(PlayerContent::from_package(controlled_package(controls)).is_ok());
    }
    for (mode, expected) in [
        (
            deep_engine_native::runtime_camera::RuntimeCameraMode::FirstPerson,
            "native firstPerson navigation requires stepHeight=0 and maxSlopeAngleDegrees=0",
        ),
        (
            deep_engine_native::runtime_camera::RuntimeCameraMode::ThirdPerson,
            "native thirdPerson navigation requires stepHeight=0 and maxSlopeAngleDegrees=0",
        ),
    ] {
        let controls = deep_engine_native::runtime_camera::RuntimeCameraControls {
            mode,
            step_height: 0.3,
            ..Default::default()
        };
        assert_eq!(
            PlayerContent::from_package(controlled_package(controls))
                .err()
                .unwrap(),
            expected
        );
    }
    let collision = deep_engine_native::runtime_camera::RuntimeCameraControls {
        collision_enabled: true,
        mode: deep_engine_native::runtime_camera::RuntimeCameraMode::FirstPerson,
        ..Default::default()
    };
    assert!(PlayerContent::from_package(controlled_package(collision)).is_ok());
}

#[test]
fn camera_reload_rechecks_collision_against_the_new_packet() {
    let controls = deep_engine_native::runtime_camera::RuntimeCameraControls {
        collision_enabled: true,
        collision_radius: 0.5,
        ..Default::default()
    };
    let mut old = PlayerContent::from_package(controlled_package(controls)).unwrap();
    old.packet.geometries.clear();
    old.packet.instances.clear();
    let mut next = PlayerContent::from_package(controlled_package(controls)).unwrap();
    next.packet = collision_packet();
    let current = deep_engine_native::player_view::PlayerView {
        yaw: 0.0,
        distance: 5.0,
        target: [0.0; 3],
        ..Default::default()
    };
    let resolved = next.view_after_reload(&old, current);
    assert!((resolved.distance - 2.5).abs() < 0.0001);
}

#[test]
fn first_person_consumption_reuses_triangle_sweep_for_wall_clearance() {
    let controls = deep_engine_native::runtime_camera::RuntimeCameraControls {
        mode: deep_engine_native::runtime_camera::RuntimeCameraMode::FirstPerson,
        collision_enabled: true,
        collision_radius: 0.5,
        eye_height: 1.7,
        ..Default::default()
    };
    let mut content = PlayerContent::from_package(controlled_package(controls)).unwrap();
    content.packet = collision_packet();
    let previous = deep_engine_native::player_view::PlayerView {
        yaw: 0.0,
        pitch: 0.0,
        target: [0.0, 1.7, 0.0],
        distance: 4.0,
        ..Default::default()
    };
    // Move the eye from z=4 toward a wall at z=3. The native locomotion
    // consumer must preserve the configured clearance instead of publishing
    // a camera inside the triangle.
    let desired = previous.translate([0.0, 0.0, -2.0]);
    let resolved = content.resolve_camera_motion(Some(previous), desired);
    assert!(
        resolved.eye()[2] >= 3.49,
        "eye crossed wall: {:?}",
        resolved.eye()
    );
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
