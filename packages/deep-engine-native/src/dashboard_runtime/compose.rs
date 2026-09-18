use super::*;
use crate::deep2d::{Deep2dComposite, Deep2dLayer, Deep2dRect, prepare_runtime_content_cached};

impl DashboardRuntime {
    pub(super) fn rebuild(&mut self) -> Result<(), String> {
        let page = self
            .document()
            .pages
            .iter()
            .find(|p| p.id == self.page_id)
            .ok_or("dashboard page missing")?;
        let page_rect = Deep2dRect {
            x: 0.0,
            y: 0.0,
            width: page.width,
            height: page.height,
        };
        let mut layers = Vec::new();
        let mut hits = Vec::new();
        let mut text = self
            .text
            .lock()
            .map_err(|_| "dashboard text cache poisoned")?;
        for node in &page.nodes {
            let adapted;
            let node = match self.table_layer(&node.id) {
                None => node,
                Some(None) => continue,
                Some(Some(layer)) => {
                    let origin = layer.origin.unwrap_or([0.0, 0.0]);
                    adapted = crate::runtime_package::DashboardNode {
                        deep2d: Some(layer.deep2d.clone()),
                        clip: layer.clip,
                        frame: [
                            node.frame[0] + origin[0],
                            node.frame[1] + origin[1],
                            node.frame[2],
                            node.frame[3],
                        ],
                        ..node.clone()
                    };
                    &adapted
                }
            };
            let visible = self
                .document()
                .filter
                .as_ref()
                .and_then(|filter| {
                    self.selected_filter
                        .and_then(|index| filter.options.get(index))
                })
                .and_then(|option| {
                    option
                        .visibility
                        .iter()
                        .find(|entry| entry.node_id == node.id)
                })
                .map_or(node.visible, |entry| entry.visible);
            if !visible {
                continue;
            }
            if node
                .frame
                .iter()
                .chain(node.clip.iter().flatten())
                .any(|v| !v.is_finite() || v.abs() > 16_777_216.0)
                || node.frame[2] <= 0.0
                || node.frame[3] <= 0.0
                || node.clip.is_some_and(|r| r[2] <= 0.0 || r[3] <= 0.0)
            {
                return Err("invalid dashboard node frame or clip".into());
            }
            let offset = [node.frame[0], node.frame[1]];
            let clip = if let Some([x, y, width, height]) = node.clip {
                hit::intersect(
                    page_rect,
                    Deep2dRect {
                        x: x + offset[0],
                        y: y + offset[1],
                        width,
                        height,
                    },
                )
            } else {
                Some(page_rect)
            };
            let Some(clip) = clip else {
                continue;
            };
            let mut append =
                |suffix: &str, content: Deep2dRuntimeContent, chart: bool| -> Result<(), String> {
                    if node.hit_id.is_some() {
                        hits.push(hit::HitLayer::new(node, &content, clip, chart)?);
                    }
                    layers.push(Deep2dLayer {
                        id: format!("{}:{suffix}", node.id),
                        content: Arc::new(content),
                        translation: offset,
                        clip,
                    });
                    Ok(())
                };
            if let Some(id) = &node.deep2d {
                append(
                    "static",
                    self.filter_content(
                        &node.id,
                        self.loaded
                            .deep2d
                            .get(id)
                            .ok_or("dashboard static resource missing")?
                            .clone(),
                    ),
                    false,
                )?;
            }
            if let Some(chart) = self.charts.get(&node.id) {
                let list = crate::chart::presentation::present_chart_scaled(
                    chart,
                    &mut text,
                    self.legend_pages.get(&node.id).copied().unwrap_or(0),
                    self.anchors.get(&node.id).copied().unwrap_or([0.0, 0.0]),
                    None,
                    self.text_scale,
                )?;
                append("chart", Deep2dRuntimeContent::DisplayList(list), true)?;
            }
        }
        let composite = Deep2dComposite::new(
            format!("dashboard.{}", page.id),
            self.revision,
            [page.width, page.height],
            layers,
        )?;
        let content = Deep2dRuntimeContent::Composite(composite);
        // Final combined limits/tessellation are checked before any CPU snapshot commits.
        let mut prepared = self
            .prepare_cache
            .lock()
            .map_err(|_| "dashboard prepare cache poisoned")?;
        prepare_runtime_content_cached(&content, &mut prepared)?;
        drop(text);
        self.content = Arc::new(content);
        self.hits = hits;
        Ok(())
    }
}
