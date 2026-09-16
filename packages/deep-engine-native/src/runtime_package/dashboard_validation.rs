use super::{DashboardRuntimeV1, RuntimePackageError, fail};
use std::collections::HashSet;
const MAX_SAFE: u64 = 9_007_199_254_740_991;
const MAX_COORD: f64 = 16_777_216.0;
fn revision(value: u64) -> bool {
    (1..=MAX_SAFE).contains(&value)
}
fn identity(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn size(value: f64) -> bool {
    value.is_finite() && value > 0.0 && value <= MAX_COORD
}
fn rect(value: &[f64; 4]) -> bool {
    value[0].is_finite()
        && value[0].abs() <= MAX_COORD
        && value[1].is_finite()
        && value[1].abs() <= MAX_COORD
        && size(value[2])
        && size(value[3])
}
pub(super) fn validate(root: &DashboardRuntimeV1) -> Result<(), RuntimePackageError> {
    if !revision(root.revision)
        || !revision(root.document_revision)
        || root.document_id.is_empty()
        || root.document_id.len() > 256
        || root.document_id.chars().any(char::is_control)
        || root.pages.is_empty()
        || root.pages.len() > 32
    {
        return fail("invalid dashboard document identity, revision or page budget");
    }
    let mut pages = HashSet::new();
    let mut nodes = HashSet::new();
    let mut charts = 0;
    for page in &root.pages {
        if !identity(&page.id, "page.")
            || !pages.insert(page.id.as_str())
            || !size(page.width)
            || !size(page.height)
        {
            return fail("invalid dashboard page identity or dimensions");
        }
        if page
            .nodes
            .windows(2)
            .any(|p| (p[0].z_order, &p[0].id) >= (p[1].z_order, &p[1].id))
        {
            return fail("dashboard nodes must be sorted by zOrder and id");
        }
        for node in &page.nodes {
            if !identity(&node.id, "node.")
                || !nodes.insert(node.id.as_str())
                || !revision(node.revision)
                || !rect(&node.frame)
                || node.clip.as_ref().is_some_and(|v| !rect(v))
                || node.hit_id.as_ref().is_some_and(|v| v != &node.id)
                || (node.deep2d.is_none() && node.chart.is_none())
                || (node.chart_sim.is_some() && node.chart.is_none())
            {
                return fail(
                    "invalid dashboard node identity, geometry, hit or content references",
                );
            }
            charts += usize::from(node.chart.is_some());
        }
    }
    if !pages.contains(root.entry_page_id.as_str()) || nodes.len() > 128 || charts > 32 {
        return fail("dashboard entry page is absent or node/chart budget exceeded");
    }
    Ok(())
}

// JSON numbers carry no integer-token distinction in the shared wire contract.
pub(super) fn normalize_integers(root: &mut serde_json::Value) {
    fn fields(object: &mut serde_json::Value, keys: &[&str]) {
        for key in keys {
            if let Some(value) = object.get_mut(*key)
                && let Some(number) = value
                    .as_f64()
                    .filter(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= MAX_SAFE as f64)
            {
                *value = serde_json::Value::from(number as i64);
            }
        }
    }
    fields(root, &["schemaVersion", "revision", "documentRevision"]);
    if let Some(pages) = root
        .get_mut("pages")
        .and_then(serde_json::Value::as_array_mut)
    {
        for page in pages {
            if let Some(nodes) = page
                .get_mut("nodes")
                .and_then(serde_json::Value::as_array_mut)
            {
                for node in nodes {
                    fields(node, &["revision", "zOrder"]);
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "dashboard_validation_tests.rs"]
mod tests;
