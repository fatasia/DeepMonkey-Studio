//! 宿主声明的帧级依赖上下文(刀 3 自 deep2d_gpu.rs 抽出,体量门)。
//!
//! 两个维度都必须在 `prepare` 之前定格,原因见 `painter_cache::EntryWitness`:
//! - `resource_epoch` 承载内容来源代次(本包内 legend 页等呈现资源集换代;
//!   换包走新建缓存,天然隔离);
//! - `camera_scale` 是**物理像素/逻辑单位**的实际缩放比,由 letterbox 映射算得,
//!   直接决定描边容差与曲线细分密度。
//!
//! 未提供上下文时缓存两侧维度保持 `None`,行为与第一批逐字节一致。

use deep_engine_native::deep2d::Deep2dRuntimeContent;
/// 宿主声明的帧级依赖上下文,喂给 `Deep2dPathCache` 的依赖图(P1-02)。
///
/// 两个维度都必须在 `prepare` 之前定格,原因见 `painter_cache::EntryWitness`:
/// - `resource_epoch` 承载内容来源代次(本包内 legend 页等呈现资源集换代;
///   换包走新建缓存,天然隔离);
/// - `camera_scale` 是**物理像素/逻辑单位**的实际缩放比,由 letterbox 映射算得,
///   直接决定描边容差与曲线细分密度。
///
/// 未提供上下文时缓存两侧维度保持 `None`,行为与第一批逐字节一致。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Deep2dFrameContext {
    pub resource_epoch: u64,
    pub camera_scale: f64,
}

/// 由内容与物理尺寸装配帧级上下文。
///
/// 缩放口径必须是「物理像素 / 逻辑单位」的实际比值,而不是窗口 DPI 标称值:
/// 二者只在逻辑尺寸等于物理尺寸时相同,非等比窗口下 letterbox 会取宽高比的
/// 最小值而缩小实际缩放。命中与绘制用的是同一个 `LetterboxMapping`,这里取
/// 同一映射的 `scale`,保证「见证 / 细分 / 命中」三者同源。
pub fn deep2d_frame_context(
    content: &Deep2dRuntimeContent,
    physical: [u32; 2],
    resource_epoch: u64,
) -> Deep2dFrameContext {
    let list = content.display_list();
    let logical = [list.logical_width, list.logical_height];
    let usable = physical[0] != 0
        && physical[1] != 0
        && logical[0].is_finite()
        && logical[1].is_finite()
        && logical[0] > 0.0
        && logical[1] > 0.0;
    let camera_scale = if usable {
        deep_engine_native::deep2d::LetterboxMapping::new(
            logical,
            [physical[0].into(), physical[1].into()],
        )
        .scale
    } else {
        // 退化窗口没有可用映射;显式声明 1:1 而不是留空,
        // 让「窗口从 0 尺寸恢复」也有确定性见证。
        1.0
    };
    Deep2dFrameContext {
        resource_epoch,
        camera_scale,
    }
}
