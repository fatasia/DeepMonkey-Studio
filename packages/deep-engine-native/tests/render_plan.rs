use deep_engine_native::{
    contract::{RenderPacket, validate_packet},
    scene::{PACKED_INSTANCE_BYTES, prepare_scene},
};

#[test]
fn batches_every_instance_by_stable_resource_and_winding_keys() {
    let packet = multi_resource_packet();
    let summary = validate_packet(&packet).expect("valid multi-resource packet");
    assert_eq!(summary.geometries, 2);
    assert_eq!(summary.materials, 2);
    assert_eq!(summary.instances, 4);

    let first = prepare_scene(&packet).expect("prepare scene");
    let second = prepare_scene(&packet).expect("prepare scene again");
    assert_eq!(first, second, "resource and batch mapping must be stable");
    assert_eq!(PACKED_INSTANCE_BYTES, 144);
    assert_eq!(first.geometry_keys[0].id, "triangle-a");
    assert_eq!(first.geometry_keys[1].id, "triangle-b");
    assert_eq!(first.material_ids, ["red", "blue"]);
    assert_eq!(
        first.instance_ids,
        ["regular-a", "regular-b", "scaled", "mirrored"]
    );
    assert_eq!(first.instances.len(), 4);
    assert_eq!(first.batches.len(), 3);

    assert_eq!(first.batches[0].geometry_index, 0);
    assert_eq!(first.batches[0].material_index, 0);
    assert!(!first.batches[0].mirrored);
    assert_eq!(first.batches[0].instance_start, 0);
    assert_eq!(first.batches[0].instance_count, 2);

    assert_eq!(first.batches[1].geometry_index, 1);
    assert_eq!(first.batches[1].material_index, 1);
    assert!(!first.batches[1].mirrored);
    assert_eq!(first.batches[1].instance_start, 2);
    assert_eq!(first.batches[1].instance_count, 1);

    assert_eq!(first.batches[2].geometry_index, 0);
    assert_eq!(first.batches[2].material_index, 0);
    assert!(first.batches[2].mirrored);
    assert_eq!(first.batches[2].instance_start, 3);
    assert_eq!(first.batches[2].instance_count, 1);
}

#[test]
fn packs_inverse_transpose_for_non_uniform_scale_and_material_values() {
    let prepared = prepare_scene(&multi_resource_packet()).expect("prepare scene");
    let scaled = &prepared.instances[2];
    assert_slice_close(
        &scaled[..12],
        &[0.0, -3.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 4.0, 0.0],
    );
    assert_slice_close(
        &scaled[12..24],
        &[
            0.0,
            0.5,
            0.0,
            0.0,
            -1.0 / 3.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.25,
            0.0,
        ],
    );
    assert_slice_close(&scaled[24..28], &[0.1, 0.2, 0.9, 0.75]);
    assert_slice_close(&scaled[28..32], &[0.22, 0.5, 1.0, 0.0]);
    assert_slice_close(&scaled[32..36], &[0.0, 0.0, 0.0, 1.0]);

    let mirrored = &prepared.instances[3];
    assert_slice_close(
        &mirrored[12..24],
        &[-1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
    );
    assert_slice_close(&mirrored[28..32], &[0.7, 0.5, -1.0, 0.0]);
}

#[test]
fn empty_packet_prepares_as_a_valid_clear_only_scene() {
    let packet: RenderPacket = serde_json::from_value(serde_json::json!({
        "schema": "deep-engine.render-packet",
        "version": 1,
        "geometries": [],
        "materials": [],
        "instances": [],
        "textures": []
    }))
    .expect("empty packet");
    let summary = validate_packet(&packet).expect("empty contract is valid");
    assert_eq!(summary.instances, 0);
    let prepared = prepare_scene(&packet).expect("prepare empty scene");
    assert!(prepared.geometry_keys.is_empty());
    assert!(prepared.material_ids.is_empty());
    assert!(prepared.instances.is_empty());
    assert!(prepared.batches.is_empty());
}

fn multi_resource_packet() -> RenderPacket {
    serde_json::from_value(serde_json::json!({
        "schema": "deep-engine.render-packet",
        "version": 1,
        "geometries": [
            {
                "id": "triangle-a", "revision": 4,
                "vertices": [
                    -0.5, -0.5, 0.0, 0.0, 0.0, 1.0,
                     0.5, -0.5, 0.0, 0.0, 0.0, 1.0,
                     0.0,  0.5, 0.0, 0.0, 0.0, 1.0
                ],
                "indices": [0, 1, 2]
            },
            {
                "id": "triangle-b", "revision": 9,
                "vertices": [
                    -0.4, -0.4, 0.2, 0.0, 0.0, 1.0,
                     0.4, -0.4, 0.2, 0.0, 0.0, 1.0,
                     0.0,  0.4, 0.2, 0.0, 0.0, 1.0
                ],
                "indices": [0, 1, 2]
            }
        ],
        "materials": [
            {"id": "red", "baseColor": [0.9, 0.1, 0.1], "metallic": 0.0, "roughness": 0.7},
            {"id": "blue", "baseColor": [0.1, 0.2, 0.9], "metallic": 0.75, "roughness": 0.22}
        ],
        "instances": [
            {
                "id": "regular-a", "geometry": "triangle-a", "material": "red",
                "transform": [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, -1.0, 0.0, 0.0, 1.0]
            },
            {
                "id": "scaled", "geometry": "triangle-b", "material": "blue",
                "transform": [0.0, 2.0, 0.0, 0.0, -3.0, 0.0, 0.0, 0.0, 0.0, 0.0, 4.0, 0.0, 0.0, 0.0, 0.0, 1.0]
            },
            {
                "id": "mirrored", "geometry": "triangle-a", "material": "red",
                "transform": [-1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0, 1.0]
            },
            {
                "id": "regular-b", "geometry": "triangle-a", "material": "red",
                "transform": [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 2.0, 0.0, 0.0, 1.0]
            }
        ],
        "textures": []
    }))
    .expect("multi-resource packet")
}

fn assert_slice_close(actual: &[f32], expected: &[f32]) {
    assert_eq!(actual.len(), expected.len());
    for (index, (&actual, &expected)) in actual.iter().zip(expected).enumerate() {
        assert!(
            (actual - expected).abs() < 1e-6,
            "component {index}: expected {expected}, got {actual}"
        );
    }
}
