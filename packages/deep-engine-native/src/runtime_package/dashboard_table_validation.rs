use super::{DashboardRuntimeV1, RuntimePackageError, fail};
use std::collections::{BTreeSet, HashMap, HashSet};
pub(super) fn resources(root: &DashboardRuntimeV1) -> Result<Vec<String>, RuntimePackageError> {
    let base: HashMap<_, _> = root
        .pages
        .iter()
        .flat_map(|page| &page.nodes)
        .filter_map(|node| {
            node.deep2d
                .as_ref()
                .map(|id| (id.as_str(), node.id.as_str()))
        })
        .collect();
    let mut table_ids = HashSet::new();
    let mut slots = HashSet::new();
    let mut owners = HashMap::new();
    let mut added = BTreeSet::new();
    let mut views = 0usize;
    let mut bytes = 0usize;
    if root.tables.len() > 32 {
        return fail("dashboard table budget exceeded");
    }
    for table in &root.tables {
        let Some(page) = root.pages.iter().find(|page| page.id == table.page_id) else {
            return fail("table page missing");
        };
        if table.id.is_empty()
            || table.id.len() > 256
            || !table_ids.insert(&table.id)
            || table.title.chars().count() > 256
            || table.title.chars().any(char::is_control)
            || table.node_ids.is_empty()
            || table.node_ids.len() > 128
        {
            return fail("invalid table identity/slots");
        }
        let mut owned = HashSet::new();
        let mut slot_frame = None;
        for slot in &table.node_ids {
            let Some(node) = page.nodes.iter().find(|node| node.id == *slot) else {
                return fail("table slot missing");
            };
            if node.deep2d.is_none()
                || node.chart.is_some()
                || node.hit_id.is_some()
                || !slots.insert(slot.as_str())
                || slot_frame.is_some_and(|frame| frame != node.frame)
            {
                return fail("invalid table slot owner");
            }
            owned.insert(slot.as_str());
            slot_frame = Some(node.frame);
        }
        let families = root
            .filter
            .as_ref()
            .map_or(1, |filter| filter.options.len());
        if table.families.len() != families || families > 16 {
            return fail("table filter families differ");
        }
        for family in &table.families {
            if family.orders.is_empty() || family.orders.len() > 257 {
                return fail("table orders outside budget");
            }
            let mut orders = HashSet::new();
            for (index, order) in family.orders.iter().enumerate() {
                let valid = if index == 0 {
                    order.column.is_none() && order.direction.is_none()
                } else {
                    order
                        .column
                        .as_ref()
                        .is_some_and(|value| !value.is_empty() && value.chars().count() <= 256)
                        && matches!(order.direction.as_deref(), Some("asc" | "desc"))
                };
                if !valid || !orders.insert((&order.column, &order.direction)) {
                    return fail("invalid table order");
                }
                for value in [&order.exports.csv, &order.exports.xlsx] {
                    bytes = bytes.saturating_add(
                        crate::deep2d::runtime_base64::decoded_len(value)
                            .map_err(|error| RuntimePackageError(error.into()))?,
                    );
                }
                if bytes > 64 * 1024 * 1024 || order.pages.is_empty() || order.pages.len() > 512 {
                    return fail("table export/view budget exceeded");
                }
                for view in &order.pages {
                    views += 1;
                    if views > 512
                        || view.layers.is_empty()
                        || view.layers.len() > 128
                        || view.controls.len() > 260
                    {
                        return fail("table view budget exceeded");
                    }
                    let mut used = HashSet::new();
                    for layer in &view.layers {
                        if !owned.contains(layer.node_id.as_str())
                            || !used.insert(&layer.node_id)
                            || base
                                .get(layer.deep2d.as_str())
                                .is_some_and(|slot| !owned.contains(slot))
                            || owners
                                .get(&layer.deep2d)
                                .is_some_and(|owner| *owner != &table.id)
                            || layer.clip.as_ref().is_some_and(|value| !rect(value))
                            || layer.origin.as_ref().is_some_and(|o| {
                                o.iter().any(|v| !v.is_finite() || v.abs() > 16_777_216.0)
                            })
                        {
                            return fail("invalid table layer ownership/clip");
                        }
                        owners.insert(&layer.deep2d, &table.id);
                        if !base.contains_key(layer.deep2d.as_str()) {
                            added.insert(layer.deep2d.clone());
                        }
                    }
                    for control in &view.controls {
                        if !matches!(
                            control.action.as_str(),
                            "csv" | "xlsx" | "sort" | "previous" | "next"
                        ) || !rect(&control.rect)
                            || if control.action == "sort" {
                                control.column.is_none()
                                    || !family
                                        .orders
                                        .iter()
                                        .any(|order| order.column == control.column)
                            } else {
                                control.column.is_some()
                            }
                        {
                            return fail("invalid table control");
                        }
                    }
                }
            }
        }
    }
    Ok(added.into_iter().collect())
}
fn rect(value: &[f64; 4]) -> bool {
    value
        .iter()
        .all(|value| value.is_finite() && value.abs() <= 16_777_216.0)
        && value[2] > 0.0
        && value[3] > 0.0
}
