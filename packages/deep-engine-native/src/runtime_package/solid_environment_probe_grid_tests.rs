use super::*;

#[test]
fn decodes_grid_into_header_and_records() {
    let environment = serde_json::json!({
        "irradianceProbes": {
            "schema": "deep-engine.probe-grid", "schemaVersion": 1,
            "origin": [-3, -2, -3], "spacing": 2, "gridSize": [2, 2, 2],
            "probes": [
                {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1000000,"distanceVariance":0},
                {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1000000,"distanceVariance":0},
                {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1000000,"distanceVariance":0},
                {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1000000,"distanceVariance":0},
                {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1000000,"distanceVariance":0},
                {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1000000,"distanceVariance":0},
                {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1000000,"distanceVariance":0},
                {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1000000,"distanceVariance":0}
            ]
        }
    });
    let records = decode_probe_grid(&environment)
        .unwrap()
        .expect("grid must decode");
    assert_eq!(records.len(), 9);
    // 头解码合同:网格头 + 8 探针。
    let header = crate::probe_gi_grid::ProbeGiGridHeader::decode(&records[0]).unwrap();
    assert_eq!(header.probe_count, 8);
    assert_eq!(header.grid_size, [2, 2, 2]);
    // 缺字段(无 irradianceProbes)→ None;坏 schema → Err。
    assert!(decode_probe_grid(&serde_json::json!({})).unwrap().is_none());
    assert!(
        decode_probe_grid(&serde_json::json!({
            "irradianceProbes": {"schema": "wrong", "schemaVersion": 1}
        }))
        .is_err()
    );
    // 探针记录非法(validity 越界)→ Err。
    let bad = serde_json::json!({
        "irradianceProbes": {"schema": "deep-engine.probe-grid", "schemaVersion": 1,
            "origin": [-3, -2, -3], "spacing": 2, "gridSize": [2, 2, 2],
            "probes": [
                {"irradiance":[0.5,0.25,0.125],"validity":2,"meanDistance":1,"distanceVariance":0},
                {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1,"distanceVariance":0},
                {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1,"distanceVariance":0},
                {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1,"distanceVariance":0},
                {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1,"distanceVariance":0},
                {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1,"distanceVariance":0},
                {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1,"distanceVariance":0},
                {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1,"distanceVariance":0}
            ]}
    });
    assert!(decode_probe_grid(&bad).is_err());
}

/// 级联层 JSON:2×2×2、8 支确定性探针(与单层测试同探针形状)。
fn cascade_level(origin: [f64; 3], spacing: f64, validity: f64) -> serde_json::Value {
    let probes: Vec<serde_json::Value> = (0..8)
        .map(|_| {
            serde_json::json!({
                "irradiance": [0.5, 0.25, 0.125],
                "validity": validity,
                "meanDistance": 1000.0,
                "distanceVariance": 0.0
            })
        })
        .collect();
    serde_json::json!({
        "origin": origin, "spacing": spacing, "gridSize": [2, 2, 2],
        "probes": probes
    })
}

fn cascade_environment(levels: Vec<serde_json::Value>) -> serde_json::Value {
    serde_json::json!({
        "irradianceProbes": {
            "schema": "deep-engine.probe-grid", "schemaVersion": 1,
            "levels": levels
        }
    })
}

