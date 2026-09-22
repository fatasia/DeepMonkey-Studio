use super::*;
use crate::chart::DatasetRowsUpdate;

impl DashboardRuntime {
    pub fn focus_filter(&mut self, index: usize) -> Result<bool, String> {
        self.transaction(|candidate| {
            let changed =
                !candidate.keyboard_filter_focus || candidate.selected_filter != Some(index);
            if candidate.selected_filter != Some(index) {
                candidate.apply_filter_option(index)?;
            }
            candidate.keyboard_filter_focus = true;
            Ok(changed)
        })
    }
    pub fn selected_filter(&self) -> Option<usize> {
        self.selected_filter
    }

    pub(super) fn validate_filter(&self) -> Result<(), String> {
        let Some(filter) = &self.document().filter else {
            return Ok(());
        };
        let nodes: Vec<_> = self
            .document()
            .pages
            .iter()
            .flat_map(|p| &p.nodes)
            .collect();
        let node = nodes
            .iter()
            .find(|n| n.id == filter.node_id)
            .ok_or("filter node missing")?;
        if !node.visible
            || node.hit_id.as_ref() != Some(&node.id)
            || node.deep2d.is_none()
            || node.chart.is_some()
            || filter.options.is_empty()
            || filter.options.len()
                > if filter.presentation.is_some() {
                    256
                } else {
                    16
                }
            || [&filter.key, &filter.source_node_id]
                .iter()
                .any(|v| v.is_empty() || v.chars().count() > 256 || v.chars().any(char::is_control))
            || serde_json::to_vec(filter).map_err(|e| e.to_string())?.len() > 4 * 1024 * 1024
        {
            return Err("invalid frozen filter profile".into());
        }
        if let Some(select) = &filter.presentation
            && (select.kind != "select-v1" || select.row_height != 32.0 || select.visible_rows != 8)
        {
            return Err("unsupported select presentation profile".into());
        }
        let required_height = if filter.presentation.is_some() {
            32.0
        } else {
            18.0 * filter.options.len() as f64
        };
        if node.frame[2]
            <= if filter.presentation.is_some() {
                58.0
            } else {
                34.0
            }
            || node.frame[3] - 34.0 < required_height
        {
            return Err("filter option layout is too small".into());
        }
        if filter.presentation.is_some() {
            self.validate_select_package(node, filter.options.len())?;
        }
        let mut values = std::collections::HashSet::new();
        let mut previous_targets = None;
        let mut previous_static_targets = None;
        for option in &filter.options {
            if option.value.is_empty()
                || option.value.chars().count() > 256
                || !values.insert(&option.value)
                || (option.updates.is_empty()
                    && option.visibility.is_empty()
                    && self.document().tables.is_empty())
                || option.updates.len() > 32
                || option.visibility.len() > 128
            {
                return Err("invalid filter option".into());
            }
            let mut targets = std::collections::BTreeSet::new();
            let mut static_targets = std::collections::BTreeSet::new();
            for entry in &option.visibility {
                let target = nodes
                    .iter()
                    .find(|node| node.id == entry.node_id)
                    .ok_or("filter static target missing")?;
                if target.id == filter.node_id
                    || target.chart.is_some()
                    || target.chart_sim.is_some()
                    || target.deep2d.is_none()
                    || target.hit_id.is_some()
                    || !static_targets.insert(&entry.node_id)
                {
                    return Err("invalid filter static target".into());
                }
            }
            if previous_static_targets
                .as_ref()
                .is_some_and(|previous| previous != &static_targets)
            {
                return Err("filter static target set changed".into());
            }
            previous_static_targets = Some(static_targets);
            for update in &option.updates {
                let node = nodes
                    .iter()
                    .find(|n| n.id == update.node_id)
                    .ok_or("filter target missing")?;
                if node.chart_sim.is_some() || !targets.insert(&update.node_id) {
                    return Err("invalid filter target".into());
                }
                let mut chart = self
                    .charts
                    .get(&update.node_id)
                    .ok_or("filter target is not a chart")?
                    .clone();
                if update.datasets.len() != chart.source().datasets.len()
                    || update
                        .datasets
                        .iter()
                        .zip(&chart.source().datasets)
                        .any(|(a, b)| a.dataset_id != b.id)
                {
                    return Err("filter dataset identity mismatch".into());
                }
                apply(&mut chart, update)?;
            }
            if previous_targets.as_ref().is_some_and(|old| old != &targets) {
                return Err("filter target set changed".into());
            }
            previous_targets = Some(targets);
        }
        Ok(())
    }

