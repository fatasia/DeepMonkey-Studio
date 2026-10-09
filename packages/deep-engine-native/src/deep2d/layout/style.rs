//! 布局样式合同:刀 2 要求面的最小 flex 语义面,独立于 taffy 类型。
//!
//! 默认值跟随 CSS:flex-direction=row、justify=flex-start、align-items=stretch、
//! flex-grow=0、flex-shrink=1、gap/padding/margin=0、尺寸=auto(None)。

use taffy::prelude::TaffyAuto;

/// 主轴方向。仅 Row/Column(reverse 语义未进刀 2 合同,保持范围克制)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LayoutDirection {
    #[default]
    Row,
    Column,
}

/// 主轴分布(六态,CSS flex `justify-content` 子集)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LayoutJustify {
    #[default]
    FlexStart,
    FlexEnd,
    Center,
    SpaceBetween,
    SpaceAround,
    SpaceEvenly,
}

/// 交叉轴对齐(CSS flex `align-items`;`align_self` 覆盖单项)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LayoutAlign {
    #[default]
    Stretch,
    Start,
    Center,
    End,
}

/// 主轴换行。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LayoutWrap {
    #[default]
    NoWrap,
    Wrap,
}

/// CSS 物理四边。padding 非负;margin 允许有限负值(CSS 语义),
/// solve 时统一做 fail-closed 校验。
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct LayoutEdges {
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
    pub left: f32,
}

impl LayoutEdges {
    pub const ZERO: Self = Self {
        top: 0.0,
        right: 0.0,
        bottom: 0.0,
        left: 0.0,
    };

    pub const fn uniform(value: f32) -> Self {
        Self {
            top: value,
            right: value,
            bottom: value,
            left: value,
        }
    }
}

/// 单节点 flex 样式。字段默认值 = CSS 初始值。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LayoutStyle {
    pub direction: LayoutDirection,
    pub wrap: LayoutWrap,
    pub justify: LayoutJustify,
    pub align_items: LayoutAlign,
    /// 覆盖父容器 `align_items` 对本节点的作用(None = 不覆盖)。
    pub align_self: Option<LayoutAlign>,
    /// 列间隙(row 主轴下的项间距;column 主轴下是行间距)。
    pub column_gap: f32,
    /// 行间隙(row 主轴下是换行行距;column 主轴下的项间距)。
    pub row_gap: f32,
    pub padding: LayoutEdges,
    pub margin: LayoutEdges,
    /// 固定宽(None = auto)。
    pub width: Option<f32>,
    /// 固定高(None = auto)。
    pub height: Option<f32>,
    pub flex_grow: f32,
    pub flex_shrink: f32,
}

impl LayoutStyle {
    pub const fn new() -> Self {
        Self {
            direction: LayoutDirection::Row,
            wrap: LayoutWrap::NoWrap,
            justify: LayoutJustify::FlexStart,
            align_items: LayoutAlign::Stretch,
            align_self: None,
            column_gap: 0.0,
            row_gap: 0.0,
            padding: LayoutEdges::ZERO,
            margin: LayoutEdges::ZERO,
            width: None,
            height: None,
            flex_grow: 0.0,
            flex_shrink: 1.0,
        }
    }

    /// 固定尺寸便捷构造(auto 尺寸叶子最常见的形态)。
    pub const fn size(width: f32, height: f32) -> Self {
        let mut style = Self::new();
        style.width = Some(width);
        style.height = Some(height);
        style
    }
}

