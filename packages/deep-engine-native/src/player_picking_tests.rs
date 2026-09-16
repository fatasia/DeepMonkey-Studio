use super::*;

fn packet() -> RenderPacket {
    serde_json::from_value(serde_json::json!({
        "schema":"deep-engine.render-packet", "version":1,
        "geometries":[{"id":"triangle", "revision":0,
            "vertices":[-1.,-1.,0.,0.,0.,1., 1.,-1.,0.,0.,0.,1., 0.,1.,0.,0.,0.,1.],
            "indices":[0,1,2]}],
        "materials":[],
        "instances":[{"id":"authored-guid", "geometry":"triangle", "material":"unused",
            "transform":[1.,0.,0.,0., 0.,1.,0.,0., 0.,0.,1.,0., 0.,0.,0.,1.]}]
    }))
    .unwrap()
}

fn view() -> PlayerView {
    PlayerView {
        yaw: 0.0,
        ..Default::default()
    }
}

#[test]
fn author_selection_picks_only_current_levels_with_stable_identity_and_nearest_hit() {
    let mut scene = packet();
    let mut near: serde_json::Value = serde_json::json!({
        "id":"near", "revision":0,
        "vertices":[-1.,-1.,1.,0.,0.,1., 1.,-1.,1.,0.,0.,1., 0.,1.,1.,0.,0.,1.],
        "indices":[0,1,2]
    });
    scene
        .geometries
        .push(serde_json::from_value(near.clone()).unwrap());
    near["id"] = "offset".into();
    for index in [0, 6, 12] {
        near["vertices"][index] = (near["vertices"][index].as_f64().unwrap() + 20.).into();
    }
    scene.geometries.push(serde_json::from_value(near).unwrap());
    scene.instances[0].lod = Some(
        serde_json::from_value(serde_json::json!({
            "strategy":"author-selected", "revision":1,
            "levels":[{"geometry":"triangle","distance":0,"hysteresis":0},
                      {"geometry":"near","distance":1,"hysteresis":0},
                      {"geometry":"offset","distance":2,"hysteresis":0}],
            "selectedLevels":[0,1]
        }))
        .unwrap(),
    );
    let hit = pick(&scene, view(), [100, 100], [50., 50.]).unwrap();
    assert_eq!(hit.id, "authored-guid");
    assert_eq!(hit.point[2], 1.0);
    for (selected, expected) in [
        (vec![1], Some(1.0)),
        (vec![], None),
        (vec![2], None),
        (vec![0], Some(0.0)),
        (vec![999], None),
    ] {
        scene.instances[0]
            .lod
            .as_mut()
            .unwrap()
            .author
            .as_mut()
            .unwrap()
            .selected_levels = selected;
        assert_eq!(
            pick(&scene, view(), [100, 100], [50., 50.]).map(|p| p.point[2]),
            expected
        );
    }
}

#[test]
fn triangle_hit_preserves_identity_and_world_point() {
    let hit = pick(&packet(), view(), [100, 100], [50., 50.]).unwrap();
    assert_eq!(hit.id, "authored-guid");
    assert_eq!(hit.point, [0.; 3]);
    assert!(pick(&packet(), view(), [100, 100], [0., 0.]).is_none());
}

#[test]
fn nearest_triangle_wins_independent_of_instance_order() {
    let mut scene = packet();
    let mut near = scene.instances[0].clone();
    near.id = "near".into();
    near.transform[14] = 1.0;
    scene.instances.push(near);
    for _ in 0..2 {
        assert_eq!(
            pick(&scene, view(), [100, 100], [50., 50.]).unwrap().id,
            "near"
        );
        scene.instances.reverse();
    }
}

#[test]
fn projection_and_picking_agree_after_focus_rotation_and_resize() {
    let mut scene = packet();
    scene.instances[0].transform[12] = 1.0;
    let mut camera = view();
    let hit = pick(&scene, camera, [100, 100], [75.625, 50.]).unwrap();
    focus(&mut camera, &hit, [480, 800]);
    camera.yaw = 0.3;
    let frame = crate::gpu_resources::frame_data_with_view(
        winit::dpi::PhysicalSize::new(480, 800),
        camera.yaw,
        camera.target,
        camera.distance,
        deep_engine_native::fog::FogSettings::DISABLED,
    );
    for axis in [0, 1] {
        let clip = frame[3][axis]
            + (0..3)
                .map(|i| frame[i][axis] * camera.target[i])
                .sum::<f32>();
        assert!(clip.abs() < 1e-5);
    }
    assert_eq!(
        pick(&scene, camera, [480, 800], [240., 400.]).unwrap().id,
        "authored-guid"
    );
}

