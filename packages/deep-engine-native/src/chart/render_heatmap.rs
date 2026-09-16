//! Heatmap cell geometry follows each axis while retaining the full color domain.
use super::{
    ChartIR, ChartScale, Ctx, ListBuilder, axis_of, dim, extent, finite_value, heat_color,
    rect_points, slot,
};

fn bands(
    keys: &[serde_json::Value],
    axis: Option<&super::ChartAxis>,
    range: (f64, f64),
    windows: &[(String, f64, f64)],
) -> Option<Vec<(f64, f64)>> {
    if keys.is_empty() {
        return None;
    }
    let window = axis.and_then(|axis| windows.iter().find(|(id, _, _)| *id == axis.id));
    let (start, end) = window.map_or((0.0, 1.0), |(_, start, end)| (*start, *end));
    let category = axis.is_none_or(|axis| axis.scale == ChartScale::Category);
    let (centers, step, domain) = if category {
        (
            (0..keys.len())
                .map(|index| index as f64 + 0.5)
                .collect::<Vec<_>>(),
            1.0,
            (0.0, keys.len() as f64),
        )
    } else {
        let logarithmic = axis.is_some_and(|axis| axis.scale == ChartScale::Log);
        let transform = |value: f64| {
            if !value.is_finite() || (logarithmic && value <= 0.0) {
                return None;
            }
            Some(if logarithmic { value.log10() } else { value })
        };
        let centers = keys
            .iter()
            .map(|key| transform(key.as_f64()?))
            .collect::<Option<Vec<_>>>()?;
        let mut ordered = centers.clone();
        ordered.sort_by(f64::total_cmp);
        ordered.dedup();
        let step = ordered
            .windows(2)
            .map(|pair| pair[1] - pair[0])
            .filter(|gap| *gap > 0.0)
            .reduce(f64::min)
            .unwrap_or(1.0);
        let min = match axis.and_then(|axis| axis.min) {
            Some(value) => transform(value)?,
            None => ordered[0] - step * 0.5,
        };
        let max = match axis.and_then(|axis| axis.max) {
            Some(value) => transform(value)?,
            None => ordered[ordered.len() - 1] + step * 0.5,
        };
        (centers, step, (min, max))
    };
    let lo = domain.0 * (1.0 - start) + domain.1 * start;
    let hi = domain.0 * (1.0 - end) + domain.1 * end;
    if !lo.is_finite() || !hi.is_finite() || hi <= lo {
        return None;
    }
    let map = |value: f64| range.0 + (value - lo) / (hi - lo) * (range.1 - range.0);
    Some(
        centers
            .into_iter()
            .map(|center| {
                let (a, b) = (map(center - step * 0.5), map(center + step * 0.5));
                (a.min(b), (b - a).abs())
            })
            .collect(),
    )
}

pub(super) fn render_heatmap(
    builder: &mut ListBuilder,
    ctx: &Ctx<'_>,
    ir: &ChartIR,
    windows: &[(String, f64, f64)],
) {
    let (Some(x_col), Some(y_col), Some(v_col)) = (
        dim(ctx.dataset, &ctx.series.x),
        dim(ctx.dataset, &ctx.series.y),
        dim(ctx.dataset, &ctx.series.value),
    ) else {
        return;
    };
    let (mut xs, mut ys, mut cells) = (Vec::new(), Vec::new(), Vec::new());
    for (data_index, row) in ctx.dataset.rows.iter().enumerate() {
        let (Some(x), Some(y), Some(value)) =
            (row.get(x_col), row.get(y_col), finite_value(row, v_col))
        else {
            continue;
        };
        cells.push((
            slot(&mut xs, x.clone()),
            slot(&mut ys, y.clone()),
            value,
            data_index,
        ));
    }
    let Some((min, max)) = extent(cells.iter().map(|cell| cell.2)) else {
        return;
    };
    let [x, y, w, h] = ctx.plot;
    let x_axis = axis_of(ir, ctx.series.x_axis_id.as_ref());
    let y_axis = axis_of(ir, ctx.series.y_axis_id.as_ref());
    let y_range = if y_axis.is_some_and(|axis| axis.scale != ChartScale::Category) {
        (y + h, y)
    } else {
        (y, y + h)
    };
    let (Some(x_bands), Some(y_bands)) = (
        bands(&xs, x_axis, (x, x + w), windows),
        bands(&ys, y_axis, y_range, windows),
    ) else {
        return;
    };
    for (xi, yi, value, data_index) in cells {
        builder.data_index = Some(data_index);
        let t = if max > min {
            (value - min) / (max - min)
        } else {
            0.5
        };
        builder.fill(
            &rect_points(x_bands[xi].0, y_bands[yi].0, x_bands[xi].1, y_bands[yi].1),
            heat_color(t),
        );
    }
}
