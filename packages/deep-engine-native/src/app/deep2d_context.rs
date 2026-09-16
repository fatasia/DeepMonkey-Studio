//! 帧级依赖上下文装配:把宿主真实状态(epoch 资源代次、letterbox 物理缩放)
//! 折算成 `Deep2dFrameContext` 喂给 Deep2d 路径缓存依赖图(P1-02 宿主接线)。
//!
//! 纯计算在 `deep2d_gpu::deep2d_frame_context`(renderer 与 app 共用同一实现),
//! 本模块只负责把窗口尺寸与活动 epoch 取出来。

use deep_engine_native::deep2d::Deep2dRuntimeContent;

use crate::app::NativeApp;
use crate::deep2d_gpu::{Deep2dFrameContext, deep2d_frame_context};

/// 从活动内容与窗口状态装配上下文。
///
/// `resource_epoch` 必须描述**正在暂存的新内容**,而不是暂存前的旧代:
/// 换页时资源集已经变了,若传旧 epoch 该维度就看不出变化,旧条目会被误判命中。
/// 因此换页传新页号,其余动作传当前 `resource_set`(保持不变)。
/// 窗口未就绪时返回 `None`,让调用方退回无上下文的旧路径。
pub(super) fn active_frame_context(
    app: &NativeApp,
    content: &Deep2dRuntimeContent,
    resource_epoch: u64,
) -> Option<Deep2dFrameContext> {
    let size = app.window.as_ref()?.inner_size();
    Some(deep2d_frame_context(
        content,
        [size.width, size.height],
        resource_epoch,
    ))
}

/// 当前活动 epoch 的资源代次(未换资源集的动作用它)。
pub(super) fn current_resource_epoch(app: &NativeApp) -> u64 {
    app.content.active().epoch.resource_set
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deep2d_gpu::deep2d_frame_context;

    fn content(w: f64, h: f64) -> Deep2dRuntimeContent {
        let mut list = deep_engine_native::deep2d::decode_display_list(include_bytes!(
            "../../fixtures/deep2d_tessellated_v1.json"
        ))
        .unwrap();
        list.logical_width = w;
        list.logical_height = h;
        Deep2dRuntimeContent::DisplayList(list)
    }

    #[test]
    fn scale_matches_letterbox_ratio_and_shrinks_for_non_uniform_windows() {
        // 逻辑 640x360,物理 1280x720 → 恰好 2 倍。
        let context = deep2d_frame_context(&content(640.0, 360.0), [1280, 720], 7);
        assert_eq!(context.resource_epoch, 7);
        assert!((context.camera_scale - 2.0).abs() < 1e-9);

        // 非等比:物理 1280x1080 时 letterbox 取 min(2.0, 3.0) = 2.0,而不是 3.0。
        let letterboxed = deep2d_frame_context(&content(640.0, 360.0), [1280, 1080], 7);
        assert!((letterboxed.camera_scale - 2.0).abs() < 1e-9);
        // 横向被压缩:物理 640x1080 时取 min(1.0, 3.0) = 1.0。
        let squeezed = deep2d_frame_context(&content(640.0, 360.0), [640, 1080], 7);
        assert!((squeezed.camera_scale - 1.0).abs() < 1e-9);
    }

    #[test]
    fn degenerate_windows_declare_unit_scale_instead_of_leaving_it_unset() {
        assert_eq!(
            deep2d_frame_context(&content(640.0, 360.0), [0, 0], 1).camera_scale,
            1.0
        );
        assert_eq!(
            deep2d_frame_context(&content(0.0, 360.0), [640, 360], 1).camera_scale,
            1.0
        );
    }
}
