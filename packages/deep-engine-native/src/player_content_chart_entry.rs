//! 图表入口装配:校验过的 ChartIR/sim 载荷重建运行时、sim 宿主与展示列表。
use super::chart_sim::ChartSimHost;
use deep_engine_native::{
    chart::{ChartIR, ChartRuntime, simulation::ChartSimFixture},
    deep2d::Deep2dRuntimeContent,
};

pub(super) struct ChartEntry {
    pub chart: Option<ChartRuntime>,
    pub deep2d: Option<Deep2dRuntimeContent>,
    pub chart_sim: Option<ChartSimHost>,
}

/// ChartIR 展示列表与静态 deep2d 入口互斥(包校验强制);sim 载荷必须伴随 chart。
pub(super) fn assemble(
    chart_source: Option<ChartIR>,
    chart_sim_fixture: Option<ChartSimFixture>,
    static_deep2d: Option<Deep2dRuntimeContent>,
) -> Result<ChartEntry, String> {
    let chart = chart_source
        .map(|source| ChartRuntime::new(source, 640.0, 360.0))
        .transpose()?;
    let deep2d = match chart.as_ref() {
        Some(chart) => {
            let mut rasterizer = deep_engine_native::platform_text::runtime_text_rasterizer()?;
            let list = deep_engine_native::chart::presentation::present_chart(
                chart,
                &mut rasterizer,
                0,
                [0.0, 0.0],
                None,
            )?;
            Some(Deep2dRuntimeContent::DisplayList(list))
        }
        None => static_deep2d,
    };
    let chart_sim = match (&chart, chart_sim_fixture) {
        (Some(chart), Some(fixture)) => Some(ChartSimHost::new(fixture, chart)?),
        (None, Some(_)) => {
            return Err("runtime package chart sim requires a chart entrypoint".into());
        }
        (_, None) => None,
    };
    Ok(ChartEntry {
        chart,
        deep2d,
        chart_sim,
    })
}
