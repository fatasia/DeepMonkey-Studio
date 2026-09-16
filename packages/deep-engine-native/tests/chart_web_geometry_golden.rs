//! Native geometry reference for the browser ChartIR frame producer.
use deep_engine_native::chart::{parse_chart_ir, render_chart};
use serde_json::{Value, json};

fn input(kind: &str, rows: Value, position: &str, visible: bool) -> Value {
    let series = if kind == "pie" {
        json!({"id":"series.a","label":"Series","type":kind,"datasetId":"data",
            "name":"x","value":"y"})
    } else {
        json!({"id":"series.a","label":"Series","type":kind,"datasetId":"data",
            "x":"x","y":"y","xAxisId":"axis.x","yAxisId":"axis.y"})
    };
    json!({"schemaVersion":1,"sourceSpecVersion":1,"id":"chart-web-reference",
        "datasets":[{"id":"data","dimensions":["x","y"],"rows":rows}],
        "axes":[{"id":"axis.x","channel":"x","scale":"category","min":null,"max":null},
            {"id":"axis.y","channel":"y","scale":"linear","min":null,"max":null}],
        "series":[series],"legend":{"visible":visible,"position":position},
        "tooltip":{"enabled":true,"trigger":"item"},"dataZoom":[],"actions":[]})
}

fn cases() -> Vec<Value> {
    let mut cases = Vec::new();
    for kind in ["bar", "line", "scatter", "pie"] {
        for position in ["top", "bottom", "left", "right"] {
            cases.push(
                json!({"name":format!("{kind}-{position}"),"width":480.25,"height":320.5,
                "ir":input(kind,json!([["A",-2],["B",4],["C",9]]),position,true)}),
            );
        }
        cases.push(
            json!({"name":format!("{kind}-single"),"width":240,"height":120,
            "ir":input(kind,json!([["only",5]]),"top",false)}),
        );
        cases.push(
            json!({"name":format!("{kind}-empty"),"width":240,"height":120,
            "ir":input(kind,json!([]),"top",false)}),
        );
    }
    for scale in ["linear", "log", "time"] {
        let mut ir = input("line", json!([[1, 2], [10, 5], [100, 20]]), "top", false);
        ir["axes"][0]["scale"] = json!(scale);
        ir["axes"][1]["scale"] = json!(scale);
        cases.push(json!({"name":format!("line-{scale}"),"width":320,"height":240,"ir":ir}));
    }
    let rows: Vec<_> = (0..600).map(|i| json!([i, (i * 37 % 101) - 50])).collect();
    cases.push(json!({"name":"line-dense","width":480,"height":320,
        "ir":input("line",json!(rows),"top",false)}));
    for kind in ["bar", "line"] {
        let mut ir = input(kind, json!([[1, 7], [2, 9]]), "top", false);
        ir["datasets"].as_array_mut().unwrap().push(json!({
            "id":"peer","dimensions":["x","y"],"rows":[[10,70],[20,90]]}));
        let mut peer = ir["series"][0].clone();
        peer["id"] = json!("series.b");
        peer["datasetId"] = json!("peer");
        ir["series"].as_array_mut().unwrap().push(peer);
        if kind == "line" {
            ir["axes"][0]["scale"] = json!("linear");
        }
        cases
            .push(json!({"name":format!("{kind}-shared-domain"),"width":216,"height":116,"ir":ir}));
    }
    for scale in ["category", "linear", "log"] {
        let mut ir = input("bar", json!([]), "top", false);
        ir["datasets"][0] = json!({"id":"data","dimensions":["x","y","value"],
            "rows":[[1,1,2],[10,1,5],[1,10,8],[10,10,11]]});
        ir["series"][0] = json!({"id":"series.a","label":"Heat","type":"heatmap","datasetId":"data",
            "x":"x","y":"y","value":"value","xAxisId":"axis.x","yAxisId":"axis.y"});
        ir["axes"][0]["scale"] = json!(scale);
        ir["axes"][1]["scale"] = json!(scale);
        cases.push(json!({"name":format!("heatmap-{scale}"),"width":320,"height":240,"ir":ir}));
    }
    for value in [0, 50, 100] {
        let mut ir = input("pie", json!([["Gauge", value]]), "top", false);
        ir["series"][0] = json!({"id":"series.a","label":"Gauge","type":"gauge","datasetId":"data",
            "name":"x","value":"y","min":0,"max":100});
        cases.push(json!({"name":format!("gauge-{value}"),"width":320,"height":240,"ir":ir}));
    }
    cases
}

#[test]
fn native_chart_geometry_reference() {
    let mut output = cases();
    for case in &mut output {
        let ir = parse_chart_ir(&serde_json::to_vec(&case["ir"]).unwrap()).unwrap();
        let list = render_chart(
            &ir,
            case["width"].as_f64().unwrap(),
            case["height"].as_f64().unwrap(),
        )
        .unwrap();
        case["displayList"] = serde_json::to_value(list).unwrap();
    }
    assert_eq!(output.len(), 36);
    if let Some(path) = std::env::var_os("DEEP_CHART_GEOMETRY_REFERENCE") {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .unwrap();
        serde_json::to_writer_pretty(file, &json!({"schemaVersion":1,"cases":output})).unwrap();
    }
}
