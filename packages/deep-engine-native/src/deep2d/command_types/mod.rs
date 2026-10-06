//! Deep2d display-list 命令 wire 类型,按职责拆分(体量门,行为零变化):
//! `commands` 命令结构与词法枚举 / `paint` 绘制模型(含 Deep2dPaint 自定义
//! serde)/ `blend` GPUI 混合模式与背景模糊预算。公开面经本模块逐项
//! re-export(`deep2d::command_types::*` 路径逐项不变)。

mod blend;
mod commands;
mod paint;

/// Optional 字段容忍显式 `null`(宿主 wire 语义:null 与缺省等价)。
fn non_null_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

pub use blend::{
    BackdropBlur, Deep2dBlendMode, DEEP2D_MAX_BACKDROP_COMMANDS_PER_FRAME,
    DEEP2D_MAX_BACKDROP_RADIUS, backdrop_blur_iterations,
};
pub use commands::{
    BakedGlyphPlacement, Deep2dCommand, FillRule, ImageCommand, ImageSampling, LineCap, LineJoin,
    PathCommand, TextAlign, TextBaseline, TextDirection, TextCommand,
};
pub use paint::{BoxShadow, Deep2dPaint, GradientStop, LinearGradientPaint, RadialGradientPaint};
