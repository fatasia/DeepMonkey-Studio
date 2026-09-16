use super::*;

impl ChartGeometryFrame {
    pub fn line_point_position(&self, series: &str, row: usize) -> Option<[f64; 2]> {
        self.chunks
            .iter()
            .find(|chunk| chunk.geometry.id == series)?
            .geometry
            .points
            .as_ref()?
            .position(series, row)
    }
    pub fn hit(&self, x: f64, y: f64) -> Option<&ChartHitTarget> {
        if !x.is_finite() || !y.is_finite() {
            return None;
        }
        self.chunks.iter().rev().find_map(|chunk| {
            let entry = chunk.geometry.hits.hit([x, y])?;
            chunk.geometry.targets.get(entry.source_index)
        })
    }
    /// 拾取半径与顶点一致:线段命中只补顶点之间的空隙,不扩大半径。
    const PICK_SEGMENT_RADIUS: f64 = super::super::line_point_index::PICK_RADIUS;
    pub fn pick(&self, x: f64, y: f64) -> Option<ChartHitTarget> {
        let hit = self.hit(x, y);
        if let Some(target) = hit
            && target.data_index.is_some()
        {
            return Some(target.clone());
        }
        let mut best: Option<(ChartHitTarget, f64)> = None;
        // 后绘制的系列在等距离时优先；单系列内部仍按原始行号选择。
        for chunk in self.chunks.iter().rev() {
            if hit.is_some_and(|target| target.series_id != chunk.geometry.id) {
                continue;
            }
            let Some(points) = &chunk.geometry.points else {
                continue;
            };
            // 顶点半径内优先返回 datum;线段只补顶点之间的空隙,不与顶点比距离。
            let candidate = points
                .nearest_with_distance([x, y], None)
                .or_else(|| points.nearest_segment([x, y], Self::PICK_SEGMENT_RADIUS));
            if let Some(candidate) = candidate
                && best
                    .as_ref()
                    .is_none_or(|(_, distance)| candidate.1 < *distance)
            {
                best = Some(candidate);
            }
        }
        best.map(|(target, _)| target).or_else(|| hit.cloned())
    }
    /// 屏幕 x → 首个 cartesian 系列 X 轴的数据坐标(含 zoom 窗口)。
    /// 多 X 轴时取绘制序第一个系列所属的轴;无 cartesian 系列返回 None。
    pub fn invert_x(&self, x: f64) -> Option<f64> {
        let inverter = self
            .chunks
            .iter()
            .find_map(|chunk| chunk.geometry.invert_x.as_ref())?;
        inverter.invert(x)
    }
    /// 最近 X 聚合:每个可见系列各返回屏幕 X 最近的一个 datum(不看 y),
    /// 供 axis tooltip 在同一 X 上并列多系列。前景(后绘制)系列在前;
    /// tolerance 是屏幕像素半径,各系列 data_index 保持其 dataset 的行身份。
    pub fn nearest_x_targets(&self, x: f64, tolerance: f64) -> Vec<ChartHitTarget> {
        if !x.is_finite() || !tolerance.is_finite() || tolerance < 0.0 {
            return Vec::new();
        }
        let mut targets = Vec::new();
        for chunk in self.chunks.iter().rev() {
            let Some(points) = &chunk.geometry.points else {
                continue;
            };
            if let Some(target) = points.nearest_x(x, tolerance) {
                targets.push(target);
            }
        }
        targets
    }
}
