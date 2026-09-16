//! Visible source points indexed once per geometry frame, before line decimation.
use super::ChartHitTarget;
#[cfg(test)]
use super::{ChartIR, ChartSeriesType, InteractionState};
use std::collections::HashMap;

const CELL: f64 = 16.0;
pub(super) const PICK_RADIUS: f64 = 8.0;

#[derive(Clone)]
struct Point {
    position: [f64; 2],
    series: usize,
    row: usize,
}

#[derive(Clone, Default)]
pub(super) struct LinePointIndex {
    series: Vec<String>,
    cells: HashMap<(i32, i32), Vec<Point>>,
    plot: [f64; 4],
    rows: Vec<Vec<(usize, [f64; 2])>>,
}

impl LinePointIndex {
    #[cfg(test)]
    pub(super) fn prepare(
        ir: &ChartIR,
        state: &InteractionState,
        width: f64,
        height: f64,
    ) -> Result<Self, String> {
        let plot = super::layout::layout_chart(ir, width, height)?.plot;
        let mut index = Self {
            plot,
            ..Default::default()
        };
        for series in &ir.series {
            if series.series_type != ChartSeriesType::Line
                || state.hidden_series.contains(&series.id)
            {
                continue;
            }
            let dataset = ir
                .datasets
                .iter()
                .find(|dataset| dataset.id == series.dataset_id)
                .ok_or("line dataset missing")?;
            let Some(mapped) =
                super::render::map_cartesian(ir, series, dataset, plot, &state.zoom_windows)
            else {
                continue;
            };
            index.append_mapped(&series.id, mapped);
        }
        Ok(index)
    }

    pub(super) fn from_mapped(
        series: &str,
        plot: [f64; 4],
        mapped: super::render::CartesianPoints,
    ) -> Self {
        let mut index = Self {
            plot,
            ..Default::default()
        };
        index.append_mapped(series, mapped);
        index
    }

    fn append_mapped(&mut self, series: &str, mapped: super::render::CartesianPoints) {
        let ordinal = self.series.len();
        self.series.push(series.into());
        self.rows.push(Vec::new());
        for ((x, y), row) in mapped.points.into_iter().zip(mapped.data_indices) {
            if !x.is_finite() || !y.is_finite() || !inside(self.plot, [x, y]) {
                continue;
            }
            self.cells.entry(cell([x, y])).or_default().push(Point {
                position: [x, y],
                series: ordinal,
                row,
            });
            self.rows[ordinal].push((row, [x, y]));
        }
    }

    pub(super) fn nearest_with_distance(
        &self,
        position: [f64; 2],
        series: Option<&str>,
    ) -> Option<(ChartHitTarget, f64)> {
        if position.into_iter().any(|v| !v.is_finite()) || !inside(self.plot, position) {
            return None;
        }
        let (cx, cy) = cell(position);
        let mut best: Option<(&Point, f64)> = None;
        for x in cx - 1..=cx + 1 {
            for y in cy - 1..=cy + 1 {
                for point in self.cells.get(&(x, y)).into_iter().flatten() {
                    if series.is_some_and(|id| self.series[point.series] != id) {
                        continue;
                    }
                    let distance = (point.position[0] - position[0]).powi(2)
                        + (point.position[1] - position[1]).powi(2);
                    if distance > PICK_RADIUS * PICK_RADIUS {
                        continue;
                    }
                    if best.is_none_or(|(old, d)| {
                        distance < d
                            || (distance == d
                                && (point.series > old.series
                                    || (point.series == old.series && point.row < old.row)))
                    }) {
                        best = Some((point, distance));
                    }
                }
            }
        }
        best.map(|(point, distance)| {
            (
                ChartHitTarget {
                    series_id: self.series[point.series].clone(),
                    data_index: Some(point.row),
                },
                distance,
            )
        })
    }

