//! P1-23:四类高价值外部输入的版本化 schema(封闭枚举 + 显式版本字段)。
//!
//! 跨语言一致性约定(与 TS 侧 `deep2dDisplayList.ts` 同构):
//! - 信封 `kind` 是 kebab-case 的封闭判别字段,只有四类;
//! - `schemaVersion` 是显式字段,不在已定义清单里的版本由消费方拒绝(不猜测);
//! - 颜色 `[f64; 4]`、矩阵 `[f64; 6]`、zOrder `i32` 与 Deep2d 合同同形。

use serde::Deserialize;

use crate::behavior_ir::{BehaviorProperty, Scalar};

/// N1 适配器合同自身的版本号;适配器行为(而非输入)变化时递增。
pub const ADAPTER_N1_SCHEMA_VERSION: u32 = 1;

/// 已定义输入 schema 的版本清单。不在其中 → `Unknown`(语义未知,绝不猜测)。
pub const SUPPORTED_INPUT_SCHEMA_VERSIONS: [u32; 1] = [1];

/// 四类高价值输入的封闭判别枚举(信封 `kind` 字段的取值域)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum N1InputKind {
    Svg,
    RichTextInline,
    ChartExtension,
    AnimationAbi,
}

impl N1InputKind {
    pub const ALL: [N1InputKind; 4] = [
        Self::Svg,
        Self::RichTextInline,
        Self::ChartExtension,
        Self::AnimationAbi,
    ];
    /// 与信封 JSON 的判别值逐字一致。
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Svg => "svg",
            Self::RichTextInline => "rich-text-inline",
            Self::ChartExtension => "chart-extension",
            Self::AnimationAbi => "animation-abi",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SvgInputV1 {
    pub id: String,
    /// `[min_x, min_y, width, height]`;宽高必须为正且有限(适配阶段校验)。
    pub view_box: [f64; 4],
    pub paths: Vec<SvgPathSpecV1>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SvgPathSpecV1 {
    pub id: String,
    /// path data 子集:仅 `M m L l H h V v Z z`(支持矩阵见 `svg_parse`)。
    pub data: String,
    pub z_order: i32,
    pub fill: Option<[f64; 4]>,
    pub stroke: Option<[f64; 4]>,
    pub stroke_width: Option<f64>,
}

/// 富文本 inline 输入。区间形状与 `platform_text` 同构,但在这里独立定义,
/// 使 platform_text 无需为跨语言 JSON 添 serde,适配阶段再逐字转换。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RichTextInlineInputV1 {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub styles: Vec<RichTextStyleSpanV1>,
    #[serde(default)]
    pub paragraphs: Vec<RichTextParagraphV1>,
    #[serde(default)]
    pub inline_objects: Vec<InlineObjectV1>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RichTextStyleSpanV1 {
    pub start_cluster: usize,
    pub end_cluster: usize,
    /// 样式表内的小整数 id(与 `TextStyleId` 同构)。
    pub style: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RichTextParagraphV1 {
    pub start_cluster: usize,
    pub end_cluster: usize,
    pub align: RichTextAlignV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RichTextAlignV1 {
    Start,
    Center,
    End,
    Justify,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InlineObjectV1 {
    /// 插入在哪个簇之前;与 `InlineObject::at_cluster` 同义。
    pub at_cluster: usize,
    pub object_id: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ChartExtensionInputV1 {
    pub id: String,
    pub overlays: Vec<ChartOverlayV1>,
}

/// 图表扩展的封闭叠加集合;每条叠加适配为一个 path 资源 + 一个 path 命令。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, tag = "overlay", rename_all = "kebab-case")]
pub enum ChartOverlayV1 {
    #[serde(rename_all = "camelCase")]
    TrendLine {
        id: String,
        points: [[f64; 2]; 2],
        stroke: [f64; 4],
        stroke_width: f64,
        z_order: i32,
    },
    #[serde(rename_all = "camelCase")]
    ThresholdBand {
        id: String,
        x0: f64,
        y0: f64,
        x1: f64,
        y1: f64,
        fill: [f64; 4],
        z_order: i32,
    },
    #[serde(rename_all = "camelCase")]
    Marker {
        id: String,
        center: [f64; 2],
        radius: f64,
        fill: [f64; 4],
        z_order: i32,
    },
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AnimationAbiInputV1 {
    pub id: String,
    pub tracks: Vec<AnimationTrackV1>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AnimationTrackV1 {
    /// 必须是稳定节点 id(与 behavior_ir 同一校验)。
    pub node_id: String,
    pub property: AnimationPropertyV1,
    pub keyframes: Vec<AnimationKeyframeV1>,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AnimationKeyframeV1 {
    /// 注入时钟毫秒;轨迹必须按其严格递增且不重复。
    pub at_ms: u64,
    pub value: AnimationValueV1,
}

/// `BehaviorProperty` 无 serde 派生;此处镜像以保持 behavior_ir 零改动。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnimationPropertyV1 {
    Opacity,
    Rotation,
    Scale,
    Tint,
}

impl From<AnimationPropertyV1> for BehaviorProperty {
    fn from(value: AnimationPropertyV1) -> Self {
        match value {
            AnimationPropertyV1::Opacity => Self::Opacity,
            AnimationPropertyV1::Rotation => Self::Rotation,
            AnimationPropertyV1::Scale => Self::Scale,
            AnimationPropertyV1::Tint => Self::Tint,
        }
    }
}

/// `Scalar` 同理镜像;语义与 behavior_ir 的闭合标量一一对应。
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnimationValueV1 {
    Number(f64),
    Bool(bool),
    Index(u32),
}

impl AnimationValueV1 {
    pub fn to_scalar(self) -> Scalar {
        match self {
            Self::Number(value) => Scalar::Number(value),
            Self::Bool(value) => Scalar::Bool(value),
            Self::Index(value) => Scalar::Index(value),
        }
    }
}
