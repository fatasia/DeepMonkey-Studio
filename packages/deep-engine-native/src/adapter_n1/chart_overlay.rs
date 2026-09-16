//! 图表扩展叠加适配:趋势线 / 阈值带 / 标记点 → path 资源 + path 命令。

use super::adapt::{IDENTITY_MATRIX, finish};
use super::schema::{ChartExtensionInputV1, ChartOverlayV1, N1InputKind};
use super::validate::{
    MAX_DRAW_VALUE, MAX_STROKE_WIDTH, derived_id, require_bounded_coordinate, require_color,
    require_id, require_positive_bounded,
};
use crate::deep2d::{
    Deep2dCommand, Deep2dPathVerb, Deep2dResource, LineCap, LineJoin, PathCommand, PathResource,
};

/// 圆形 marker 的四段三次贝塞尔近似常数(kappa)。
const CIRCLE_KAPPA: f64 = 0.552_284_749_830_793_6;

pub(super) fn adapt_chart_extension(
    input: &ChartExtensionInputV1,
    budget: &super::N1Budget,
) -> Result<super::N1Adapted, String> {
    require_id(&input.id, "chart extension id")?;
    if input.overlays.len() > budget.max_paths {
        return Err(format!(
            "chart overlay budget exceeded: {} overlays > max {}",
            input.overlays.len(),
            budget.max_paths
        ));
    }
    let mut delta = super::N1DisplayDelta::empty();
    let mut seen_ids = std::collections::BTreeSet::new();
    for overlay in &input.overlays {
        let (id, z_order, verbs, paint) = match overlay {
            ChartOverlayV1::TrendLine {
                id,
                points,
                stroke,
                stroke_width,
                z_order,
            } => {
                require_id(id, "trend line id")?;
                for (index, point) in points.iter().enumerate() {
                    require_bounded_coordinate(
                        point[0],
                        &format!("trend line '{id}' point {index} x"),
                    )?;
                    require_bounded_coordinate(
                        point[1],
                        &format!("trend line '{id}' point {index} y"),
                    )?;
                }
                require_color(stroke, &format!("trend line '{id}' stroke"))?;
                require_positive_bounded(
                    *stroke_width,
                    MAX_STROKE_WIDTH,
                    &format!("trend line '{id}' strokeWidth"),
                )?;
                (
                    id.clone(),
                    *z_order,
                    vec![
                        Deep2dPathVerb::Move {
                            x: points[0][0],
                            y: points[0][1],
                        },
                        Deep2dPathVerb::Line {
                            x: points[1][0],
                            y: points[1][1],
                        },
                    ],
                    (None, Some(*stroke), Some(*stroke_width)),
                )
            }
            ChartOverlayV1::ThresholdBand {
                id,
                x0,
                y0,
                x1,
                y1,
                fill,
                z_order,
            } => {
                require_id(id, "threshold band id")?;
                require_bounded_coordinate(*x0, &format!("band '{id}' x0"))?;
                require_bounded_coordinate(*y0, &format!("band '{id}' y0"))?;
                require_bounded_coordinate(*x1, &format!("band '{id}' x1"))?;
                require_bounded_coordinate(*y1, &format!("band '{id}' y1"))?;
                if x1 <= x0 || y1 <= y0 {
                    return Err(format!(
                        "threshold band '{id}' is degenerate (requires x1 > x0 and y1 > y0)"
                    ));
                }
                require_color(fill, &format!("band '{id}' fill"))?;
                (
                    id.clone(),
                    *z_order,
                    vec![
                        Deep2dPathVerb::Move { x: *x0, y: *y0 },
                        Deep2dPathVerb::Line { x: *x1, y: *y0 },
                        Deep2dPathVerb::Line { x: *x1, y: *y1 },
                        Deep2dPathVerb::Line { x: *x0, y: *y1 },
                        Deep2dPathVerb::Close,
                    ],
                    (Some(*fill), None, None),
                )
            }
            ChartOverlayV1::Marker {
                id,
                center,
                radius,
                fill,
                z_order,
            } => {
                require_id(id, "marker id")?;
                require_bounded_coordinate(center[0], &format!("marker '{id}' center x"))?;
                require_bounded_coordinate(center[1], &format!("marker '{id}' center y"))?;
                require_positive_bounded(
                    *radius,
                    MAX_DRAW_VALUE,
                    &format!("marker '{id}' radius"),
                )?;
                require_color(fill, &format!("marker '{id}' fill"))?;
                (
                    id.clone(),
                    *z_order,
                    circle_verbs(center, *radius),
                    (Some(*fill), None, None),
                )
            }
        };
        // 重复资源 id 会让 delta 无法并入同一 display list(deep2d 合同),
        // 在适配层即拒绝,保证产物总是可并回。
        if !seen_ids.insert(id.clone()) {
            return Err(format!("duplicate chart overlay id '{id}'"));
        }
        delta.resources.push(Deep2dResource::Path(PathResource {
            id: id.clone(),
            revision: 0,
            verbs,
        }));
        delta.commands.push(Deep2dCommand::Path(PathCommand {
            id: derived_id(&format!("{id}.paint"))?,
            z_order,
            transform: IDENTITY_MATRIX,
            opacity: None,
            clip_path_ids: None,
            clip_rect: None,
            hit_id: None,
            path_id: id,
            fill: paint.0,
            fill_rule: None,
            stroke: paint.1,
            stroke_width: paint.2,
            // stroke 风格字段只允许伴随 stroke 颜色出现(deep2d 合同)。
            line_cap: paint.1.map(|_| LineCap::Butt),
            line_join: paint.1.map(|_| LineJoin::Miter),
            miter_limit: None,
            dash: None,
            dash_offset: None,
        }));
    }
    finish(
        delta,
        N1InputKind::ChartExtension,
        input.overlays.len(),
        budget,
    )
}

/// 圆 = 4 段三次贝塞尔 + 闭合;常数 kappa,纯函数、双跑一致。
fn circle_verbs(center: &[f64; 2], radius: f64) -> Vec<Deep2dPathVerb> {
    let k = CIRCLE_KAPPA * radius;
    let (cx, cy) = (center[0], center[1]);
    let right = (cx + radius, cy);
    let top = (cx, cy - radius);
    let left = (cx - radius, cy);
    let bottom = (cx, cy + radius);
    vec![
        Deep2dPathVerb::Move {
            x: right.0,
            y: right.1,
        },
        Deep2dPathVerb::Cubic {
            c1x: right.0,
            c1y: right.1 + k,
            c2x: bottom.0 + k,
            c2y: bottom.1,
            x: bottom.0,
            y: bottom.1,
        },
        Deep2dPathVerb::Cubic {
            c1x: bottom.0 - k,
            c1y: bottom.1,
            c2x: left.0,
            c2y: left.1 + k,
            x: left.0,
            y: left.1,
        },
        Deep2dPathVerb::Cubic {
            c1x: left.0,
            c1y: left.1 - k,
            c2x: top.0 - k,
            c2y: top.1,
            x: top.0,
            y: top.1,
        },
        Deep2dPathVerb::Cubic {
            c1x: top.0 + k,
            c1y: top.1,
            c2x: right.0,
            c2y: right.1 - k,
            x: right.0,
            y: right.1,
        },
        Deep2dPathVerb::Close,
    ]
}
