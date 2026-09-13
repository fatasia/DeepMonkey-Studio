use crate::{player_content::PlayerContent, shader_material_renderer::Snapshot};

pub fn force_high(content: &mut PlayerContent) {
    content.mutate_packet_for_test(|packet| {
        for instance in &mut packet.instances {
            let levels = &mut instance.lod.as_mut().unwrap().levels;
            levels[0].min_projected_diameter_pixels = 0.002;
            levels[1].min_projected_diameter_pixels = 0.001;
        }
    });
}

pub fn force_low(content: &mut PlayerContent) {
    content.mutate_packet_for_test(|packet| {
        for instance in &mut packet.instances {
            instance.lod.as_mut().unwrap().levels[0].min_projected_diameter_pixels = 1e8;
        }
    });
}

pub fn direct_low(content: &mut PlayerContent) {
    content.mutate_packet_for_test(|packet| {
        for instance in &mut packet.instances {
            instance.geometry = instance
                .lod
                .take()
                .unwrap()
                .levels
                .last()
                .unwrap()
                .geometry
                .clone();
        }
    });
}

pub fn verify_commands(snapshot: &Snapshot, level: usize, index_count: u32) {
    assert_eq!(snapshot.commands.len(), 5);
    assert!(snapshot.nonzero_vertex_offsets >= 4);
    assert_eq!(
        snapshot.commands[0].iter().map(|draw| draw[1]).sum::<u32>(),
        7
    );
    for commands in &snapshot.commands {
        for (index, draw) in commands.iter().enumerate() {
            assert_eq!(
                draw[2..],
                [0, 0, 0],
                "each sliced draw uses firstInstance = 0"
            );
            if index % 3 != level {
                assert_eq!(draw[1], 0, "an unselected LOD was drawn");
            }
            if draw[1] > 0 {
                assert_eq!(
                    draw[0], index_count,
                    "selected geometry has the wrong index count"
                );
            }
        }
    }
}

pub fn color_changes(left: &Snapshot, right: &Snapshot) -> usize {
    assert_eq!(left.hdr.len(), 256 * 256 * 8);
    assert_eq!(left.hdr.len(), right.hdr.len());
    left.hdr
        .chunks_exact(8)
        .zip(right.hdr.chunks_exact(8))
        .filter(|(a, b)| a != b)
        .count()
}

pub fn depth_changes(left: &Snapshot, right: &Snapshot) -> Vec<usize> {
    assert_eq!(left.shadow_size, right.shadow_size);
    let layer_size = left.shadow_size as usize * left.shadow_size as usize;
    assert_eq!(left.depths.len(), 4 * layer_size);
    assert_eq!(left.depths.len(), right.depths.len());
    assert!(
        left.depths
            .iter()
            .chain(&right.depths)
            .all(|value| value.is_finite())
    );
    left.depths
        .chunks_exact(layer_size)
        .zip(right.depths.chunks_exact(layer_size))
        .map(|(a, b)| a.iter().zip(b).filter(|(x, y)| x != y).count())
        .collect()
}

pub fn verify_low_matches_direct(low: &Snapshot, direct: &Snapshot) {
    assert_eq!(
        color_changes(low, direct),
        0,
        "custom GPU LOD low color differs from direct low geometry"
    );
    assert_eq!(
        depth_changes(low, direct),
        [0; 4],
        "custom GPU LOD low casters differ from direct low geometry"
    );
    let layer_size = low.shadow_size as usize * low.shadow_size as usize;
    assert!(
        low.depths
            .chunks_exact(layer_size)
            .all(|layer| layer.iter().any(|&value| value < 1.0))
    );
}
