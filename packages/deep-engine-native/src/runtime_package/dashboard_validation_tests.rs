use super::*;
fn document() -> DashboardRuntimeV1 {
    let p: serde_json::Value = serde_json::from_str(include_str!(
        "../../../deep-engine/fixtures/dashboard-composition-v1.json"
    ))
    .unwrap();
    serde_json::from_value(p["payloads"]["dashboard.root"].clone()).unwrap()
}
#[test]
fn page_budget_accepts_32_and_rejects_33() {
    let mut d = document();
    let mut page = d.pages[0].clone();
    page.nodes.clear();
    d.pages = (0..32)
        .map(|i| {
            let mut p = page.clone();
            p.id = format!("page.{i:064x}");
            p
        })
        .collect();
    d.entry_page_id = d.pages[0].id.clone();
    assert!(validate(&d).is_ok());
    page.id = format!("page.{:064x}", 32);
    d.pages.push(page);
    assert!(validate(&d).is_err());
}
#[test]
fn node_and_chart_budget_are_global_including_hidden_nodes() {
    let mut d = document();
    let mut node = d.pages[0].nodes[0].clone();
    node.visible = false;
    node.hit_id = None;
    node.chart = None;
    node.chart_sim = None;
    node.deep2d = Some("static".into());
    d.pages.truncate(1);
    d.pages[0].nodes = (0..128)
        .map(|i| {
            let mut n = node.clone();
            n.id = format!("node.{i:064x}");
            n
        })
        .collect();
    assert!(validate(&d).is_ok());
    node.id = format!("node.{:064x}", 128);
    d.pages[0].nodes.push(node);
    assert!(validate(&d).is_err());
    d.pages[0].nodes.truncate(33);
    for n in &mut d.pages[0].nodes {
        n.chart = Some("chart".into());
    }
    assert!(validate(&d).is_err());
    d.pages[0].nodes.pop();
    assert!(validate(&d).is_ok());
}
#[test]
fn rectangle_boundary_and_document_utf8_bytes_are_exact() {
    let mut d = document();
    d.pages[0].width = MAX_COORD;
    d.pages[0].nodes[0].frame = [-MAX_COORD, MAX_COORD, MAX_COORD, MAX_COORD];
    d.document_id = "é".repeat(128);
    assert!(validate(&d).is_ok());
    d.document_id.push('a');
    assert!(validate(&d).is_err());
    d.document_id = "author".into();
    d.pages[0].nodes[0].frame[0] = MAX_COORD + 1.;
    assert!(validate(&d).is_err());
}
