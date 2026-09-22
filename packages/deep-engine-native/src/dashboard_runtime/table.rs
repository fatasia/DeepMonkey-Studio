use super::DashboardRuntime;
use crate::runtime_package::{
    DashboardTable, DashboardTableLayer, DashboardTableOrder, DashboardTableView,
};

#[derive(Clone, Default)]
pub(super) struct TableState {
    column: Option<String>,
    direction: Option<String>,
    page: usize,
}
#[derive(Clone, Debug)]
pub struct TableAction {
    pub table_id: String,
    pub action: String,
    pub column: Option<String>,
}

impl DashboardRuntime {
    fn table_order<'a>(&self, table: &'a DashboardTable) -> Option<&'a DashboardTableOrder> {
        let family = table.families.get(self.selected_filter.unwrap_or(0))?;
        let state = self.table_states.get(&table.id);
        family
            .orders
            .iter()
            .find(|order| {
                state.is_some_and(|state| {
                    order.column == state.column && order.direction == state.direction
                })
            })
            .or_else(|| family.orders.first())
    }
    pub(super) fn table_view<'a>(
        &self,
        table: &'a DashboardTable,
    ) -> Option<&'a DashboardTableView> {
        let order = self.table_order(table)?;
        order.pages.get(
            self.table_states
                .get(&table.id)
                .map_or(0, |state| state.page)
                .min(order.pages.len().saturating_sub(1)),
        )
    }
    pub(super) fn table_layer(&self, node_id: &str) -> Option<Option<&DashboardTableLayer>> {
        let table = self
            .document()
            .tables
            .iter()
            .find(|table| table.node_ids.iter().any(|id| id == node_id))?;
        Some(
            self.table_view(table)
                .and_then(|view| view.layers.iter().find(|layer| layer.node_id == node_id)),
        )
    }
    pub fn table_action_at(&self, point: [f64; 2]) -> Option<TableAction> {
        let page = self
            .document()
            .pages
            .iter()
            .find(|page| page.id == self.page_id)?;
        for table in self
            .document()
            .tables
            .iter()
            .rev()
            .filter(|table| table.page_id == self.page_id)
        {
            let node = page
                .nodes
                .iter()
                .find(|node| table.node_ids.first() == Some(&node.id))?;
            if !node.visible {
                continue;
            }
            let local = [point[0] - node.frame[0], point[1] - node.frame[1]];
            if local[0] < 0.0
                || local[1] < 0.0
                || local[0] >= node.frame[2]
                || local[1] >= node.frame[3]
            {
                continue;
            }
            for control in &self.table_view(table)?.controls {
                let [x, y, width, height] = control.rect;
                if control.enabled
                    && local[0] >= x
                    && local[1] >= y
                    && local[0] < x + width
                    && local[1] < y + height
                {
                    return Some(TableAction {
                        table_id: table.id.clone(),
                        action: control.action.clone(),
                        column: control.column.clone(),
                    });
                }
            }
        }
        None
    }
    pub fn table_action(&mut self, action: &TableAction) -> Result<bool, String> {
        let table = self
            .document()
            .tables
            .iter()
            .find(|table| table.id == action.table_id)
            .ok_or("table missing")?;
        let count = self
            .table_order(table)
            .ok_or("table order missing")?
            .pages
            .len();
        if action.action == "sort"
            && (action.column.is_none()
                || !table.families[self.selected_filter.unwrap_or(0)]
                    .orders
                    .iter()
                    .any(|order| order.column == action.column))
        {
            return Err("unknown table sort column".into());
        }
        self.transaction(|candidate| {
            let state = candidate
                .table_states
                .entry(action.table_id.clone())
                .or_default();
            let current = state.page.min(count.saturating_sub(1));
            match action.action.as_str() {
                "sort" => {
                    let column = action.column.as_ref().ok_or("sort column missing")?;
                    let direction = if state.column.as_ref() == Some(column)
                        && state.direction.as_deref() == Some("asc")
                    {
                        "desc"
                    } else {
                        "asc"
                    };
                    state.column = Some(column.clone());
                    state.direction = Some(direction.into());
                    state.page = 0;
                }
                "previous" => {
                    if current == 0 {
                        return Ok(false);
                    }
                    state.page = current - 1;
                }
                "next" => {
                    if current + 1 >= count {
                        return Ok(false);
                    }
                    state.page = current + 1;
                }
                _ => return Err("unsupported table state action".into()),
            }
            Ok(true)
        })
    }
    pub fn table_export(&self, action: &TableAction) -> Result<(String, Vec<u8>), String> {
        let table = self
            .document()
            .tables
            .iter()
            .find(|table| table.id == action.table_id)
            .ok_or("table missing")?;
        let order = self.table_order(table).ok_or("table order missing")?;
        let value = match action.action.as_str() {
            "csv" => &order.exports.csv,
            "xlsx" => &order.exports.xlsx,
            _ => return Err("unsupported table export".into()),
        };
        let title: String = table
            .title
            .chars()
            .map(|value| {
                if value.is_control() || "<>:\"/\\|?*".contains(value) {
                    '_'
                } else {
                    value
                }
            })
            .take(100)
            .collect();
        let title = if title.is_empty() { "report" } else { &title };
        Ok((
            format!("{title}.{}", action.action),
            crate::deep2d::runtime_base64::decode(value).map_err(str::to_owned)?,
        ))
    }
}
