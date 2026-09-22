use super::*;
use unicode_segmentation::UnicodeSegmentation;
impl DashboardRuntime {
    pub(super) fn apply_input_value(&mut self) -> Result<(), String> {
        let input = self.input_profile().ok_or("input profile absent")?;
        let value = &self.input_ui.editor.document;
        if value.chars().any(char::is_control)
            || value.graphemes(true).count() > input.max_graphemes
        {
            return Err("single-line input exceeds the 256 grapheme budget".into());
        }
        let profiles: Vec<_> = self
            .input_profiles()
            .into_iter()
            .map(|profile| {
                (
                    profile.clone(),
                    self.input_value_for(&profile.node_id)
                        .unwrap_or("")
                        .to_owned(),
                )
            })
            .collect();
        let mut targets = BTreeMap::new();
        for (profile, _) in &profiles {
            for binding in &profile.bindings {
                targets
                    .entry(binding.node_id.clone())
                    .or_insert_with(|| binding.clone());
            }
        }
        for (id, binding) in targets {
            // Derive from the immutable select variant, preserving raw-row aggregation.
            let baseline = self
                .document()
                .filter
                .as_ref()
                .and_then(|filter| {
                    self.selected_filter
                        .and_then(|index| filter.options.get(index))
                })
                .and_then(|option| option.updates.iter().find(|update| update.node_id == id))
                .and_then(|update| {
                    update
                        .datasets
                        .iter()
                        .find(|dataset| dataset.dataset_id == binding.dataset_id)
                })
                .map(|dataset| &dataset.rows)
                .unwrap_or(&binding.rows);
            let rows: Vec<_> = baseline
                .iter()
                .filter(|row| {
                    let category = row.first().and_then(|v| v.as_str()).unwrap_or("");
                    profiles
                        .iter()
                        .filter(|(profile, _)| {
                            profile.bindings.iter().any(|binding| binding.node_id == id)
                        })
                        .all(|(profile, value)| {
                            let needle = value.to_ascii_lowercase();
                            needle.is_empty()
                                || needle == "all"
                                || needle == "全部"
                                || if profile.r#match == "exact" {
                                    category == value
                                } else {
                                    category.to_ascii_lowercase().contains(&needle)
                                }
                        })
                })
                .cloned()
                .collect();
            let chart = self.charts.get_mut(&id).ok_or("input chart absent")?;
            if chart.source().datasets[0].rows.as_slice() == rows.as_slice() {
                continue;
            }
            let revision = chart.data_revision();
            chart.apply_data_message(ChartDataMessage {
                schema: "deep-engine.chart-data-update".into(),
                schema_version: 1,
                chart_id: chart.source().id.clone(),
                expected_data_revision: revision,
                data_revision: revision.checked_add(1).ok_or("input revision exhausted")?,
                datasets: vec![crate::chart::DatasetRowsUpdate::Replace {
                    dataset_id: binding.dataset_id,
                    rows,
                }],
            })?;
        }
        Ok(())
    }
}
