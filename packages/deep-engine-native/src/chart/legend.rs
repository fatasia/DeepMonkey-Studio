//! Paged legend layout and hit routing share the exact visible rectangles.
use super::{ChartRuntime, interaction_contract::LegendPosition, layout::layout_chart};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LegendAction {
    Toggle(String),
    Page(usize),
}

#[derive(Debug, Clone)]
pub struct LegendItem {
    pub rect: [f64; 4],
    pub label: String,
    pub hidden: bool,
    pub action: LegendAction,
}

#[derive(Debug, Clone)]
pub struct LegendFrame {
    pub page: usize,
    pub pages: usize,
    pub items: Vec<LegendItem>,
}

impl LegendFrame {
    pub fn prepare(chart: &ChartRuntime, requested_page: usize) -> Result<Self, String> {
        let list = chart.frame().display_list();
        let frame = layout_chart(chart.source(), list.logical_width, list.logical_height)?;
        let Some(band) = frame.legend else {
            return Ok(Self {
                page: 0,
                pages: 0,
                items: vec![],
            });
        };
        let count = chart.source().series.len();
        if count == 0 {
            return Ok(Self {
                page: 0,
                pages: 0,
                items: vec![],
            });
        }
        let vertical = matches!(
            chart.source().legend.position,
            LegendPosition::Left | LegendPosition::Right
        );
        let extent = if vertical { band[3] } else { band[2] };
        let item_extent = if vertical { 24.0 } else { 104.0 };
        let paged = count as f64 * item_extent > extent;
        let navigation = if paged { 24.0 } else { 0.0 };
        let available = extent - navigation * 2.0;
        if available < 24.0 {
            return Err("legend band too small for navigation and label".into());
        }
        let capacity = ((available / item_extent).floor() as usize).max(1);
        let pages = count.div_ceil(capacity);
        let page = requested_page.min(pages - 1);
        let rect = |offset: f64, length: f64| {
            if vertical {
                [band[0], band[1] + offset, band[2], length]
            } else {
                [band[0] + offset, band[1], length, band[3]]
            }
        };
        let mut items = Vec::new();
        if page > 0 {
            items.push(LegendItem {
                rect: rect(0.0, navigation),
                label: "‹".into(),
                hidden: false,
                action: LegendAction::Page(page - 1),
            });
        }
        for (index, series) in chart
            .source()
            .series
            .iter()
            .skip(page * capacity)
            .take(capacity)
            .enumerate()
        {
            items.push(LegendItem {
                rect: rect(
                    navigation + index as f64 * item_extent,
                    item_extent.min(available),
                ),
                label: series.label.clone(),
                hidden: chart.state().hidden_series.contains(&series.id),
                action: LegendAction::Toggle(series.id.clone()),
            });
        }
        if page + 1 < pages {
            items.push(LegendItem {
                rect: rect(extent - navigation, navigation),
                label: "›".into(),
                hidden: false,
                action: LegendAction::Page(page + 1),
            });
        }
        Ok(Self { page, pages, items })
    }

    pub fn hit(&self, point: [f64; 2]) -> Option<&LegendAction> {
        if point.into_iter().any(|v| !v.is_finite()) {
            return None;
        }
        self.items
            .iter()
            .find(|item| {
                let [x, y, w, h] = item.rect;
                point[0] >= x && point[0] < x + w && point[1] >= y && point[1] < y + h
            })
            .map(|item| &item.action)
    }
}
