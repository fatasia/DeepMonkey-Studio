use bytemuck::pod_read_unaligned;
use deep_engine_native::{
    cascaded_shadow::{CascadedShadowCamera, CascadedShadowOptions},
    mesh_abi::{FRAME_UNIFORM_BYTES, FrameUniform, frame_uniform},
};

use super::pack_shadow_frames;

#[test]
fn packs_one_frozen_frame_abi_per_cascade_at_dynamic_offsets() {
    let frame = frame_uniform(16.0 / 9.0, 0.55);
    let plan = deep_engine_native::cascaded_shadow::plan_cascaded_shadows(
        CascadedShadowCamera {
            eye: [0.0, 0.0, 4.0],
            target: [0.0; 3],
            up: [0.0, 1.0, 0.0],
            vertical_fov_radians: 1.0,
            aspect: 16.0 / 9.0,
            near: 0.1,
            far: 100.0,
        },
        [0.0, -1.0, -1.0],
        CascadedShadowOptions::default(),
    )
    .unwrap();
    // 动态 offset 步长必须容纳完整 frame ABI（v6 = 1920B）并对齐 256。
    let stride = FRAME_UNIFORM_BYTES.next_multiple_of(256);
    let packed = pack_shadow_frames(&frame, &plan, stride);
    assert_eq!(packed.len(), stride as usize * plan.cascades.len());
    for (index, cascade) in plan.cascades.iter().enumerate() {
        let offset = index * stride as usize;
        let end = offset + size_of::<FrameUniform>();
        let unpacked = pod_read_unaligned::<FrameUniform>(&packed[offset..end]);
        assert_eq!(&unpacked[..4], &frame[..4]);
        assert_eq!(&unpacked[4..8], &cascade.view_projection);
        assert_eq!(&unpacked[8..], &frame[8..]);
    }
}
