use super::{HEIGHT, WIDTH, draw_to_pixels, gpu_context, line_ir};
use deep_engine_native::chart::{
    ChartDataUpdate, ChartRuntime, DatasetRowsUpdate, render_chart_with_windows,
};
use deep_engine_native::deep2d::Deep2dRuntimeContent;
use serde_json::json;

#[test]
#[ignore = "requires a real Vulkan GPU"]
fn incremental_series_pixels_match_full_rebuild_and_rejected_update_keeps_frame() {
    pollster::block_on(async {
        let (device, queue, _) = gpu_context().await;
        let mut source = line_ir(vec![(0.0, 0.2), (0.5, 0.4), (1.0, 0.2)]);
        source.legend.visible = false;
        for axis in &mut source.axes {
            axis.min = Some(0.0);
            axis.max = Some(1.0);
        }
        let mut stable = source.series[0].clone();
        stable.id = "stable".into();
        stable.dataset_id = "stable".into();
        let mut data = source.datasets[0].clone();
        data.id = "stable".into();
        data.rows = vec![vec![json!(0.0), json!(0.9)], vec![json!(1.0), json!(0.6)]].into();
        source.series.push(stable);
        source.datasets.push(data);
        let mut chart = ChartRuntime::new(source, WIDTH.into(), HEIGHT.into()).unwrap();
        let draw = |chart: &ChartRuntime| {
            draw_to_pixels(
                &device,
                &queue,
                &Deep2dRuntimeContent::DisplayList(chart.frame().display_list().clone()),
            )
            .unwrap()
        };
        let before = draw(&chart);
        chart
            .update_data(ChartDataUpdate {
                expected_data_revision: 0,
                data_revision: 1,
                datasets: vec![DatasetRowsUpdate::Replace {
                    dataset_id: "d".into(),
                    rows: vec![
                        vec![json!(0.0), json!(0.7)],
                        vec![json!(0.5), json!(0.2)],
                        vec![json!(1.0), json!(0.7)],
                    ],
                }],
            })
            .unwrap();
        assert_eq!(chart.frame().work().series_reused, 1);
        let updated = draw(&chart);
        assert!(before.iter().zip(&updated).filter(|(a, b)| a != b).count() > 50);
        let reference = render_chart_with_windows(
            chart.source(),
            WIDTH.into(),
            HEIGHT.into(),
            &chart.state().hidden_series,
            &chart.state().zoom_windows,
        )
        .unwrap();
        assert_eq!(
            updated,
            draw_to_pixels(
                &device,
                &queue,
                &Deep2dRuntimeContent::DisplayList(reference)
            )
            .unwrap()
        );
        let active = chart.clone();
        assert!(
            chart
                .update_data(ChartDataUpdate {
                    expected_data_revision: 0,
                    data_revision: 1,
                    datasets: vec![DatasetRowsUpdate::Replace {
                        dataset_id: "d".into(),
                        rows: vec![]
                    }]
                })
                .is_err()
        );
        assert!(std::ptr::eq(chart.frame(), active.frame()));
        assert_eq!(draw(&chart), updated);
    });
}
