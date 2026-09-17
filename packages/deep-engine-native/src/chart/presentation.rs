//! Shared presentation for chart startup and transactional window updates.
use super::{
    ChartRuntime, axis_render::append_axes, legend_render::append_legend,
    tooltip_render::compose_tooltip,
};
use crate::{
    deep2d::Deep2dDisplayList,
    native_ui::design_tokens::{DesignTokenSnapshot, validate_design_tokens},
    platform_text::TextRasterizer,
};

pub fn present_chart(
    chart: &ChartRuntime,
    rasterizer: &mut TextRasterizer,
    page: usize,
    anchor: [f64; 2],
    legend_focus: Option<usize>,
) -> Result<Deep2dDisplayList, String> {
    let tokens: DesignTokenSnapshot =
        serde_json::from_str(include_str!("../../fixtures/design-tokens-v1.json"))
            .map_err(|error| format!("chart design tokens: {error}"))?;
    validate_design_tokens(&tokens)?;
    let mut list = compose_tooltip(chart, rasterizer, &tokens.themes.dark, anchor)?;
    append_axes(&mut list, chart, rasterizer, &tokens.themes.dark)?;
    super::state_render::append_state_outlines(&mut list, chart, &tokens.themes.dark)?;
    append_legend(
        &mut list,
        chart,
        rasterizer,
        &tokens.themes.dark,
        page,
        legend_focus,
    )?;
    Ok(list)
}
