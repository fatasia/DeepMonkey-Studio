//! Deterministic instance operations shared by the opt-in native fixture probe.
use crate::contract::RenderPacket;
#[cfg(test)]
use serde_json::json;
pub fn rotate(transform: &mut [f32; 16], angle: f32, index: usize) {
    let (sin, cos) = angle.sin_cos();
    let sx = 0.55;
    let sy = 0.55 + (index % 4) as f32 * 0.08;
    transform[..12].copy_from_slice(&[
        cos * sx,
        0.0,
        -sin * sx,
        0.0,
        0.0,
        sy,
        0.0,
        0.0,
        sin * sx,
        0.0,
        cos * sx,
        0.0,
    ]);
}

pub fn fixture_indices(packet: &RenderPacket) -> Option<Vec<usize>> {
    let mut indices = vec![usize::MAX; packet.instances.len().checked_sub(1)?];
    for (slot, item) in packet.instances.iter().enumerate() {
        if item.id == "fixture-ground" {
            continue;
        }
        let index: usize = item.id.strip_prefix("fixture-")?.parse().ok()?;
        let value = indices.get_mut(index)?;
        if *value != usize::MAX {
            return None;
        }
        *value = slot;
    }
    indices.iter().all(|&i| i != usize::MAX).then_some(indices)
}

pub fn rebuild(
    baseline: &RenderPacket,
    indices: &[usize],
    colors: &[String],
    cycle: usize,
    next: &mut RenderPacket,
) {
    for (i, &slot) in indices.iter().enumerate() {
        let mut item = baseline.instances[slot].clone();
        item.id = format!("fixture-{i}#rebuild-{cycle}");
        item.material = colors[(i + cycle) % colors.len()].clone();
        rotate(
            &mut item.transform,
            i as f32 * 0.17 + cycle as f32 * 0.03,
            i,
        );
        next.instances[slot] = item;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rotation_preserves_position_and_matches_fixture_scale() {
        let mut matrix = [0.0; 16];
        matrix[12..].copy_from_slice(&[2.0, 3.0, 4.0, 1.0]);
        rotate(&mut matrix, std::f32::consts::FRAC_PI_2, 3);
        assert!((matrix[2] + 0.55).abs() < 1e-6);
        assert!((matrix[8] - 0.55).abs() < 1e-6);
        assert!((matrix[5] - 0.79).abs() < 1e-6);
        assert_eq!(&matrix[12..], &[2.0, 3.0, 4.0, 1.0]);
    }

    #[test]
    fn rebuild_replaces_identity_and_reuses_resources_for_twenty_cycles() {
        let baseline: RenderPacket = serde_json::from_value(json!({ "schema": "test", "version": 1,
            "geometries": [], "materials": [], "instances": [
                { "id": "fixture-1", "geometry": "sphere", "material": "green", "transform": [1,0,0,0,0,1,0,0,0,0,1,0,4,1,3,1] },
                { "id": "fixture-ground", "geometry": "plane", "material": "ground", "transform": [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1] },
                { "id": "fixture-0", "geometry": "box", "material": "gold", "transform": [1,0,0,0,0,1,0,0,0,0,1,0,2,1,3,1] }
            ] })).unwrap();
        let indices = fixture_indices(&baseline).unwrap();
        assert_eq!(indices, [2, 0]);
        let mut next = baseline.clone();
        for cycle in 1..=20 {
            let previous_ids: Vec<_> = next.instances.iter().map(|item| item.id.clone()).collect();
            rebuild(
                &baseline,
                &indices,
                &["gold".into(), "green".into()],
                cycle,
                &mut next,
            );
            for (index, &slot) in indices.iter().enumerate() {
                assert_ne!(next.instances[slot].id, previous_ids[slot]);
                assert_eq!(
                    next.instances[slot].geometry,
                    baseline.instances[slot].geometry
                );
                assert_eq!(
                    next.instances[slot].material,
                    if (index + cycle) % 2 == 0 {
                        "gold"
                    } else {
                        "green"
                    }
                );
                assert_eq!(
                    &next.instances[slot].transform[12..],
                    &baseline.instances[slot].transform[12..]
                );
            }
            assert_eq!(next.instances[1].id, "fixture-ground");
            assert_eq!(next.instances[1].transform, baseline.instances[1].transform);
        }
        next.instances[0].id = "fixture-0".into();
        next.instances[2].id = "fixture-0".into();
        assert!(fixture_indices(&next).is_none());
    }
}
