use deep_engine_native::{
    chart::{
        ChartRuntime, parse_chart_ir,
        presentation::{present_chart, present_chart_scaled},
    },
    deep2d::Deep2dCommand,
    platform_text::TextRasterizer,
};

#[test]
fn chart_density_preserves_geometry_labels_hit_rects_and_clip() {
    let source = parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    let chart = ChartRuntime::new(source, 640.0, 360.0).unwrap();
    let mut text = TextRasterizer::new();
    let baseline = present_chart(&chart, &mut text, 0, [100.0, 100.0], Some(0)).unwrap();
    assert!(!baseline.atlases.is_empty());
    for scale in [0.75, 1.25, 1.5, 2.0] {
        let mut scaled =
            present_chart_scaled(&chart, &mut text, 0, [100.0, 100.0], Some(0), scale).unwrap();
        assert_eq!(scaled.commands.len(), baseline.commands.len());
        for (new, old) in scaled.commands.iter_mut().zip(&baseline.commands) {
            match (new, old) {
                (Deep2dCommand::Image(new), Deep2dCommand::Image(old)) => {
                    assert_eq!([new.x, new.y], [old.x, old.y]);
                    let visible = new
                        .clip_rect
                        .as_ref()
                        .map(|r| [r.x, r.y, r.width, r.height])
                        .unwrap_or([new.x, new.y, new.width, new.height]);
                    assert_eq!(visible, [old.x, old.y, old.width, old.height]);
                    assert_eq!(new.clip_path_ids, old.clip_path_ids);
                    assert_eq!(new.hit_id, old.hit_id);
                    // Only the pixel source rectangle differs, never hit/layout geometry.
                    new.source = old.source;
                    new.width = old.width;
                    new.height = old.height;
                    new.clip_rect = old.clip_rect;
                    assert_eq!(new, old);
                }
                (new, old) => assert_eq!(new, old),
            }
        }
        for (new, old) in scaled.atlases.iter().zip(&baseline.atlases) {
            assert_eq!(new.width, (f64::from(old.width) * scale).ceil() as u32);
            assert_eq!(new.height, (f64::from(old.height) * scale).ceil() as u32);
        }
    }
    assert_eq!(
        present_chart(&chart, &mut text, 0, [100.0, 100.0], Some(0)).unwrap(),
        baseline
    );
}
