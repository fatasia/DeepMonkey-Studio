use deep_engine_native::chart::{
    ChartAction, ChartIR, InteractionState, parse_chart_ir, render_chart,
    render_chart_with_hidden_series,
};
use deep_engine_native::deep2d::{Deep2dDisplayList, Deep2dResource};
use std::collections::BTreeMap;

fn fixture() -> ChartIR {
    parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap()
}
fn paths(list: &Deep2dDisplayList) -> BTreeMap<String, serde_json::Value> {
    list.resources
        .iter()
        .map(|resource| {
            let Deep2dResource::Path(path) = resource else {
                panic!("chart path")
            };
            (path.id.clone(), serde_json::to_value(path).unwrap())
        })
        .collect()
}

#[test]
fn live_legend_toggles_remove_geometry_and_restore_it_exactly() {
    let ir = fixture();
    let full = render_chart(&ir, 480.0, 320.0).unwrap();
    let mut state = InteractionState::from_ir(&ir).unwrap();
    for series in &ir.series {
        let action = || ChartAction::ToggleLegend {
            series_id: series.id.clone(),
        };
        state.apply(&ir, action()).unwrap();
        let hidden =
            render_chart_with_hidden_series(&ir, 480.0, 320.0, &state.hidden_series).unwrap();
        assert!(
            hidden.commands.len() < full.commands.len(),
            "{} must disappear",
            series.id
        );
        let original = paths(&full);
        for (id, path) in paths(&hidden) {
            assert_eq!(
                original.get(&id),
                Some(&path),
                "other series retain identity and geometry"
            );
        }
        state.apply(&ir, action()).unwrap();
        let restored =
            render_chart_with_hidden_series(&ir, 480.0, 320.0, &state.hidden_series).unwrap();
        assert_eq!(
            serde_json::to_value(restored).unwrap(),
            serde_json::to_value(&full).unwrap()
        );
    }
}

#[test]
fn all_hidden_emits_no_paths_and_unknown_hidden_id_is_rejected() {
    let ir = fixture();
    let hidden = ir
        .series
        .iter()
        .map(|series| series.id.clone())
        .collect::<Vec<_>>();
    let empty = render_chart_with_hidden_series(&ir, 480.0, 320.0, &hidden).unwrap();
    assert!(empty.commands.is_empty() && empty.resources.is_empty());
    assert!(render_chart_with_hidden_series(&ir, 480.0, 320.0, &["missing".into()]).is_err());
    let twice = vec![hidden[0].clone(), hidden[0].clone()];
    assert_eq!(
        paths(&render_chart_with_hidden_series(&ir, 480.0, 320.0, &twice).unwrap()),
        paths(&render_chart_with_hidden_series(&ir, 480.0, 320.0, &twice[..1]).unwrap())
    );
}

#[test]
fn reordering_series_preserves_resource_identity_and_geometry() {
    let mut ir = fixture();
    let before = render_chart(&ir, 480.0, 320.0).unwrap();
    ir.series.reverse();
    let after = render_chart(&ir, 480.0, 320.0).unwrap();
    assert_eq!(paths(&before), paths(&after));
    assert_ne!(
        serde_json::to_value(before.commands).unwrap(),
        serde_json::to_value(after.commands).unwrap(),
        "paint order follows source order"
    );
}
