use super::{HEIGHT, WIDTH, line_ir};
use deep_engine_native::{
    chart::{ChartIR, ChartSeriesType, render_chart},
    deep2d::Deep2dRuntimeContent,
};

pub(super) fn content(source: &ChartIR) -> Deep2dRuntimeContent {
    Deep2dRuntimeContent::DisplayList(render_chart(source, WIDTH.into(), HEIGHT.into()).unwrap())
}

/// 128 点网格散点:与既有 staged-copy 用例同一夹具,每次调用都是全新实例。
pub(super) fn scatter_source() -> ChartIR {
    let mut source = line_ir(
        (0..128)
            .map(|i| {
                (
                    0.025 + (i % 16) as f64 * 0.062,
                    0.05 + (i / 16) as f64 * 0.12,
                )
            })
            .collect(),
    );
    source.legend.visible = false;
    source.series[0].series_type = ChartSeriesType::Scatter;
    for axis in &mut source.axes {
        axis.min = Some(0.0);
        axis.max = Some(1.0);
    }
    source
}
