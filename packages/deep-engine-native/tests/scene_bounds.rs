use deep_engine_native::{
    contract::{
        GeometryResource, RenderLodLevel, RenderLodProfile, default_textured_fixture_path,
        load_and_validate,
    },
    scene_bounds::prepare_scene_bounds,
};

fn packet() -> deep_engine_native::contract::RenderPacket {
    load_and_validate(default_textured_fixture_path())
        .unwrap()
        .0
}

#[test]
fn indexed_bounds_handle_mirror_nonuniform_scale_and_shear() {
    let mut packet = packet();
    packet.instances.truncate(1);
    packet.instances[0].transform = [
        -2.0, 0.0, 0.0, 0.0, 0.5, 3.0, 0.0, 0.0, 0.0, 0.0, 0.25, 0.0, 4.0, -5.0, 6.0, 1.0,
    ];
    let bounds = prepare_scene_bounds(&packet).unwrap().unwrap();
    assert_close(bounds.minimum, [2.0, -7.4, 6.0]);
    assert_close(bounds.maximum, [6.0, -2.6, 6.0]);

    packet.geometries[0]
        .vertices
        .extend_from_slice(&[999_999.0, 999_999.0, 999_999.0, 0.0, 1.0, 0.0]);
    assert_eq!(prepare_scene_bounds(&packet).unwrap(), Some(bounds));
}

#[test]
fn referenced_lod_indices_expand_bounds_but_unreferenced_vertices_do_not() {
    let mut packet = packet();
    packet.instances.truncate(1);
    packet.instances[0].transform = [
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
    ];
    packet.instances[0].lod = Some(RenderLodProfile {
        levels: vec![
            RenderLodLevel {
                geometry: packet.instances[0].geometry.clone(),
                min_projected_diameter_pixels: 10.0,
                geometric_error: 0.0,
                resident: Some(true),
            },
            RenderLodLevel {
                geometry: "lod-bounds".into(),
                min_projected_diameter_pixels: 0.0,
                geometric_error: 1.0,
                resident: Some(true),
            },
        ],
        hysteresis_ratio: None,
        author: None,
    });
    packet.geometries.push(GeometryResource {
        id: "lod-bounds".into(),
        revision: 1,
        vertices: vec![
            4.0, -2.0, 3.0, 0.0, 1.0, 0.0, 5.0, 2.0, 4.0, 0.0, 1.0, 0.0, 999_999.0, 999_999.0,
            999_999.0, 0.0, 1.0, 0.0,
        ],
        uv0: None,
        uv1: None,
        tangents: None,
        colors: None,
        indices: vec![0, 1, 0],
    });
    let bounds = prepare_scene_bounds(&packet).unwrap().unwrap();
    assert_eq!(bounds.maximum, [5.0, 2.0, 4.0]);
}

#[test]
fn empty_scene_is_explicit_and_extreme_world_coordinates_fail_closed() {
    let mut empty = packet();
    empty.instances.clear();
    assert_eq!(prepare_scene_bounds(&empty).unwrap(), None);

    let mut extreme = packet();
    extreme.instances[0].transform[12] = 2_000_000.0;
    let error = prepare_scene_bounds(&extreme).unwrap_err();
    assert!(error.contains("floating-origin range"), "{error}");
}

#[test]
fn referenced_non_finite_data_and_oversized_spans_fail_closed() {
    let mut position = packet();
    position.geometries[0].vertices[0] = f32::NAN;
    let error = prepare_scene_bounds(&position).unwrap_err();
    assert!(error.contains("non-finite indexed position"), "{error}");

    let mut transform = packet();
    transform.instances[0].transform[5] = f32::INFINITY;
    let error = prepare_scene_bounds(&transform).unwrap_err();
    assert!(error.contains("non-finite value"), "{error}");

    let mut non_affine = packet();
    non_affine.instances[0].transform[3] = 0.25;
    let error = prepare_scene_bounds(&non_affine).unwrap_err();
    assert!(error.contains("affine instance transform"), "{error}");

    let mut span = packet();
    span.instances[0].transform[0] = 70_000.0;
    let error = prepare_scene_bounds(&span).unwrap_err();
    assert!(error.contains("shadow fitting span"), "{error}");
}

fn assert_close(actual: [f32; 3], expected: [f32; 3]) {
    for (actual, expected) in actual.into_iter().zip(expected) {
        assert!((actual - expected).abs() < 1e-5, "{actual} != {expected}");
    }
}
