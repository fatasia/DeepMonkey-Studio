use super::*;
use crate::runtime_package::parse_and_validate_runtime_package;

fn fixture() -> DashboardRuntime {
    let mut loaded = parse_and_validate_runtime_package(include_bytes!(
        "../../../deep-engine/fixtures/dashboard-composition-v1.json"
    )).unwrap().dashboard.unwrap();
    let page = &mut loaded.document.pages[0];
    let node = page.nodes.iter_mut().find(|node| node.deep2d.is_some()).unwrap();
    node.hit_id = None;
    let layer = serde_json::json!({"nodeId": node.id, "deep2d": node.deep2d, "clip": null});
    let view = serde_json::json!({"layers": [layer], "controls": [
        {"action":"next","column":null,"rect":[0,0,10,10],"enabled":true}
    ]});
    loaded.document.tables = serde_json::from_value(serde_json::json!([{
        "id":"report", "pageId":page.id, "nodeIds":[node.id], "title":"report/test",
        "families":[{"orders":[
            {"column":null,"direction":null,"exports":{"csv":"YQ==","xlsx":"Yg=="},"pages":[view,view]},
            {"column":"value","direction":"asc","exports":{"csv":"Yw==","xlsx":"ZA=="},"pages":[view,view]},
            {"column":"value","direction":"desc","exports":{"csv":"ZQ==","xlsx":"Zg=="},"pages":[view]}
        ]}]
    }])).unwrap();
    DashboardRuntime::new(loaded).unwrap()
}
fn action(name: &str, column: Option<&str>) -> TableAction {
    TableAction { table_id: "report".into(), action: name.into(), column: column.map(str::to_owned) }
}

#[test]
fn table_sort_page_and_export_share_the_frozen_order() {
    let mut runtime = fixture();
    assert_eq!(runtime.table_export(&action("csv", None)).unwrap(), ("report_test.csv".into(), b"a".to_vec()));
    assert!(runtime.table_action(&action("next", None)).unwrap());
    assert!(!runtime.table_action(&action("next", None)).unwrap());
    assert!(runtime.table_action(&action("sort", Some("value"))).unwrap());
    assert!(!runtime.table_action(&action("previous", None)).unwrap());
    assert_eq!(runtime.table_export(&action("csv", None)).unwrap().1, b"c");
    assert!(runtime.table_action(&action("sort", Some("value"))).unwrap());
    assert_eq!(runtime.table_export(&action("xlsx", None)).unwrap().1, b"f");
    assert!(!runtime.table_action(&action("next", None)).unwrap());
}

#[test]
fn table_rejected_action_keeps_content_order_and_revision() {
    let mut runtime = fixture();
    let before = runtime.content.clone();
    let revision = runtime.revision;
    assert!(runtime.table_action(&action("sort", Some("missing"))).is_err());
    assert!(runtime.table_action(&action("delete", None)).is_err());
    assert_eq!(runtime.revision, revision);
    assert!(Arc::ptr_eq(&before, &runtime.content));
    assert_eq!(runtime.table_export(&action("csv", None)).unwrap().1, b"a");
    runtime.revision = 9_007_199_254_740_991;
    assert!(runtime.table_action(&action("sort", Some("value"))).is_err());
    assert_eq!(runtime.table_export(&action("csv", None)).unwrap().1, b"a");
}