/// v2 级联载荷 → 布局头 + 每层"网格头 + 探针"记录流;层头 padding=
/// 本层首条探针记录号,记录流可被 renderer 同款 decode_probe_grid_cascade
/// 解码(细→粗两层、记录精确排布)。
#[test]
fn decodes_cascade_levels_into_v2_record_stream() {
    let environment = cascade_environment(vec![
        cascade_level([0.0, 0.0, 0.0], 2.0, 1.0),
        cascade_level([0.0, 0.0, 0.0], 4.0, 1.0),
    ]);
    let records = decode_probe_grid(&environment)
        .unwrap()
        .expect("cascade must decode");
    // 布局头 + (层头+8 探针) × 2 层。
    assert_eq!(records.len(), 1 + (1 + 8) + (1 + 8));
    let layout = crate::probe_gi_grid::ProbeGiGridLayoutHeader::decode(&records[0]).unwrap();
    assert_eq!(layout.level_count, 2);
    assert_eq!(layout.levels_start_record, 1);
    // 层头 padding = 本层首条探针记录号:细层 = 2(布局头+层头之后),
    // 粗层 = 11(布局头 + 细层 9 条 + 粗层层头之后)。
    let fine = crate::probe_gi_grid::ProbeGiGridHeader::decode_with_base(&records[1], 2).unwrap();
    let coarse =
        crate::probe_gi_grid::ProbeGiGridHeader::decode_with_base(&records[10], 11).unwrap();
    assert_eq!(fine.spacing, 2.0);
    assert_eq!(coarse.spacing, 4.0);
    // renderer 装载端同款级联解码必须接受该记录流(细→粗、精确排布)。
    let cascade = crate::probe_gi_grid::decode_probe_grid_cascade(&records).unwrap();
    assert_eq!(cascade.levels, vec![fine, coarse]);
    assert_eq!(cascade.header_records, vec![1, 10]);
}

/// 互斥合同:顶层旧单层字段与 levels 并存一律拒绝(fail-closed)。
#[test]
fn cascade_payload_rejects_single_level_field_coexistence() {
    let mut environment = cascade_environment(vec![cascade_level([0.0; 3], 2.0, 1.0)]);
    environment["irradianceProbes"]["origin"] = serde_json::json!([0, 0, 0]);
    assert!(decode_probe_grid(&environment).is_err());
    let mut environment = cascade_environment(vec![cascade_level([0.0; 3], 2.0, 1.0)]);
    environment["irradianceProbes"]["probes"] = serde_json::json!([]);
    assert!(decode_probe_grid(&environment).is_err());
}

/// 层序/包含性非法:粗层 spacing 未严格递增、粗层范围未逐轴包含细层,
/// 都在级联全合同复核处 fail-closed。
#[test]
fn cascade_payload_rejects_level_order_and_containment_violations() {
    // 层序非法:粗层 spacing 与细层相等(未严格递增)。
    let equal_spacing = cascade_environment(vec![
        cascade_level([0.0, 0.0, 0.0], 2.0, 1.0),
        cascade_level([0.0, 0.0, 0.0], 2.0, 1.0),
    ]);
    let error = decode_probe_grid(&equal_spacing).unwrap_err();
    assert!(error.contains("cascade rejected"), "{error}");
    // 包含性非法:粗层 origin 偏移导致范围不再逐轴包含细层。
    let not_containing = cascade_environment(vec![
        cascade_level([0.0, 0.0, 0.0], 2.0, 1.0),
        cascade_level([10.0, 0.0, 0.0], 4.0, 1.0),
    ]);
    let error = decode_probe_grid(&not_containing).unwrap_err();
    assert!(error.contains("cascade rejected"), "{error}");
}

/// 层数越界与层内探针非法:空层表/超 4 层/层内 validity 越界全部拒绝,
/// 错误信息带层号定位。
#[test]
fn cascade_payload_rejects_level_count_and_invalid_records() {
    let empty = cascade_environment(vec![]);
    let error = decode_probe_grid(&empty).unwrap_err();
    assert!(error.contains("level count 0"), "{error}");
    let five = cascade_environment((0..5).map(|_| cascade_level([0.0; 3], 1.0, 1.0)).collect());
    assert!(
        decode_probe_grid(&five)
            .unwrap_err()
            .contains("outside [1, 4]")
    );
    let invalid_probe = cascade_environment(vec![cascade_level([0.0; 3], 2.0, 2.0)]);
    let error = decode_probe_grid(&invalid_probe).unwrap_err();
    assert!(error.contains("level 0 probe record"), "{error}");
    // 非数组 levels 与缺 schema 一并 fail-closed。
    let mut not_array = cascade_environment(vec![cascade_level([0.0; 3], 2.0, 1.0)]);
    not_array["irradianceProbes"]["levels"] = serde_json::json!(1);
    assert!(decode_probe_grid(&not_array).is_err());
    let mut wrong_schema = cascade_environment(vec![cascade_level([0.0; 3], 2.0, 1.0)]);
    wrong_schema["irradianceProbes"]["schema"] = serde_json::json!("wrong");
    assert!(decode_probe_grid(&wrong_schema).is_err());
}
