use super::{HEIGHT, WIDTH, draw_to_pixels, gpu_context};
use deep_engine_native::chart::{ChartScale, parse_chart_ir, render_chart_with_windows};
use deep_engine_native::deep2d::Deep2dRuntimeContent;
use serde_json::json;

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn heatmap_zoom_preserves_cell_colors_and_clips_pixels() {
    pollster::block_on(async {
        let (device, queue, adapter) = gpu_context().await;
        assert_ne!(adapter.get_info().device_type, wgpu::DeviceType::Cpu);
        let mut ir = parse_chart_ir(include_bytes!(
            "../../deep-engine/fixtures/chart-ir-v1.json"
        ))
        .unwrap();
        ir.series.retain(|series| series.id == "heat");
        ir.axes[1].scale = ChartScale::Category;
        ir.axes[1].min = None;
        ir.axes[1].max = None;
        ir.legend.visible = true;
        ir.legend.position = deep_engine_native::chart::interaction_contract::LegendPosition::Top;
        ir.data_zoom.clear();
        ir.actions.clear();
        ir.datasets[0].rows = vec![
            vec![json!("A"), json!("row1"), json!(0), json!("a")],
            vec![json!("B"), json!("row1"), json!(10), json!("b")],
            vec![json!("A"), json!("row2"), json!(20), json!("c")],
            vec![json!("B"), json!("row2"), json!(30), json!("d")],
        ]
        .into();
        let mut captures = Vec::new();
        for windows in [vec![], vec![("x".into(), 0.0, 0.5)], vec![]] {
            let list =
                render_chart_with_windows(&ir, WIDTH.into(), HEIGHT.into(), &[], &windows).unwrap();
            captures.push(
                draw_to_pixels(&device, &queue, &Deep2dRuntimeContent::DisplayList(list)).unwrap(),
            );
        }
        assert_ne!(captures[0], captures[1]);
        assert_eq!(captures[0], captures[2]);
        for y in [38, 50] {
            assert_eq!(
                captures[0][y * WIDTH as usize + 36],
                captures[1][y * WIDTH as usize + 64]
            );
            assert!(captures[1][y * WIDTH as usize + 64][3] > 0);
        }
        for (index, pixel) in captures[1].iter().enumerate() {
            let (x, y) = (index % WIDTH as usize, index / WIDTH as usize);
            if !(8..120).contains(&x) || !(32..56).contains(&y) {
                assert_eq!(pixel[3], 0);
            }
        }
    });
}