    pub(super) fn position(&self, series: &str, row: usize) -> Option<[f64; 2]> {
        let ordinal = self.series.iter().position(|id| id == series)?;
        let rows = &self.rows[ordinal];
        rows.binary_search_by_key(&row, |point| point.0)
            .ok()
            .map(|index| rows[index].1)
    }

    /// 屏幕 X 最近点(不看 y):axis tooltip 按 X 聚合的系列级检索。
    /// 平局取小行号,与顶点拾取的行序优先一致。
    pub(super) fn nearest_x(&self, x: f64, tolerance: f64) -> Option<ChartHitTarget> {
        if !x.is_finite() || !tolerance.is_finite() || tolerance < 0.0 {
            return None;
        }
        let mut best: Option<(usize, usize, f64)> = None; // (series, row, |dx|)
        for (ordinal, rows) in self.rows.iter().enumerate() {
            for &(row, [px, _]) in rows {
                let dx = (px - x).abs();
                if dx > tolerance {
                    continue;
                }
                if best.is_none_or(|(_, old_row, old_dx)| {
                    dx < old_dx || (dx == old_dx && row < old_row)
                }) {
                    best = Some((ordinal, row, dx));
                }
            }
        }
        best.map(|(ordinal, row, _)| ChartHitTarget {
            series_id: self.series[ordinal].clone(),
            data_index: Some(row),
        })
    }

    /// 线段命中:点到相邻两点线段的距离 ≤ radius。线段本身没有行号,
    /// 返回 series 级目标(data_index None),与 stroke 命令的 hit 语义一致;
    /// datum 级聚合走 `nearest_x`。
    /// 段的 x 包围与光标半径不相交则剪枝,避免大系列的线性距离计算。
    pub(super) fn nearest_segment(
        &self,
        position: [f64; 2],
        radius: f64,
    ) -> Option<(ChartHitTarget, f64)> {
        if position.into_iter().any(|v| !v.is_finite()) || !inside(self.plot, position) {
            return None;
        }
        let radius = radius.max(0.0);
        let mut best: Option<(usize, f64)> = None; // (series, dist²)
        for (ordinal, rows) in self.rows.iter().enumerate() {
            for pair in rows.windows(2) {
                let (a, b) = (pair[0].1, pair[1].1);
                let (x0, x1) = (a[0].min(b[0]), a[0].max(b[0]));
                if x1 < position[0] - radius || x0 > position[0] + radius {
                    continue;
                }
                let distance = point_segment_distance2(position, a, b);
                if distance > radius * radius {
                    continue;
                }
                if best.is_none_or(|(_, old)| distance < old) {
                    best = Some((ordinal, distance));
                }
            }
        }
        best.map(|(ordinal, distance)| {
            (
                ChartHitTarget {
                    series_id: self.series[ordinal].clone(),
                    data_index: None,
                },
                distance,
            )
        })
    }
}

fn dist2([x, y]: [f64; 2], point: [f64; 2]) -> f64 {
    (point[0] - x).powi(2) + (point[1] - y).powi(2)
}

/// 点到线段距离的平方:投影参数 t clamp 到 [0,1] 的标准实现。
fn point_segment_distance2(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let (vx, vy) = (b[0] - a[0], b[1] - a[1]);
    let (wx, wy) = (p[0] - a[0], p[1] - a[1]);
    let dot = vx * wx + vy * wy;
    let t = if vx == 0.0 && vy == 0.0 {
        0.0
    } else {
        (dot / (vx * vx + vy * vy)).clamp(0.0, 1.0)
    };
    dist2(p, [a[0] + t * vx, a[1] + t * vy])
}

fn cell([x, y]: [f64; 2]) -> (i32, i32) {
    ((x / CELL).floor() as i32, (y / CELL).floor() as i32)
}
fn inside([x, y, w, h]: [f64; 4], point: [f64; 2]) -> bool {
    point[0] >= x && point[0] <= x + w && point[1] >= y && point[1] <= y + h
}
