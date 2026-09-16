use super::{HEIGHT, WIDTH, draw_to_pixels, gpu_context, line_ir};
use deep_engine_native::{
    chart::{ChartAction, ChartRuntime, state_render::append_state_outlines},
    deep2d::Deep2dRuntimeContent,
    native_ui::design_tokens::DesignTokenSnapshot,
};

#[test]
#[ignore = "requires a real Vulkan GPU"]
fn selected_outline_changes_real_pixels_and_deselect_restores_baseline() {
    pollster::block_on(async {
        let (device, queue, _) = gpu_context().await;
        let mut source = line_ir(vec![(0.0, 0.0), (1.0, 1.0)]);
        source.legend.visible = false;
        let mut chart = ChartRuntime::new(source, WIDTH.into(), HEIGHT.into()).unwrap();
        let tokens: DesignTokenSnapshot =
            serde_json::from_str(include_str!("../fixtures/design-tokens-v1.json")).unwrap();
        let draw = |chart: &ChartRuntime| {
            let mut list = chart.frame().display_list().clone();
            append_state_outlines(&mut list, chart, &tokens.themes.dark).unwrap();
            draw_to_pixels(&device, &queue, &Deep2dRuntimeContent::DisplayList(list)).unwrap()
        };
        let baseline = draw(&chart);
        chart
            .dispatch(ChartAction::Select {
                series_id: "line".into(),
                data_index: None,
            })
            .unwrap();
        let selected = draw(&chart);
        assert!(
            baseline
                .iter()
                .zip(&selected)
                .filter(|(a, b)| a != b)
                .count()
                > 100
        );
        let accent = tokens
            .themes
            .dark
            .colors
            .accent
            .unwrap()
            .map(|v| (v * 255.0).round() as u8);
        assert!(
            selected
                .iter()
                .filter(|pixel| (0..4).all(|i| pixel[i].abs_diff(accent[i]) <= 1))
                .count()
                > 50
        );
        chart
            .dispatch(ChartAction::Deselect {
                series_id: "line".into(),
                data_index: None,
            })
            .unwrap();
        assert_eq!(draw(&chart), baseline);
    });
}

#[test]
#[ignore = "requires a real Vulkan GPU"]
fn line_datum_marker_changes_only_pixels_near_the_selected_source_point() {
    pollster::block_on(async {
        let (device, queue, _) = gpu_context().await;
        let mut source = line_ir(vec![(0.0, 0.0), (0.5, 0.5), (1.0, 1.0)]);
        source.legend.visible = false;
        let mut chart = ChartRuntime::new(source, WIDTH.into(), HEIGHT.into()).unwrap();
        let tokens: DesignTokenSnapshot =
            serde_json::from_str(include_str!("../fixtures/design-tokens-v1.json")).unwrap();
        let draw = |chart: &ChartRuntime| {
            let mut list = chart.frame().display_list().clone();
            append_state_outlines(&mut list, chart, &tokens.themes.dark).unwrap();
            draw_to_pixels(&device, &queue, &Deep2dRuntimeContent::DisplayList(list)).unwrap()
        };
        let baseline = draw(&chart);
        chart
            .dispatch(ChartAction::Select {
                series_id: "line".into(),
                data_index: Some(1),
            })
            .unwrap();
        let selected = draw(&chart);
        let changed = baseline
            .iter()
            .zip(&selected)
            .enumerate()
            .filter(|(_, (a, b))| a != b)
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        assert!(changed.len() > 20);
        for index in changed {
            let (x, y) = (index as u32 % WIDTH, index as u32 / WIDTH);
            assert!(
                (57..=70).contains(&x) && (25..=38).contains(&y),
                "unexpected changed pixel {x},{y}"
            );
        }
        chart
            .dispatch(ChartAction::Deselect {
                series_id: "line".into(),
                data_index: Some(1),
            })
            .unwrap();
        assert_eq!(draw(&chart), baseline);
    });
}
