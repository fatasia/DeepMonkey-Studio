//! Native UI contract modules: retained-tree reader/validator (U01) lives
//! here; layout/paint/event runtime stages will grow in sibling modules.

pub mod accessibility;
pub mod chart_a11y;
pub mod control_render;
pub mod controls;
pub mod design_tokens;
pub mod events;
pub mod layout;
pub mod prototype;
pub mod retained_ui;
pub mod uia_bridge;
#[cfg(windows)]
pub mod uia_bridge_smoke;
pub mod virtual_list;

pub use accessibility::{
    AccessibilityNode, SemanticsError, SemanticsTree, UiAAction, build_semantics_tree,
    map_action_to_event,
};
pub use chart_a11y::{
    ChartKeyInput, ChartKeyResponse, ChartKeyboardState, LegendCommand, LegendItemSnapshot,
    LegendSnapshot, legend_item_id, legend_semantics_tree, zoom_step_window,
};
pub use control_render::{
    ControlCanvas, ControlPalette, DISABLED_OPACITY, PaintContext, SelectPaint, SliderPaint,
    focus_ring_rect, render_button, render_checkbox, render_select, render_slider, render_toggle,
};
pub use controls::{Button, Checkbox, ControlEvent, ControlResponse, Select, Slider, Toggle};
pub use design_tokens::{
    DESIGN_TOKENS_SCHEMA_VERSION, DesignTokenColors, DesignTokenMotion, DesignTokenRadii,
    DesignTokenSnapshot, DesignTokenSpacing, DesignTokenThemes, DesignTokenTypography,
    validate_design_tokens,
};
pub use events::{EventTarget, PHASE_BUBBLE, PHASE_CAPTURE, PHASE_TARGET, dispatch, hit_test};
pub use layout::{RetainedUiFrame, RetainedUiLayout, layout_tree};
pub use prototype::{PrototypeState, build_prototype_frame};
pub use retained_ui::{
    RETAINED_UI_BUDGETS, RETAINED_UI_SCHEMA_VERSION, RetainedUiA11y, RetainedUiAlign,
    RetainedUiBudgets, RetainedUiContent, RetainedUiDiagnostic, RetainedUiDiagnosticCode,
    RetainedUiLayoutMode, RetainedUiNode, RetainedUiNodeKind, RetainedUiPointerEvents,
    RetainedUiRole, RetainedUiStyle, RetainedUiTree, RetainedUiValidation,
    validate_retained_ui_tree,
};
#[cfg(windows)]
pub use uia_bridge::UiaBridge;
pub use uia_bridge::{
    UiaBridgeError, UiaControlType, UiaNavigateDirection, control_type_for, navigate_from,
    validate_semantics,
};
pub use virtual_list::{VirtualWindow, compute_window};