#[test]
fn pitched_camera_projects_and_picks_the_same_off_center_world_point() {
    for pitch in [-1.2, -0.4, 0.4, 1.2] {
        for size in [[480, 800], [1280, 720]] {
            let mut scene = packet();
            scene.instances[0].transform[12] = 3.0;
            let camera = PlayerView {
                pitch,
                focal: 1.2,
                near: 0.05,
                far: 100_000.0,
                yaw: 0.3,
                target: [3.0, 0.0, 0.0],
                ..view()
            };
            let frame = crate::gpu_resources::frame_data_with_camera(
                winit::dpi::PhysicalSize::new(size[0], size[1]),
                camera,
                deep_engine_native::fog::FogSettings::DISABLED,
            );
            let point = [3.2, 0.1, 0.0];
            let clip: [f32; 4] = std::array::from_fn(|row| {
                frame[3][row] + (0..3).map(|i| frame[i][row] * point[i]).sum::<f32>()
            });
            let pixel = [
                ((clip[0] / clip[3] + 1.0) * 0.5 * size[0] as f32) as f64,
                ((1.0 - clip[1] / clip[3]) * 0.5 * size[1] as f32) as f64,
            ];
            let hit = pick(&scene, camera, size, pixel).unwrap();
            assert_eq!(hit.id, "authored-guid");
            for (axis, value) in point.iter().enumerate() {
                assert!((hit.point[axis] - *value).abs() < 0.0001);
            }
        }
    }
}

#[test]
fn picking_respects_authored_depth_range() {
    for (near, far, expected) in [
        (0.01, 3.0, false),
        (5.0, 20.0, false),
        (0.05, 100_000.0, true),
    ] {
        let camera = PlayerView {
            near,
            far,
            ..view()
        };
        assert_eq!(
            pick(&packet(), camera, [100, 100], [50.0, 50.0]).is_some(),
            expected
        );
    }
    let mut camera = PlayerView {
        near: 0.01,
        far: 0.1,
        ..view()
    };
    focus(
        &mut camera,
        &Pick {
            id: "small".into(),
            point: [0.0; 3],
            center: [0.0; 3],
            radius: 0.01,
        },
        [100, 100],
    );
    assert!(camera.distance.is_finite() && camera.distance <= camera.far);
}

#[test]
fn invalid_indices_missing_geometry_and_nonfinite_coordinates_do_not_panic() {
    let mut scene = packet();
    scene.geometries[0].indices[0] = u32::MAX;
    assert!(pick(&scene, view(), [100, 100], [50., 50.]).is_none());
    scene.geometries.clear();
    assert!(pick(&scene, view(), [100, 100], [50., 50.]).is_none());
    for pixel in [[f64::NAN, 50.], [-1., 50.], [100., 50.]] {
        assert!(pick(&packet(), view(), [100, 100], pixel).is_none());
    }
    assert!(pick(&packet(), view(), [0, 100], [0., 50.]).is_none());
}

#[test]
fn camera_clipped_and_degenerate_triangles_are_not_selectable() {
    let mut scene = packet();
    for z in [4.0, 5.0, -101.0] {
        scene.instances[0].transform[14] = z;
        assert!(pick(&scene, view(), [100, 100], [50., 50.]).is_none());
    }
    scene.instances[0].transform[14] = 0.;
    scene.geometries[0].indices = vec![0, 0, 0];
    assert!(pick(&scene, view(), [100, 100], [50., 50.]).is_none());
}

#[test]
fn section_rejects_removed_hits_and_single_sided_backfaces() {
    let mut camera = view();
    camera.clipping = [1., 0., 0., -0.1];
    assert!(pick(&packet(), camera, [100, 100], [50., 50.]).is_none());
    camera.clipping = [1., 0., 0., 0.];
    assert!(pick(&packet(), camera, [100, 100], [50., 50.]).is_some());
    let mut scene = packet();
    scene.geometries[0].indices.reverse();
    assert!(pick(&scene, view(), [100, 100], [50., 50.]).is_none());
}
