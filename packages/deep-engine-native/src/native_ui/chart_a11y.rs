//! P1-16: chart keyboard + screen-reader semantics. Pure CPU state machine:
//! key inputs map onto the SAME legend/zoom command vocabulary the pointer
//! pipeline dispatches (`LegendAction` / `ChartAction`) — keyboard never
//! mutates chart state directly. Focus visuals reuse the retained-UI
//! focus-ring geometry (`control_render::focus_ring_rect`); labels are
//! structured `a11y:*` announcements (NO OS screen-reader bridge yet).

use super::accessibility::{
    SemanticsError, SemanticsTree, UiAAction, build_semantics_tree, map_action_to_event,
};
use super::control_render::focus_ring_rect;
use super::retained_ui::{
    RETAINED_UI_SCHEMA_VERSION, RetainedUiA11y, RetainedUiAlign, RetainedUiContent,
    RetainedUiLayoutMode, RetainedUiNode, RetainedUiPointerEvents, RetainedUiRole, RetainedUiStyle,
    RetainedUiTree,
};

/// The legend mutation a focused key wants performed. Mirrors
/// `chart::legend::LegendAction` one-to-one without importing chart/ (this
/// module stays presentation-independent; the app wiring maps the types).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LegendCommand {
    Toggle(String),
    Page(usize),
}

/// One focusable legend entry: a series toggle or a page navigation arrow.
/// `rect` is the same layout rect the pointer path hit-tests, so the focus
/// ring and the click target can never disagree.
#[derive(Debug, Clone, PartialEq)]
pub struct LegendItemSnapshot {
    pub id: String,
    pub label: String,
    pub hidden: bool,
    pub rect: [f64; 4],
    pub command: LegendCommand,
}

/// What the keyboard layer may see this frame: the current legend page plus
/// the current zoom window of the X axis (wheel-parity input for shortcuts).
#[derive(Debug, Clone, PartialEq)]
pub struct LegendSnapshot {
    pub page: usize,
    pub pages: usize,
    pub zoom_window: (f64, f64),
    pub items: Vec<LegendItemSnapshot>,
}

/// Key inputs relevant to the chart; the window layer translates key codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChartKeyInput {
    Tab,
    Escape,
    Enter,
    Space,
    Next,
    Prev,
    ZoomIn,
    ZoomOut,
}

/// One response per input, mirroring the `controls::ControlResponse` style.
#[derive(Debug, Clone, PartialEq)]
pub enum ChartKeyResponse {
    /// Falls through to pre-existing bindings (camera rotate, Esc closes…).
    NotHandled,
    FocusChanged {
        item: usize,
        ring: [f64; 4],
        announcement: String,
        event: String,
    },
    FocusReleased,
    Activate {
        command: LegendCommand,
        announcement: String,
        event: String,
    },
    /// Normalized replacement window for the X axis — dispatched as
    /// `ChartAction::Zoom`, the exact action the wheel path uses.
    Zoom {
        start: f64,
        end: f64,
    },
}

/// Focus state for the chart legend (which item is focused, if any).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChartKeyboardState {
    focused: bool,
    item: Option<usize>,
}

impl ChartKeyboardState {
    pub const fn new() -> Self {
        Self {
            focused: false,
            item: None,
        }
    }

    pub fn focused_item(&self) -> Option<usize> {
        self.focused.then_some(self.item).flatten()
    }

    /// Consumes one key input against the current legend snapshot. Item focus
    /// is clamped when the page content shrinks, so a stale index can never
    /// activate an item that is no longer on screen.
    pub fn handle(&mut self, legend: &LegendSnapshot, input: ChartKeyInput) -> ChartKeyResponse {
        if legend.items.is_empty() {
            *self = Self::new();
            return match input {
                ChartKeyInput::ZoomIn | ChartKeyInput::ZoomOut => self.zoom(legend, input),
                _ => ChartKeyResponse::NotHandled,
            };
        }
        if let Some(index) = self.item {
            self.item = Some(index.min(legend.items.len() - 1));
        }
        match input {
            ChartKeyInput::ZoomIn | ChartKeyInput::ZoomOut => self.zoom(legend, input),
            ChartKeyInput::Tab => {
                if self.focused {
                    self.release()
                } else {
                    self.focus(legend, 0)
                }
            }
            ChartKeyInput::Escape if self.focused => self.release(),
            ChartKeyInput::Escape => ChartKeyResponse::NotHandled,
            ChartKeyInput::Enter | ChartKeyInput::Space => match self.focused_item() {
                None => ChartKeyResponse::NotHandled,
                Some(index) => {
                    let item = &legend.items[index];
                    ChartKeyResponse::Activate {
                        command: item.command.clone(),
                        announcement: item_announcement(legend, item),
                        event: map_action_to_event(&UiAAction::Invoke, &item.id),
                    }
                }
            },
            ChartKeyInput::Next | ChartKeyInput::Prev => {
                if !self.focused {
                    return ChartKeyResponse::NotHandled;
                }
                let delta = if input == ChartKeyInput::Next {
                    1isize
                } else {
                    -1
                };
                let current = self.item.unwrap_or(0) as isize;
                let next = (current + delta).clamp(0, legend.items.len() as isize - 1) as usize;
                self.focus(legend, next)
            }
        }
    }

