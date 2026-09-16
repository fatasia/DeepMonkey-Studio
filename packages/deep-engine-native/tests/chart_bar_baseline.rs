use deep_engine_native::chart::{parse_chart_ir, render_chart};
use deep_engine_native::deep2d::{Deep2dPathVerb, Deep2dResource};
use serde_json::{Value, json};

fn bars(values: [f64; 2], scale: &str, min: Value, max: Value) -> Vec<Vec<f64>> {
    let input = json!({"schemaVersion":1,"sourceSpecVersion":1,"id":"baseline",
        "datasets":[{"id":"data","dimensions":["x","y"],"rows":[["A",values[0]],["B",values[1]]]}],
        "axes":[{"id":"x","channel":"x","scale":"category","min":null,"max":null},
            {"id":"y","channel":"y","scale":scale,"min":min,"max":max}],
        "series":[{"id":"bars","label":"Bars","type":"bar","datasetId":"data",
            "x":"x","y":"y","xAxisId":"x","yAxisId":"y"}],
        "legend":{"visible":false,"position":"top"},"tooltip":{"enabled":false,"trigger":"none"},
        "dataZoom":[],"actions":[]});
    let ir = parse_chart_ir(&serde_json::to_vec(&input).unwrap()).unwrap();
    render_chart(&ir, 216.0, 116.0)
        .unwrap()
        .resources
        .iter()
        .filter_map(|resource| {
            let Deep2dResource::Path(path) = resource else {
                return None;
            };
            Some(
                path.verbs
                    .iter()
                    .filter_map(|verb| match verb {
                        Deep2dPathVerb::Move { y, .. } | Deep2dPathVerb::Line { y, .. } => Some(*y),
                        _ => None,
                    })
                    .collect(),
            )
        })
        .collect()
}

#[test]
fn positive_and_negative_auto_bars_keep_both_nonzero_values_visible() {
    let positive = bars([7.0, 9.0], "linear", Value::Null, Value::Null);
    assert_eq!(positive.len(), 2);
    assert!((positive[0][0] - (108.0 - 700.0 / 9.0)).abs() < 1e-9);
    assert_eq!(positive[0][2], 108.0);
    let negative = bars([-7.0, -9.0], "linear", Value::Null, Value::Null);
    assert_eq!(negative.len(), 2);
    assert_eq!(negative[0][0], 8.0);
    assert!((negative[0][2] - (8.0 + 700.0 / 9.0)).abs() < 1e-9);
}

#[test]
fn explicit_bounds_and_logarithmic_axes_retain_authored_domains() {
    assert_eq!(bars([7.0, 9.0], "linear", json!(7), json!(9)).len(), 1);
    assert_eq!(bars([7.0, 9.0], "log", Value::Null, Value::Null).len(), 1);
    let mixed = bars([-5.0, 5.0], "linear", Value::Null, Value::Null);
    assert_eq!(mixed.len(), 2);
    assert_eq!(mixed[0][0], 58.0);
    assert_eq!(mixed[1][2], 58.0);
}
