use crate::{
    contract::AlphaMode,
    scene::{DrawBatch, SceneAlphaSummary},
};

pub fn alpha_summary(batches: &[DrawBatch]) -> SceneAlphaSummary {
    let mut summary = SceneAlphaSummary::default();
    for batch in batches {
        match batch.alpha_mode {
            AlphaMode::Opaque => summary.opaque_batches += 1,
            AlphaMode::Mask => summary.mask_batches += 1,
            AlphaMode::Blend => summary.blend_batches += 1,
        }
        summary.double_sided_batches += usize::from(batch.double_sided);
    }
    summary
}

pub fn transparent_batch_order(batches: &[DrawBatch], yaw: f32) -> Vec<usize> {
    let mut order: Vec<_> = batches
        .iter()
        .enumerate()
        .filter_map(|(index, batch)| (batch.alpha_mode == AlphaMode::Blend).then_some(index))
        .collect();
    order.sort_by(|&a, &b| {
        let a_batch = &batches[a];
        let b_batch = &batches[b];
        let a_depth = view_depth(a_batch.sort_center.expect("BLEND sort center"), yaw);
        let b_depth = view_depth(b_batch.sort_center.expect("BLEND sort center"), yaw);
        b_depth
            .total_cmp(&a_depth)
            .then_with(|| a_batch.stable_order.cmp(&b_batch.stable_order))
    });
    order
}

fn view_depth(center: [f32; 3], yaw: f32) -> f32 {
    let rotated_z = -center[0] * yaw.sin() + center[2] * yaw.cos();
    4.0 - rotated_z
}