    fn focus(&mut self, legend: &LegendSnapshot, index: usize) -> ChartKeyResponse {
        self.focused = true;
        self.item = Some(index);
        let item = &legend.items[index];
        ChartKeyResponse::FocusChanged {
            item: index,
            ring: focus_ring_rect(item.rect),
            announcement: item_announcement(legend, item),
            event: map_action_to_event(&UiAAction::Focus, &item.id),
        }
    }

    fn release(&mut self) -> ChartKeyResponse {
        *self = Self::new();
        ChartKeyResponse::FocusReleased
    }

    fn zoom(&mut self, legend: &LegendSnapshot, input: ChartKeyInput) -> ChartKeyResponse {
        let (start, end) = legend.zoom_window;
        match zoom_step_window(start, end, input == ChartKeyInput::ZoomIn) {
            Some((start, end)) => ChartKeyResponse::Zoom { start, end },
            None => ChartKeyResponse::NotHandled,
        }
    }
}

fn item_announcement(legend: &LegendSnapshot, item: &LegendItemSnapshot) -> String {
    match &item.command {
        LegendCommand::Toggle(_) => format!(
            "{}, {}",
            item.label,
            if item.hidden {
                "hidden, Enter shows"
            } else {
                "visible, Enter hides"
            }
        ),
        LegendCommand::Page(page) => format!("legend page {} of {}", page + 1, legend.pages.max(1)),
    }
}

/// Screen-reader fallback: project the legend into a semantics tree using the
/// existing accessibility helper — one labeled button per item under a chart
/// legend region. Callers hand this to the platform AT layer once a bridge
/// exists; until then it is the structured label list of record.
pub fn legend_semantics_tree(legend: &LegendSnapshot) -> Result<SemanticsTree, SemanticsError> {
    let style = RetainedUiStyle {
        layout: RetainedUiLayoutMode::Absolute,
        x: 0.0,
        y: 0.0,
        width: 1.0,
        height: 1.0,
        min_width: None,
        max_width: None,
        min_height: None,
        max_height: None,
        padding: 0.0,
        gap: 0.0,
        grow: 0.0,
        align: RetainedUiAlign::Start,
        clip: false,
        visible: true,
        opacity: 1.0,
        pointer_events: RetainedUiPointerEvents::Auto,
        z_index: 0,
        background: None,
        foreground: [1.0; 4],
        border_color: None,
        border_width: 0.0,
        corner_radius: 0.0,
        font_id: None,
        font_size: 14.0,
    };
    let item_node = |item: &LegendItemSnapshot| RetainedUiNode {
        id: item.id.clone(),
        revision: 0,
        parent_id: Some("chart-legend".into()),
        children: Vec::new(),
        style: style.clone(),
        content: RetainedUiContent::Container,
        a11y: RetainedUiA11y {
            role: RetainedUiRole::Button,
            label: Some(item_announcement(legend, item)),
            value: match &item.command {
                LegendCommand::Toggle(_) => {
                    Some(if item.hidden { "hidden" } else { "visible" }.to_owned())
                }
                LegendCommand::Page(_) => None,
            },
        },
    };
    let mut root = RetainedUiNode {
        id: "chart-legend".into(),
        revision: 0,
        parent_id: None,
        children: legend.items.iter().map(|item| item.id.clone()).collect(),
        style: style.clone(),
        content: RetainedUiContent::Container,
        a11y: RetainedUiA11y {
            role: RetainedUiRole::Region,
            label: Some("chart legend".into()),
            value: Some(format!(
                "page {} of {}",
                legend.page + 1,
                legend.pages.max(1)
            )),
        },
    };
    root.style.width = (legend.items.len() + 1) as f64;
    let mut nodes: Vec<RetainedUiNode> = legend.items.iter().map(item_node).collect();
    nodes.insert(0, root);
    let tree = RetainedUiTree {
        schema_version: RETAINED_UI_SCHEMA_VERSION,
        id: "chart-legend-semantics".into(),
        revision: 1,
        width: (legend.items.len() + 1) as f64,
        height: 1.0,
        root_id: "chart-legend".into(),
        nodes,
    };
    build_semantics_tree(&tree)
}

/// Wheel-parity zoom math (same factors/clamps as the app wheel handler):
/// span ×0.8 in / ×1.25 out, midpoint-centered, clamped to [0.01, 1.0].
/// Non-finite or empty windows are rejected instead of guessed.
pub fn zoom_step_window(start: f64, end: f64, zoom_in: bool) -> Option<(f64, f64)> {
    if !(start.is_finite() && end.is_finite() && start < end) {
        return None;
    }
    let span = ((end - start) * if zoom_in { 0.8 } else { 1.25 }).clamp(0.01, 1.0);
    let start = ((start + end - span) * 0.5).clamp(0.0, 1.0 - span);
    Some((start, start + span))
}

/// Stable a11y node id for a legend action (page-qualified, collision-free).
pub fn legend_item_id(page: usize, command: &LegendCommand) -> String {
    match command {
        LegendCommand::Toggle(series_id) => format!("legend:{page}:toggle:{series_id}"),
        LegendCommand::Page(target) => format!("legend:{page}:page:{target}"),
    }
}
