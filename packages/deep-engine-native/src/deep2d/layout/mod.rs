//! deep2d 组件布局引擎(刀 2):flex 树 → 确定性 solve → 绘制命令。
//!
//! 职责三分:
//! - [`LayoutStyle`]/[`tree::LayoutTree`]:布局树输入(flex-direction/justify/align/
//!   wrap/gap/padding/margin/固定尺寸/flex-grow-shrink),与渲染零耦合。
//! - [`solve::solve`]:纯函数求解,同输入逐位同输出(taffy 0.14.0 精确固定,
//!   `use_rounding` 显式开启做 CSS 式像素取整;黄金用例逐位钉死)。
//! - [`commands::to_display_list`]:solution → 标准 [`Deep2dCommand`]
//!   (容器=圆角矩形+可选渐变/纯色背景+可选阴影,走刀 1 的视觉三命令;
//!   文本 leaf 产出 [`TextCommand`],字体资源由宿主经 platform_text 提供)。
//!
//! 设计取舍(刀 1 教训的正向应用):**不新增 `Deep2dCommand` 枚举变体**——布局
//! 产出即是既有 Path/Text 命令,现有 validate/painter/cache/帧上下文原样生效,
//! chart_keyboard_smoke 与 dashboard_runtime 的穷尽 match 无需任何机械同步。
//!
//! 文本测量接缝留给 platform_text:[`solve::TextMeasurer`] 由调用方注入,
//! 未注入且文本 leaf 无固定尺寸时 fail-closed(报错,不静默按 0 布局)。

mod commands;
mod solve;
mod style;
mod tree;

#[cfg(test)]
mod golden_tests;

pub use commands::{to_commands, to_display_list, CommandParams};
pub use solve::{solve, LayoutRect, LayoutSolution, TextMeasureInput, TextMeasurer};
pub use style::{
    LayoutAlign, LayoutDirection, LayoutEdges, LayoutJustify, LayoutStyle, LayoutWrap,
};
pub use tree::{LayoutBoxVisual, LayoutLeaf, LayoutNode, LayoutTextSpec, LayoutTree, NodeId};

/// 布局域预算(fail-closed 上限,与 deep2d 校验链同一纪律)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LayoutBudgets {
    /// 节点总数上限。
    pub nodes: usize,
    /// 树深度上限(defends 递归 solve/round 的栈深度)。
    pub depth: usize,
    /// 单节点子数上限。
    pub children_per_node: usize,
}

pub const LAYOUT_BUDGETS: LayoutBudgets = LayoutBudgets {
    nodes: 16_384,
    depth: 128,
    children_per_node: 1_024,
};

/// 尺寸/位置数值上限:与 `runtime_composite` 的 2^24 界一致,防累积溢出。
pub(crate) const MAX_LAYOUT_VALUE: f32 = 16_777_216.0;
