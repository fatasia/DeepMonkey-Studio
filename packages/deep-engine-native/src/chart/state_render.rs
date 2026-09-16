//! State outlines reuse committed paths, transforms and clipping, without new hits.
use super::{ChartHitTarget, ChartRuntime};
use crate::{
    deep2d::{Deep2dCommand, Deep2dDisplayList, validate_display_list},
    native_ui::design_tokens::DesignTokenTheme,
};

pub fn append_state_outlines(
    list: &mut Deep2dDisplayList,
    chart: &ChartRuntime,
    theme: &DesignTokenTheme,
) -> Result<(), String> {
    let mut selected_series = std::collections::HashSet::new();
    let mut selected_rows = std::collections::HashSet::new();
    for (id, index) in &chart.state().selected {
        match index {
            Some(index) => {
                selected_rows.insert((id.as_str(), *index));
            }
            None => {
                selected_series.insert(id.as_str());
            }
        }
    }
    let mut overlays = Vec::new();
    for (index, command) in chart.frame().display_list().commands.iter().enumerate() {
        let Some(target) = chart.frame().command_target(index) else {
            return Err("chart outline target missing".into());
        };
        let selected = selected_series.contains(target.series_id.as_str())
            || target
                .data_index
                .is_some_and(|index| selected_rows.contains(&(target.series_id.as_str(), index)));
        let hovered = chart
            .state()
            .highlighted
            .as_ref()
            .is_some_and(|value| matches_target(value, target));
        let emphasized = match target.data_index {
            Some(index) => chart.state().emphasis.contains(&target.series_id, index),
            None => chart
                .state()
                .emphasis
                .contains_entire_series(&target.series_id),
        };
        if !(selected || hovered || emphasized) {
            continue;
        }
        let color = if selected || emphasized {
            theme.colors.accent
        } else {
            theme.colors.accent_hover
        }
        .ok_or("chart outline accent token missing")?;
        if color
            .into_iter()
            .any(|v| !v.is_finite() || !(0.0..=1.0).contains(&v))
        {
            return Err("chart outline color invalid".into());
        }
        let Deep2dCommand::Path(path) = command else {
            return Err("chart outline expected path".into());
        };
        let mut outline = path.clone();
        outline.id = format!("outline-{}", path.id);
        outline.z_order = i32::MAX - 3;
        outline.hit_id = None;
        outline.fill = None;
        outline.fill_rule = None;
        outline.stroke = Some(color);
        outline.stroke_width = Some(if selected { 3.0 } else { 2.0 });
        outline.dash = if !selected && !hovered && emphasized {
            Some(vec![4.0, 3.0])
        } else {
            None
        };
        outline.dash_offset = None;
        overlays.push(Deep2dCommand::Path(outline));
    }
    let mut candidate = list.clone();
    candidate.commands.extend(overlays);
    super::point_marker_render::append_point_markers(&mut candidate, chart, theme)?;
    let validation = validate_display_list(&candidate);
    if !validation.valid {
        return Err(format!("chart state outline: {:?}", validation.issues));
    }
    *list = candidate;
    Ok(())
}

fn matches_target(value: &(String, Option<usize>), target: &ChartHitTarget) -> bool {
    value.0 == target.series_id && (value.1.is_none() || value.1 == target.data_index)
}
