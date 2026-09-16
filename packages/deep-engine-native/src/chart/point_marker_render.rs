//! Line datum feedback comes from the same committed source-point index as picking.
//!
//! Marker 语义分层（覆盖顺序 Hover < Emphasis < Selected）：
//! - `highlighted`（hover）是瞬态，`emphasis` 是持久，二者同行时不互相清除；
//!   同一行叠加时取更强的语义渲染，hover 离开后 marker 回到 emphasis 样式。
//! - 系列级强调（`all`）只由系列轮廓表达，不展开逐行 marker；显式 row 级
//!   持久强调在此逐行渲染。
use super::ChartRuntime;
use crate::{
    deep2d::{Deep2dCommand, Deep2dDisplayList, Deep2dRect, Deep2dResource},
    native_ui::{control_render::ControlCanvas, design_tokens::DesignTokenTheme},
};

/// Marker 语义强度：同一 datum 叠加多种反馈时只渲染最强的一层。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum MarkerKind {
    Hover,
    Emphasis,
    Selected,
}

pub(super) fn append_point_markers(
    list: &mut Deep2dDisplayList,
    chart: &ChartRuntime,
    theme: &DesignTokenTheme,
) -> Result<(), String> {
    let mut targets = std::collections::BTreeMap::new();
    for (id, row) in &chart.state().selected {
        if let Some(row) = row {
            targets.insert((id.as_str(), *row), MarkerKind::Selected);
        }
    }
    if let Some((id, Some(row))) = &chart.state().highlighted {
        targets
            .entry((id.as_str(), *row))
            .or_insert(MarkerKind::Hover);
    }
    for (id, row) in chart.state().emphasis.row_markers() {
        targets
            .entry((id, row))
            .and_modify(|kind| *kind = (*kind).max(MarkerKind::Emphasis))
            .or_insert(MarkerKind::Emphasis);
    }
    let mut canvas = ControlCanvas::new();
    for ((id, row), kind) in targets {
        let Some([x, y]) = chart.frame().line_point_position(id, row) else {
            // 隐藏系列（legend toggle）与已淘汰行在这里自然落空：隐藏期间
            // 不渲染 marker，但 emphasis 状态保留，取消隐藏后恢复。
            continue;
        };
        let persistent = kind >= MarkerKind::Emphasis;
        let color = if persistent {
            theme.colors.accent
        } else {
            theme.colors.accent_hover
        }
        .ok_or("line marker accent missing")?;
        if color
            .into_iter()
            .any(|v| !v.is_finite() || !(0.0..=1.0).contains(&v))
        {
            return Err("line marker color invalid".into());
        }
        let radius = if kind == MarkerKind::Selected {
            5.0
        } else {
            4.0
        };
        let key = crate::runtime_package::runtime_content_sha256(&serde_json::json!([
            "chart-line-point",
            chart.source().id,
            id,
            row
        ]));
        canvas.fill_rect(
            &format!("point-{key}"),
            [x - radius, y - radius, radius * 2.0, radius * 2.0],
            color,
            radius,
            1.0,
        );
    }
    let mut markers = canvas.into_display_list(list.logical_width, list.logical_height);
    let plot =
        super::layout::layout_chart(chart.source(), list.logical_width, list.logical_height)?.plot;
    for resource in &mut markers.resources {
        if let Deep2dResource::Path(path) = resource {
            path.revision = chart.revision();
        }
    }
    for command in &mut markers.commands {
        if let Deep2dCommand::Path(path) = command {
            path.z_order = i32::MAX - 3;
            path.clip_rect = Some(Deep2dRect {
                x: plot[0],
                y: plot[1],
                width: plot[2],
                height: plot[3],
            });
        }
    }
    list.resources.append(&mut markers.resources);
    list.commands.append(&mut markers.commands);
    Ok(())
}
