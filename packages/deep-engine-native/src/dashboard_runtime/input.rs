use super::*;
use crate::chart::{
    ChartAction, ChartAxisChannel,
    legend::{LegendAction, LegendFrame},
};
impl DashboardRuntime {
    pub fn pointer(&mut self, point: Option<[f64; 2]>, select: bool) -> Result<bool, String> {
        let hit = point.and_then(|point| self.hit(point));
        self.transaction(|candidate| {
            let mut changed = false;
            let target = hit.as_ref().map(|h| h.node_id.as_str());
            for (id, chart) in &mut candidate.charts {
                if Some(id.as_str()) != target {
                    changed |= chart.dispatch(ChartAction::HoverEnd)?;
                }
            }
            let (Some(hit), Some(point)) = (hit, point) else {
                return Ok(changed);
            };
            let local = candidate
                .local_point(&hit.node_id, point)
                .ok_or("dashboard input node missing")?;
            let Some(chart) = candidate.charts.get_mut(&hit.node_id) else {
                return Ok(changed);
            };
            let page = candidate
                .legend_pages
                .get(&hit.node_id)
                .copied()
                .unwrap_or(0);
            let old_anchor = candidate.anchors.insert(hit.node_id.clone(), local);
            changed |= chart.state().tooltip.is_some() && old_anchor != Some(local);
            if select && let Some(action) = LegendFrame::prepare(chart, page)?.hit(local).cloned() {
                match action {
                    LegendAction::Toggle(series_id) => {
                        changed |= chart.dispatch(ChartAction::ToggleLegend { series_id })?
                    }
                    LegendAction::Page(page) => {
                        candidate.legend_pages.insert(hit.node_id, page);
                        changed = true;
                    }
                }
            } else if select {
                changed |= chart.pointer_select(local[0], local[1])?;
            } else {
                changed |= chart.pointer_move(local[0], local[1])?;
            }
            Ok(changed)
        })
    }
    pub fn zoom_at(&mut self, point: [f64; 2], delta: f64) -> Result<bool, String> {
        if !delta.is_finite() || delta == 0.0 {
            return Ok(false);
        }
        let Some(hit) = self.hit(point) else {
            return Ok(false);
        };
        self.transaction(|candidate| {
            let Some(chart) = candidate.charts.get_mut(&hit.node_id) else {
                return Ok(false);
            };
            let Some(axis) = chart
                .source()
                .axes
                .iter()
                .find(|axis| axis.channel == ChartAxisChannel::X)
            else {
                return Ok(false);
            };
            let id = axis.id.clone();
            let (start, end) = chart.state().zoom_window(&id).unwrap_or((0.0, 1.0));
            let span = ((end - start) * if delta > 0.0 { 0.8 } else { 1.25 }).clamp(0.01, 1.0);
            let start = ((start + end - span) * 0.5).clamp(0.0, 1.0 - span);
            chart.dispatch(ChartAction::Zoom {
                axis_id: id,
                start,
                end: start + span,
            })
        })
    }
    pub fn reset(&mut self) -> Result<bool, String> {
        self.transaction(|candidate| {
            let ids: Vec<_> = candidate
                .document()
                .pages
                .iter()
                .find(|p| p.id == candidate.page_id)
                .into_iter()
                .flat_map(|p| &p.nodes)
                .map(|n| n.id.clone())
                .collect();
            let mut changed = false;
            for id in ids {
                if let Some(chart) = candidate.charts.get_mut(&id) {
                    changed |= chart.dispatch(ChartAction::ResetZoom)?;
                }
            }
            Ok(changed)
        })
    }
}