impl From<&LayoutStyle> for taffy::Style {
    fn from(value: &LayoutStyle) -> Self {
        let align = |align: LayoutAlign| match align {
            LayoutAlign::Stretch => taffy::AlignItems::STRETCH,
            LayoutAlign::Start => taffy::AlignItems::FLEX_START,
            LayoutAlign::Center => taffy::AlignItems::CENTER,
            LayoutAlign::End => taffy::AlignItems::FLEX_END,
        };
        taffy::Style {
            display: taffy::Display::Flex,
            flex_direction: match value.direction {
                LayoutDirection::Row => taffy::FlexDirection::Row,
                LayoutDirection::Column => taffy::FlexDirection::Column,
            },
            flex_wrap: match value.wrap {
                LayoutWrap::NoWrap => taffy::FlexWrap::NoWrap,
                LayoutWrap::Wrap => taffy::FlexWrap::Wrap,
            },
            justify_content: Some(match value.justify {
                LayoutJustify::FlexStart => taffy::AlignContent::FLEX_START,
                LayoutJustify::FlexEnd => taffy::AlignContent::FLEX_END,
                LayoutJustify::Center => taffy::AlignContent::CENTER,
                LayoutJustify::SpaceBetween => taffy::AlignContent::SPACE_BETWEEN,
                LayoutJustify::SpaceAround => taffy::AlignContent::SPACE_AROUND,
                LayoutJustify::SpaceEvenly => taffy::AlignContent::SPACE_EVENLY,
            }),
            align_items: Some(align(value.align_items)),
            align_self: value.align_self.map(align),
            gap: taffy::Size {
                width: taffy::LengthPercentage::length(value.column_gap),
                height: taffy::LengthPercentage::length(value.row_gap),
            },
            padding: taffy::Rect {
                left: taffy::LengthPercentage::length(value.padding.left),
                right: taffy::LengthPercentage::length(value.padding.right),
                top: taffy::LengthPercentage::length(value.padding.top),
                bottom: taffy::LengthPercentage::length(value.padding.bottom),
            },
            margin: taffy::Rect {
                left: taffy::LengthPercentageAuto::length(value.margin.left),
                right: taffy::LengthPercentageAuto::length(value.margin.right),
                top: taffy::LengthPercentageAuto::length(value.margin.top),
                bottom: taffy::LengthPercentageAuto::length(value.margin.bottom),
            },
            size: taffy::Size {
                width: value
                    .width
                    .map_or(taffy::Dimension::AUTO, taffy::Dimension::length),
                height: value
                    .height
                    .map_or(taffy::Dimension::AUTO, taffy::Dimension::length),
            },
            flex_grow: value.flex_grow,
            flex_shrink: value.flex_shrink,
            ..taffy::Style::default()
        }
    }
}

#[cfg(test)]
mod style_tests {
    use super::*;

    #[test]
    fn defaults_follow_css_initial_values() {
        let style = LayoutStyle::new();
        assert_eq!(style.direction, LayoutDirection::Row);
        assert_eq!(style.justify, LayoutJustify::FlexStart);
        assert_eq!(style.align_items, LayoutAlign::Stretch);
        assert_eq!(style.flex_grow, 0.0);
        assert_eq!(style.flex_shrink, 1.0);
        assert_eq!(style.width, None);
        assert_eq!(style.padding, LayoutEdges::ZERO);
    }

    #[test]
    fn converts_all_six_justify_states_directions_and_wrap() {
        let cases = [
            (LayoutJustify::FlexStart, taffy::AlignContent::FLEX_START),
            (LayoutJustify::FlexEnd, taffy::AlignContent::FLEX_END),
            (LayoutJustify::Center, taffy::AlignContent::CENTER),
            (
                LayoutJustify::SpaceBetween,
                taffy::AlignContent::SPACE_BETWEEN,
            ),
            (
                LayoutJustify::SpaceAround,
                taffy::AlignContent::SPACE_AROUND,
            ),
            (
                LayoutJustify::SpaceEvenly,
                taffy::AlignContent::SPACE_EVENLY,
            ),
        ];
        for (mine, taffy_value) in cases {
            let style = LayoutStyle {
                justify: mine,
                ..LayoutStyle::new()
            };
            let converted = taffy::Style::from(&style);
            assert_eq!(converted.justify_content, Some(taffy_value));
        }
        let column = taffy::Style::from(&LayoutStyle {
            direction: LayoutDirection::Column,
            ..LayoutStyle::new()
        });
        assert_eq!(column.flex_direction, taffy::FlexDirection::Column);
        assert_eq!(column.display, taffy::Display::Flex);
        let wrapped = taffy::Style::from(&LayoutStyle {
            wrap: LayoutWrap::Wrap,
            ..LayoutStyle::new()
        });
        assert_eq!(wrapped.flex_wrap, taffy::FlexWrap::Wrap);
        let aligned = taffy::Style::from(&LayoutStyle {
            align_self: Some(LayoutAlign::Center),
            ..LayoutStyle::new()
        });
        assert_eq!(aligned.align_self, Some(taffy::AlignItems::CENTER));
    }

    #[test]
    fn fixed_size_and_edges_travel_as_lengths() {
        let converted = taffy::Style::from(&LayoutStyle {
            width: Some(40.0),
            height: Some(24.0),
            column_gap: 8.0,
            row_gap: 4.0,
            padding: LayoutEdges::uniform(6.0),
            margin: LayoutEdges {
                top: 1.0,
                right: 2.0,
                bottom: 3.0,
                left: 4.0,
            },
            ..LayoutStyle::new()
        });
        assert_eq!(converted.size.width, taffy::Dimension::length(40.0));
        assert_eq!(converted.size.height, taffy::Dimension::length(24.0));
        assert_eq!(converted.gap.width, taffy::LengthPercentage::length(8.0));
        assert_eq!(converted.gap.height, taffy::LengthPercentage::length(4.0));
        assert_eq!(converted.padding.top, taffy::LengthPercentage::length(6.0));
        assert_eq!(
            converted.margin.left,
            taffy::LengthPercentageAuto::length(4.0)
        );
    }
}
