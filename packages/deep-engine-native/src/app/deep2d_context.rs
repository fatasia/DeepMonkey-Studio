//! 帧级依赖上下文装配:把宿主真实状态(epoch 资源代次、letterbox 物理缩放)
//! 折算成 `Deep2dFrameContext` 喂给 Deep2d 路径缓存依赖图(P1-02 宿主接线)。
//!
//! 纯计算在 `deep2d_gpu::deep2d_frame_context`(renderer 与 app 共用同一实现),
//! 本模块只负责把窗口尺寸与活动 epoch 取出来。
//!
//! 刀 2 组件布局接线:布局树经 [`layout_content`] 变成标准 DisplayList 内容——
//! 布局产出即既有 Path/Text 命令(零新增 Deep2dCommand 变体,chart/dashboard
//! 的穷尽 match 无需机械同步),帧上下文、路径缓存依赖与 GPU 管线原样生效。

use deep_engine_native::deep2d::layout::{
    CommandParams, LayoutTree, TextMeasurer, solve, to_display_list,
};
use deep_engine_native::deep2d::{Deep2dRuntimeContent, FontResource};

use crate::app::NativeApp;
use crate::deep2d_frame_context::{Deep2dFrameContext, deep2d_frame_context};

/// 组件布局内容注册:LayoutTree + 视口 → 可进帧流程的运行时内容。
///
/// `id` 同时用作显示列表 id 与资源 id 前缀(须为合法 deep2d id 字符);
/// `fonts` 是文本 leaf 引用的宿主字体资源表(platform_text 接缝,缺引用
/// fail-closed);`text_measurer` 为 auto 尺寸文本提供固有尺寸。
/// `pub(crate)`:根级 GPU readback 测试复用同一条接线(与运行时同路径);
/// 本刀的消费方是接线测试与 GPU 黄金样例,app 内容路径(播放器/仪表盘)
/// 接入组件 UI 时直接调用本函数。
#[allow(dead_code)]
pub(crate) fn layout_content<'a>(
    tree: &'a LayoutTree,
    viewport: [f32; 2],
    id: &str,
    revision: u64,
    fonts: &[FontResource],
    text_measurer: Option<TextMeasurer<'a>>,
) -> Result<Deep2dRuntimeContent, String> {
    let solution = solve(tree, viewport, text_measurer)?;
    let display_list = to_display_list(
        tree,
        &solution,
        id,
        revision,
        &CommandParams {
            id_prefix: id,
            fonts,
        },
    )?;
    Ok(Deep2dRuntimeContent::DisplayList(display_list))
}

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
    use crate::deep2d_frame_context::deep2d_frame_context;
    use deep_engine_native::deep2d::layout::{LayoutBoxVisual, LayoutNode, NodeId};
    use deep_engine_native::deep2d::layout::{LayoutEdges, LayoutStyle};
    use deep_engine_native::deep2d::{
        BoxShadow, Deep2dPaint, GradientStop, LinearGradientPaint, validate_display_list,
    };

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

    /// 最小组件样例:卡片(圆角+阴影+渐变头)+ 文本占位 + 图标占位的 flex 排布。
    fn golden_card_tree() -> LayoutTree {
        let card_visual = LayoutBoxVisual {
            background: Some(Deep2dPaint::Solid([0.08, 0.09, 0.11, 1.0])),
            corner_radius: 12.0,
            shadow: Some(BoxShadow {
                offset_x: 0.0,
                offset_y: 6.0,
                blur_radius: 16.0,
                spread: 0.0,
                color: [0.0, 0.0, 0.0, 0.45],
                corner_radius: None,
            }),
            blend: None,
            backdrop_blur: None,
        };
        let header_visual = LayoutBoxVisual {
            background: Some(Deep2dPaint::LinearGradient(LinearGradientPaint {
                start: [0.0, 0.0],
                end: [240.0, 0.0],
                stops: vec![
                    GradientStop {
                        offset: 0.0,
                        color: [0.16, 0.35, 0.85, 1.0],
                    },
                    GradientStop {
                        offset: 1.0,
                        color: [0.45, 0.2, 0.8, 1.0],
                    },
                ],
            })),
            corner_radius: 8.0,
            shadow: None,
            blend: None,
            backdrop_blur: None,
        };
        let mut tree = LayoutTree::new(
            LayoutNode::box_node(LayoutStyle {
                direction: deep_engine_native::deep2d::layout::LayoutDirection::Column,
                padding: LayoutEdges::uniform(12.0),
                ..LayoutStyle::size(240.0, 160.0)
            })
            .with_visual(card_visual),
        );
        let header = tree
            .append(
                NodeId::ROOT,
                LayoutNode::box_node(LayoutStyle::size(216.0, 36.0)).with_visual(header_visual),
            )
            .expect("header");
        let body = tree
            .append(
                NodeId::ROOT,
                LayoutNode::box_node(LayoutStyle {
                    column_gap: 12.0,
                    align_items: deep_engine_native::deep2d::layout::LayoutAlign::Center,
                    ..LayoutStyle::size(216.0, 88.0)
                }),
            )
            .expect("body");
        // 图标占位:固定尺寸小方盒(实底圆角)。
        tree.append(
            body,
            LayoutNode::box_node(LayoutStyle::size(24.0, 24.0)).with_visual(LayoutBoxVisual {
                background: Some(Deep2dPaint::Solid([0.95, 0.62, 0.18, 1.0])),
                corner_radius: 6.0,
                shadow: None,
                blend: None,
                backdrop_blur: None,
            }),
        )
        .expect("icon");
        // 文本占位:固定尺寸灰盒(字形排布留给 platform_text 接缝)。
        tree.append(
            body,
            LayoutNode::box_node(LayoutStyle::size(140.0, 18.0)).with_visual(LayoutBoxVisual {
                background: Some(Deep2dPaint::Solid([0.22, 0.25, 0.3, 1.0])),
                corner_radius: 4.0,
                shadow: None,
                blend: None,
                backdrop_blur: None,
            }),
        )
        .expect("text placeholder");
        let _ = header;
        tree
    }

    #[test]
    fn layout_content_produces_display_list_that_passes_frozen_validation() {
        // 接线证明:布局产出走既有校验链(刀 1 fail-closed 规则)零改动通过。
        let content = layout_content(
            &golden_card_tree(),
            [240.0, 160.0],
            "golden-card",
            11,
            &[],
            None,
        )
        .expect("layout content");
        let Deep2dRuntimeContent::DisplayList(list) = &content else {
            panic!("layout content is a display list");
        };
        assert_eq!(list.id, "golden-card");
        assert_eq!(list.revision, 11);
        let validation = validate_display_list(list);
        assert!(
            validation.valid,
            "frozen validation chain must accept layout output: {:?}",
            validation.issues
        );
        // 卡片背景+渐变头+图标+文本占位 = 4 条视觉命令;阴影命令带 cornerRadius。
        assert_eq!(list.commands.len(), 4);
    }

    #[test]
    fn layout_content_propagates_solve_failures() {
        let bad = LayoutTree::new(LayoutNode::box_node(LayoutStyle {
            padding: LayoutEdges::uniform(-3.0),
            ..LayoutStyle::size(10.0, 10.0)
        }));
        let error = layout_content(&bad, [10.0, 10.0], "bad", 1, &[], None)
            .expect_err("negative padding fails closed");
        assert!(error.contains("padding edge 'top'"), "{error}");
    }
}
