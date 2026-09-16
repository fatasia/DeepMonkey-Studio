//! C04: chart interaction state machines. Pure state, no rendering — every
//! user action maps to a state transition that the renderer consumes, and
//! series/data identity stays stable across zoom/highlight/select.

use crate::chart::chart_ir::{ChartIR, ChartScale};

/// Tooltip anchored to a hovered datum; values carry their unit string so
/// the presenter cannot re-derive (or corrupt) formatting.
#[derive(Debug, Clone, PartialEq)]
pub struct TooltipState {
    pub series_id: String,
    pub data_index: usize,
    pub x_value: String,
    pub y_value: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct InteractionState {
    /// 持久强调由 highlight/downplay 控制，鼠标离开不会清除。
    pub emphasis: super::EmphasisState,
    /// Legend toggles: hidden series ids never render and never hit-test.
    pub hidden_series: Vec<String>,
    /// Highlighted (hovered) and selected (pinned) series/datum pairs.
    pub highlighted: Option<(String, Option<usize>)>,
    pub selected: Vec<(String, Option<usize>)>,
    /// dataZoom windows per axis id, normalized to [0, 1], start < end.
    pub zoom_windows: Vec<(String, f64, f64)>,
    pub tooltip: Option<TooltipState>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChartAction {
    Hover {
        series_id: String,
        data_index: usize,
        x_label: String,
        value: String,
    },
    HoverEnd,
    HoverSeries {
        series_id: String,
    },
    /// 运行期持久强调(对应 TS/ECharts 的 `dispatchAction({type:"highlight"})`)。
    /// `data_index=None` 表示整系列强调——与初始动作 `highlight` 走同一条
    /// `apply` 路径,不再出现「初始写状态、运行期无入口」的两套语义。
    Highlight {
        series_id: String,
        data_index: Option<usize>,
    },
    /// 运行期解除强调(`downplay`);`data_index=None` 解除整系列。
    Downplay {
        series_id: String,
        data_index: Option<usize>,
    },
    Select {
        series_id: String,
        data_index: Option<usize>,
    },
    Deselect {
        series_id: String,
        data_index: Option<usize>,
    },
    ToggleLegend {
        series_id: String,
    },
    Zoom {
        axis_id: String,
        start: f64,
        end: f64,
    },
    ResetZoom,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionError {
    InvalidDataIndex,
    UnknownSeries,
    UnknownAxis,
    InvalidZoomWindow,
    HiddenSeriesAction,
}

impl InteractionState {
    pub fn apply(&mut self, ir: &ChartIR, action: ChartAction) -> Result<(), ActionError> {
        match &action {
            ChartAction::Hover {
                series_id,
                data_index,
                ..
            } => super::emphasis::validate_target(ir, series_id, Some(*data_index))?,
            ChartAction::Select {
                series_id,
                data_index,
            }
            | ChartAction::Deselect {
                series_id,
                data_index,
            } => super::emphasis::validate_target(ir, series_id, *data_index)?,
            ChartAction::HoverSeries { series_id } => {
                super::emphasis::validate_target(ir, series_id, None)?
            }
            ChartAction::Highlight {
                series_id,
                data_index,
            }
            | ChartAction::Downplay {
                series_id,
                data_index,
            } => super::emphasis::validate_target(ir, series_id, *data_index)?,
            _ => {}
        }
        let known_series = |id: &str| ir.series.iter().any(|s| s.id == id);
        match action {
            ChartAction::Hover {
                series_id,
                data_index,
                x_label,
                value,
            } => {
                if !known_series(&series_id) {
                    return Err(ActionError::UnknownSeries);
                }
                if self.hidden_series.contains(&series_id) {
                    return Err(ActionError::HiddenSeriesAction);
                }
                self.highlighted = Some((series_id.clone(), Some(data_index)));
                self.tooltip = (ir.tooltip.enabled
                    && ir.tooltip.trigger != super::interaction_contract::TooltipTrigger::None)
                    .then_some(TooltipState {
                        series_id,
                        data_index,
                        x_value: x_label,
                        y_value: value,
                    });
                Ok(())
            }
            ChartAction::HoverEnd => {
                self.tooltip = None;
                self.highlighted = None;
                Ok(())
            }
            ChartAction::HoverSeries { series_id } => {
                if self.hidden_series.contains(&series_id) {
                    return Err(ActionError::HiddenSeriesAction);
                }
                self.highlighted = Some((series_id, None));
                self.tooltip = None;
                Ok(())
            }
            ChartAction::Highlight {
                series_id,
                data_index,
            } => {
                if self.hidden_series.contains(&series_id) {
                    return Err(ActionError::HiddenSeriesAction);
                }
                self.emphasis.set(&series_id, data_index, true);
                Ok(())
            }
            ChartAction::Downplay {
                series_id,
                data_index,
            } => {
                if self.hidden_series.contains(&series_id) {
                    return Err(ActionError::HiddenSeriesAction);
                }
                self.emphasis.set(&series_id, data_index, false);
                Ok(())
            }
            ChartAction::Select {
                series_id,
                data_index,
            } => {
                if !known_series(&series_id) {
                    return Err(ActionError::UnknownSeries);
                }
                let entry = (series_id, data_index);
                if !self.selected.contains(&entry) {
                    self.selected.push(entry);
                }
                Ok(())
            }
            ChartAction::Deselect {
                series_id,
                data_index,
            } => {
                if !known_series(&series_id) {
                    return Err(ActionError::UnknownSeries);
                }
                self.selected.retain(|(id, index)| {
                    *id != series_id || (data_index.is_some() && *index != data_index)
                });
                Ok(())
            }
            ChartAction::ToggleLegend { series_id } => {
                if !known_series(&series_id) {
                    return Err(ActionError::UnknownSeries);
                }
                if let Some(position) = self.hidden_series.iter().position(|id| *id == series_id) {
                    self.hidden_series.remove(position);
                } else {
                    if self
                        .tooltip
                        .as_ref()
                        .is_some_and(|tooltip| tooltip.series_id == series_id)
                    {
                        self.tooltip = None;
                    }
                    if self
                        .highlighted
                        .as_ref()
                        .is_some_and(|(id, _)| *id == series_id)
                    {
                        self.highlighted = None;
                    }
                    self.hidden_series.push(series_id);
                }
                Ok(())
            }
            ChartAction::Zoom {
                axis_id,
                start,
                end,
            } => {
                if !ir.axes.iter().any(|axis| axis.id == axis_id) {
                    return Err(ActionError::UnknownAxis);
                }
                if !(start.is_finite()
                    && end.is_finite()
                    && (0.0..1.0).contains(&start)
                    && (0.0..=1.0).contains(&end)
                    && start < end)
                {
                    return Err(ActionError::InvalidZoomWindow);
                }
                if let Some(entry) = self
                    .zoom_windows
                    .iter_mut()
                    .find(|(id, _, _)| *id == axis_id)
                {
                    *entry = (axis_id, start, end);
                } else {
                    self.zoom_windows.push((axis_id, start, end));
                }
                Ok(())
            }
            ChartAction::ResetZoom => {
                self.zoom_windows.clear();
                Ok(())
            }
        }
    }

    /// Mapping helper for a percent zoom window onto a concrete domain,
    /// shared by every scale so presenters cannot diverge.
    pub fn zoom_window(&self, axis_id: &str) -> Option<(f64, f64)> {
        self.zoom_windows
            .iter()
            .find(|(id, _, _)| *id == axis_id)
            .map(|(_, start, end)| (*start, *end))
    }
}

/// Category/time ticks for tooltip x labels keep the axis scale semantics.
pub fn format_tick(scale: ChartScale, raw: &str) -> String {
    match scale {
        ChartScale::Category | ChartScale::Time => raw.to_string(),
        ChartScale::Linear | ChartScale::Log => raw.to_string(),
    }
}

#[cfg(test)]
#[path = "interaction_tests.rs"]
mod tests;