    pub fn select_filter(&mut self, index: usize) -> Result<bool, String> {
        if self.selected_filter == Some(index) {
            return Ok(false);
        }
        self.transaction(|candidate| {
            candidate.apply_filter_option(index)?;
            Ok(true)
        })
    }

    pub(super) fn apply_filter_option(&mut self, index: usize) -> Result<(), String> {
        let option = self
            .loaded
            .document
            .filter
            .as_ref()
            .and_then(|f| f.options.get(index))
            .ok_or("filter option out of range")?;
        let text_targets: std::collections::HashSet<_> = self
            .input_profiles()
            .into_iter()
            .flat_map(|profile| {
                profile
                    .bindings
                    .iter()
                    .map(|binding| binding.node_id.clone())
            })
            .collect();
        for update in &option.updates {
            // Shared targets are applied once after intersecting all text values.
            if text_targets.contains(&update.node_id) {
                continue;
            }
            apply(
                self.charts
                    .get_mut(&update.node_id)
                    .ok_or("filter chart missing")?,
                update,
            )?;
        }
        self.selected_filter = Some(index);
        if !self.input_profiles().is_empty() {
            self.apply_input_value()?;
        }
        Ok(())
    }

    pub(super) fn filter_at(&self, point: [f64; 2]) -> Option<usize> {
        let filter = self.document().filter.as_ref()?;
        if filter.presentation.is_some() {
            return None;
        }
        if self.hit(point)?.node_id != filter.node_id {
            return None;
        }
        let node = self
            .document()
            .pages
            .iter()
            .find(|p| p.id == self.page_id)?
            .nodes
            .iter()
            .find(|n| n.id == filter.node_id && n.visible)?;
        let inset = 17.0;
        let x = point[0] - node.frame[0];
        let y = point[1] - node.frame[1] - inset;
        let height = ((node.frame[3] - inset * 2.0) / filter.options.len() as f64).floor();
        if height < 18.0 || x < inset || x >= node.frame[2] - inset || y < 0.0 {
            return None;
        }
        let index = (y / height) as usize;
        (index < filter.options.len()).then_some(index)
    }

    pub(super) fn filter_content(
        &self,
        node_id: &str,
        mut content: Deep2dRuntimeContent,
    ) -> Deep2dRuntimeContent {
        let Some(filter) = self
            .document()
            .filter
            .as_ref()
            .filter(|f| f.node_id == node_id)
        else {
            return content;
        };
        let list = match &mut content {
            Deep2dRuntimeContent::Package(package) => &mut package.display_list,
            Deep2dRuntimeContent::DisplayList(list) => list,
            _ => return content,
        };
        let prefix = format!("{}:option:", filter.source_node_id);
        let selected_color = list.commands.iter().find_map(|command| match command {
            crate::deep2d::Deep2dCommand::Path(path)
                if path.hit_id.as_deref() == Some(&format!("{prefix}0")) =>
            {
                path.fill
            }
            _ => None,
        });
        for command in &mut list.commands {
            if let crate::deep2d::Deep2dCommand::Path(path) = command
                && let Some(index) = path
                    .hit_id
                    .as_deref()
                    .and_then(|id| id.strip_prefix(&prefix))
                    .and_then(|id| id.parse::<usize>().ok())
            {
                path.fill = if self.selected_filter == Some(index) {
                    selected_color
                } else if self.hovered_filter == Some(index) {
                    selected_color.map(|mut color| {
                        color[3] *= 0.35;
                        color
                    })
                } else {
                    Some([0.0; 4])
                };
                if self.keyboard_filter_focus && self.selected_filter == Some(index) {
                    path.stroke = selected_color.map(|mut color| {
                        color[3] = 1.0;
                        color
                    });
                    path.stroke_width = Some(2.0);
                }
            }
        }
        content
    }
}

/// 单选与多选共用的行替换:以固定 dataset 标识整组覆盖并推进数据修订。
pub(super) fn apply(
    chart: &mut ChartRuntime,
    update: &crate::runtime_package::DashboardFilterUpdate,
) -> Result<(), String> {
    let revision = chart.data_revision();
    chart.apply_data_message(ChartDataMessage {
        schema: "deep-engine.chart-data-update".into(),
        schema_version: 1,
        chart_id: chart.source().id.clone(),
        expected_data_revision: revision,
        data_revision: revision.checked_add(1).ok_or("filter revision exhausted")?,
        datasets: update
            .datasets
            .iter()
            .map(|data| DatasetRowsUpdate::Replace {
                dataset_id: data.dataset_id.clone(),
                rows: data.rows.to_vec(),
            })
            .collect(),
    })?;
    Ok(())
}
