use super::{ChartAxis, ChartHitTarget, ChartIR, ChartSeries, ChartSeriesType, InteractionState};
use crate::deep2d::{Deep2dCommand, Deep2dDisplayList, Deep2dHitIndex, build_hit_index};

#[derive(Clone, PartialEq)]
pub(super) struct SeriesDependencies {
    chart_id: String,
    series: ChartSeries,
    axes: Vec<ChartAxis>,
    windows: Vec<(String, f64, f64)>,
    viewport: [f64; 2],
    plot: [f64; 4],
}
impl SeriesDependencies {
    pub(super) fn new(
        ir: &ChartIR,
        series: &ChartSeries,
        state: &InteractionState,
        viewport: [f64; 2],
        plot: [f64; 4],
    ) -> Self {
        let uses_axis = |id: &String| {
            series.x_axis_id.as_ref() == Some(id) || series.y_axis_id.as_ref() == Some(id)
        };
        Self {
            chart_id: ir.id.clone(),
            series: series.clone(),
            viewport,
            plot,
            axes: ir
                .axes
                .iter()
                .filter(|axis| uses_axis(&axis.id))
                .cloned()
                .collect(),
            windows: state
                .zoom_windows
                .iter()
                .filter(|(id, _, _)| uses_axis(id))
                .cloned()
                .collect(),
        }
    }
}

#[derive(Clone)]
pub(super) struct SeriesGeometry {
    pub id: String,
    pub dependencies: SeriesDependencies,
    pub hits: Deep2dHitIndex,
    pub targets: Vec<ChartHitTarget>,
    pub points: Option<super::line_point_index::LinePointIndex>,
    /// 该系列 X 轴的屏幕→数据反解器;axis tooltip 的数据坐标从这里取。
    pub invert_x: Option<super::render::XInverter>,
}
impl SeriesGeometry {
    pub(super) fn prepare(
        ir: &ChartIR,
        series: &ChartSeries,
        state: &InteractionState,
        viewport: [f64; 2],
        dependencies: SeriesDependencies,
    ) -> Result<(Self, Deep2dDisplayList), String> {
        let hidden = ir
            .series
            .iter()
            .filter(|other| other.id != series.id)
            .map(|other| other.id.clone())
            .collect::<Vec<_>>();
        // 共用完整渲染器的单系列输出；资源ID与几何算法只有一个实现。
        let (list, mapped) = super::render::render_chart_with_points(
            ir,
            viewport[0],
            viewport[1],
            &hidden,
            &state.zoom_windows,
            true,
        )?;
        let hits = build_hit_index(&list).map_err(|error| format!("chart hit index: {error:?}"))?;
        let targets = list
            .commands
            .iter()
            .map(|command| {
                let Deep2dCommand::Path(path) = command else {
                    return Err("chart expected path command".to_owned());
                };
                let (_, index) = path
                    .hit_id
                    .as_deref()
                    .and_then(|id| id.rsplit_once('-'))
                    .ok_or("chart missing hit identity")?;
                Ok(ChartHitTarget {
                    series_id: series.id.clone(),
                    data_index: if index == "series" {
                        None
                    } else {
                        Some(
                            index
                                .parse::<usize>()
                                .map_err(|_| "invalid chart datum identity")?,
                        )
                    },
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        // 顶点/线段索引仍然只建折线;反解器所有 cartesian 系列都有。
        let points = mapped.into_iter().next().map(|(id, mapped)| {
            let invert_x = mapped.invert_x.clone();
            let index = (series.series_type == ChartSeriesType::Line).then(|| {
                super::line_point_index::LinePointIndex::from_mapped(&id, dependencies.plot, mapped)
            });
            (index, invert_x)
        });
        let (points, invert_x) =
            points.map_or((None, None), |(points, invert_x)| (points, Some(invert_x)));
        Ok((
            Self {
                id: series.id.clone(),
                dependencies,
                hits,
                targets,
                points,
                invert_x,
            },
            list,
        ))
    }
}
