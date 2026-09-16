//! Logical chart coordinates to reducer actions, using the committed source.
use super::interaction_contract::TooltipTrigger;
use super::{ChartAction, ChartHitTarget, ChartRuntime};

/// Axis tooltips intentionally tolerate a cursor between the rendered datum
/// and its exact pixel. Keep this in logical chart pixels so the same value is
/// used by native input, replay fixtures and CPU tests.
const AXIS_PICK_TOLERANCE: f64 = 16.0;

impl ChartRuntime {
    pub fn pointer_move(&mut self, x: f64, y: f64) -> Result<bool, String> {
        let target = if self.source().tooltip.enabled
            && self.source().tooltip.trigger == TooltipTrigger::Axis
        {
            // Axis mode is X-led: a cursor over empty plot space still
            // resolves the nearest visible datum, while a bar-only chart can
            // fall back to its hit rectangles when no point index exists.
            self.frame()
                .nearest_x_targets(x, AXIS_PICK_TOLERANCE)
                .into_iter()
                .next()
                .or_else(|| self.frame().pick(x, y))
        } else {
            self.frame().pick(x, y)
        };
        let action = target
            .as_ref()
            .map(|target| hover_action(self, target))
            .transpose()?
            .unwrap_or(ChartAction::HoverEnd);
        self.dispatch(action)
    }

    pub fn pointer_select(&mut self, x: f64, y: f64) -> Result<bool, String> {
        let Some(target) = self.frame().pick(x, y) else {
            return Ok(false);
        };
        let selected = self
            .state()
            .selected
            .iter()
            .any(|(id, index)| *id == target.series_id && *index == target.data_index);
        let action = if selected {
            ChartAction::Deselect {
                series_id: target.series_id,
                data_index: target.data_index,
            }
        } else {
            ChartAction::Select {
                series_id: target.series_id,
                data_index: target.data_index,
            }
        };
        self.dispatch(action)
    }
}

fn hover_action(chart: &ChartRuntime, target: &ChartHitTarget) -> Result<ChartAction, String> {
    let Some(data_index) = target.data_index else {
        return Ok(ChartAction::HoverSeries {
            series_id: target.series_id.clone(),
        });
    };
    let series = chart
        .source()
        .series
        .iter()
        .find(|series| series.id == target.series_id)
        .ok_or("committed chart series missing")?;
    let dataset = chart
        .source()
        .datasets
        .iter()
        .find(|dataset| dataset.id == series.dataset_id)
        .ok_or("committed chart dataset missing")?;
    let row = dataset
        .rows
        .get(data_index)
        .ok_or("committed chart row missing")?;
    let text = |dimension: Option<&String>| {
        dimension
            .and_then(|name| dataset.dimensions.iter().position(|dim| dim == name))
            .and_then(|index| row.get(index))
            .map_or_else(String::new, |value| {
                value
                    .as_str()
                    .map_or_else(|| value.to_string(), str::to_owned)
            })
    };
    Ok(ChartAction::Hover {
        series_id: target.series_id.clone(),
        data_index,
        x_label: text(series.x.as_ref().or(series.name.as_ref())),
        value: text(series.value.as_ref().or(series.y.as_ref())),
    })
}
