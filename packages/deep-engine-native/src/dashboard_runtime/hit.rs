use super::*;
use crate::{chart::ChartHitTarget, deep2d::*, runtime_package::DashboardNode};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardHit {
    pub page_id: String,
    pub node_id: String,
    pub hit_id: String,
    pub sub_hit_id: Option<String>,
    pub chart_target: Option<ChartHitTarget>,
}
#[derive(Clone)]
pub(super) struct HitLayer {
    node: DashboardNode,
    content: Arc<Deep2dRuntimeContent>,
    index: Arc<Deep2dHitIndex>,
    clip: Deep2dRect,
    chart: bool,
}
impl HitLayer {
    pub(super) fn new(
        node: &DashboardNode,
        content: &Deep2dRuntimeContent,
        clip: Deep2dRect,
        chart: bool,
    ) -> Result<Self, String> {
        let index = build_hit_index(content.display_list()).map_err(|e| e.message)?;
        Ok(Self {
            node: node.clone(),
            content: Arc::new(content.clone()),
            index: Arc::new(index),
            clip,
            chart,
        })
    }
}
impl DashboardRuntime {
    pub fn hit(&self, point: [f64; 2]) -> Option<DashboardHit> {
        if point.iter().any(|v| !v.is_finite()) {
            return None;
        }
        for layer in self.hits.iter().rev() {
            if !contains(layer.clip, point) {
                continue;
            }
            let local = [
                point[0] - layer.node.frame[0],
                point[1] - layer.node.frame[1],
            ];
            let chart_target = if layer.chart {
                self.charts[&layer.node.id].frame().pick(local[0], local[1])
            } else {
                None
            };
            let legend = layer.chart
                && crate::chart::legend::LegendFrame::prepare(
                    &self.charts[&layer.node.id],
                    self.legend_pages.get(&layer.node.id).copied().unwrap_or(0),
                )
                .ok()
                .is_some_and(|frame| frame.hit(local).is_some());
            let sub_hit = content_hit(layer, local);
            let chart_surface = layer.chart
                && contains(
                    Deep2dRect {
                        x: 0.0,
                        y: 0.0,
                        width: layer.node.frame[2],
                        height: layer.node.frame[3],
                    },
                    local,
                );
            if chart_target.is_none() && !legend && sub_hit.is_none() && !chart_surface {
                continue;
            }
            return Some(DashboardHit {
                page_id: self.page_id.clone(),
                node_id: layer.node.id.clone(),
                hit_id: layer.node.hit_id.clone()?,
                sub_hit_id: sub_hit.flatten(),
                chart_target,
            });
        }
        None
    }
    pub(super) fn local_point(&self, node_id: &str, point: [f64; 2]) -> Option<[f64; 2]> {
        let node = self
            .document()
            .pages
            .iter()
            .find(|p| p.id == self.page_id)?
            .nodes
            .iter()
            .find(|n| n.id == node_id)?;
        Some([point[0] - node.frame[0], point[1] - node.frame[1]])
    }
}
fn content_hit(layer: &HitLayer, point: [f64; 2]) -> Option<Option<String>> {
    let list = layer.content.display_list();
    let path_hit = layer.index.hit(point);
    let mut hits: Vec<((i32, u8, usize), Option<String>)> = Vec::new();
    if let Some(entry) = path_hit {
        let command = &list.commands[entry.source_index];
        let (id, opacity, kind) = match command {
            Deep2dCommand::Path(v) => (v.hit_id.clone(), v.opacity, 0),
            Deep2dCommand::Text(v) => (v.hit_id.clone(), v.opacity, 1),
            Deep2dCommand::Image(v) => (v.hit_id.clone(), v.opacity, 1),
        };
        if opacity.unwrap_or(1.0) > 0.0 {
            hits.push(((entry.z_order, kind, entry.source_index), id));
        }
    }
    // Existing text index has no shaped-run width. Test the real baked glyph quads.
    for (i, command) in list.commands.iter().enumerate() {
        if let Deep2dCommand::Text(v) = command
            && v.opacity.unwrap_or(1.0) > 0.0
            && v.color[3] > 0.0
            && layer
                .index
                .entries()
                .iter()
                .find(|e| e.source_index == i)
                .is_some_and(|e| e.point_in_clips(point))
            && v.baked_glyphs.as_ref().is_some_and(|glyphs| {
                glyphs.iter().any(|g| {
                    quad_contains(
                        v.transform,
                        [
                            v.x + g.destination[0],
                            v.y + g.destination[1],
                            g.destination[2],
                            g.destination[3],
                        ],
                        point,
                    )
                })
            })
        {
            hits.push(((v.z_order, 1, i), v.hit_id.clone()));
        }
    }
    if let Deep2dRuntimeContent::Package(package) = &*layer.content {
        for (i, q) in package.quads.iter().enumerate() {
            if q.opacity > 0.0
                && q.color[3] > 0.0
                && quad_contains(q.transform, q.destination, point)
            {
                hits.push(((q.z_order, 1, list.commands.len() + i), None));
            }
        }
        if package.composition == Deep2dComposition::PathThenAtlas {
            hits.sort_by_key(|(key, _)| (key.1, key.0, key.2));
        } else {
            hits.sort_by_key(|(key, _)| *key);
        }
    } else {
        hits.sort_by_key(|(key, _)| *key);
    }
    hits.pop().map(|(_, id)| id)
}
fn quad_contains(m: [f64; 6], rect: [f64; 4], p: [f64; 2]) -> bool {
    let determinant = m[0] * m[3] - m[1] * m[2];
    if determinant == 0.0 {
        return false;
    }
    let x = p[0] - m[4];
    let y = p[1] - m[5];
    let p = [
        (m[3] * x - m[2] * y) / determinant,
        (-m[1] * x + m[0] * y) / determinant,
    ];
    contains(
        Deep2dRect {
            x: rect[0],
            y: rect[1],
            width: rect[2],
            height: rect[3],
        },
        p,
    )
}
pub(super) fn contains(r: Deep2dRect, p: [f64; 2]) -> bool {
    p[0] >= r.x && p[1] >= r.y && p[0] <= r.x + r.width && p[1] <= r.y + r.height
}
pub(super) fn intersect(a: Deep2dRect, b: Deep2dRect) -> Option<Deep2dRect> {
    let x = a.x.max(b.x);
    let y = a.y.max(b.y);
    let width = (a.x + a.width).min(b.x + b.width) - x;
    let height = (a.y + a.height).min(b.y + b.height) - y;
    (width > 0.0 && height > 0.0).then_some(Deep2dRect {
        x,
        y,
        width,
        height,
    })
}
