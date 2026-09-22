//! B5 多选过滤:在既有单选模型(`filter.rs`)旁并列一个多选集合模型。
//! 多选状态只存在于 `selected_options`,单选指针 `selected_filter` 不参与,
//! 保证旧包(`multiSelect` 缺省为 false)行为逐位不变。
use super::filter::apply;
use super::*;

impl DashboardRuntime {
    /// 只读访问当前多选已选集合(升序)。
    pub fn selected_options(&self) -> &std::collections::BTreeSet<usize> {
        &self.selected_options
    }

    /// 多选切换入口:已选→取消,未选→添加;每次变更后以所有已选项 updates 的
    /// 行交集重放过滤。事务保证失败不发布部分状态。
    /// 仅 `multiSelect` 冻结包允许;单选包必须继续走 `select_filter`,此处 fail-closed,
    /// 避免与 `selected_filter` 形成双事实源。
    pub fn toggle_filter_option(&mut self, index: usize) -> Result<bool, String> {
        self.transaction(|candidate| {
            candidate.validate_toggle(index)?;
            if !candidate.selected_options.remove(&index) {
                candidate.selected_options.insert(index);
            }
            candidate.apply_filter_options()?;
            Ok(true)
        })
    }

    /// 指针点击多选列表项的入口;悬停与键盘焦点沿用单选指针路径的既有事务语义,
    /// 切换本身复用 [`Self::toggle_filter_option`] 的校验与重放。
    pub(super) fn toggle_filter_pointer(
        &mut self,
        index: usize,
        hover: Option<usize>,
    ) -> Result<bool, String> {
        self.transaction(|candidate| {
            candidate.validate_toggle(index)?;
            if !candidate.selected_options.remove(&index) {
                candidate.selected_options.insert(index);
            }
            candidate.hovered_filter = hover;
            candidate.keyboard_filter_focus = false;
            candidate.apply_filter_options()?;
            // 切换必然改变已选集合,直接提交。
            Ok(true)
        })
    }

    fn validate_toggle(&self, index: usize) -> Result<(), String> {
        let filter = self.document().filter.as_ref().ok_or("filter missing")?;
        if !filter.multi_select {
            return Err("filter is not multi-select".into());
        }
        if filter.options.get(index).is_none() {
            return Err("filter option out of range".into());
        }
        Ok(())
    }

    /// 多选重放:目标行 = 所有已选项 updates 的交集;空选集 = 无约束,恢复包内原始行。
    /// 与单选路径一致:文本输入绑定的目标跳过,等 `apply_input_value` 统一求交集。
    pub(super) fn apply_filter_options(&mut self) -> Result<(), String> {
        let Some(filter) = self.loaded.document.filter.as_ref() else {
            return Err("filter missing".into());
        };
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
        let selected: Vec<usize> = self.selected_options.iter().copied().collect();
        // 校验已保证所有 option 的目标集合与数据集标识一致,以首个 option 为参照遍历目标。
        let reference = filter.options.first().ok_or("invalid frozen filter profile")?;
        let mut plans = Vec::new();
        for target in &reference.updates {
            if text_targets.contains(&target.node_id) {
                continue;
            }
            let datasets = if let Some(first) = selected.first() {
                let mut datasets = Vec::new();
                for dataset in &target.datasets {
                    // 以最小索引已选项的行序为基准,保留同时出现在其余已选项中的行,
                    // 使交集结果与切换顺序无关。
                    let mut base: Vec<Vec<serde_json::Value>> = filter
                        .options
                        .get(*first)
                        .ok_or("filter option out of range")?
                        .updates
                        .iter()
                        .find(|update| update.node_id == target.node_id)
                        .ok_or("filter target set changed")?
                        .datasets
                        .iter()
                        .find(|entry| entry.dataset_id == dataset.dataset_id)
                        .ok_or("filter dataset identity mismatch")?
                        .rows
                        .iter()
                        .cloned()
                        .collect();
                    for index in &selected[1..] {
                        let option =
                            filter.options.get(*index).ok_or("filter option out of range")?;
                        let rows = &option
                            .updates
                            .iter()
                            .find(|update| update.node_id == target.node_id)
                            .ok_or("filter target set changed")?
                            .datasets
                            .iter()
                            .find(|entry| entry.dataset_id == dataset.dataset_id)
                            .ok_or("filter dataset identity mismatch")?
                            .rows;
                        let candidates: std::collections::HashSet<&Vec<serde_json::Value>> =
                            rows.iter().collect();
                        base.retain(|row| candidates.contains(row));
                    }
                    datasets.push(crate::runtime_package::DashboardFilterDataset {
                        dataset_id: dataset.dataset_id.clone(),
                        rows: base.into_iter().collect(),
                    });
                }
                datasets
            } else {
                // 空选集:取消全部约束,恢复包内原始行。
                let node = self
                    .document()
                    .pages
                    .iter()
                    .flat_map(|page| &page.nodes)
                    .find(|node| node.id == target.node_id)
                    .ok_or("filter chart missing")?;
                let source = node
                    .chart
                    .as_ref()
                    .and_then(|id| self.loaded.charts.get(id))
                    .ok_or("filter chart resource missing")?;
                target
                    .datasets
                    .iter()
                    .map(|dataset| {
                        let rows = source
                            .datasets
                            .iter()
                            .find(|source| source.id == dataset.dataset_id)
                            .ok_or("filter dataset identity mismatch")?
                            .rows
                            .clone();
                        Ok(crate::runtime_package::DashboardFilterDataset {
                            dataset_id: dataset.dataset_id.clone(),
                            rows,
                        })
                    })
                    .collect::<Result<Vec<_>, String>>()?
            };
            plans.push(crate::runtime_package::DashboardFilterUpdate {
                node_id: target.node_id.clone(),
                datasets,
            });
        }
        for update in plans {
            apply(
                self.charts
                    .get_mut(&update.node_id)
                    .ok_or("filter chart missing")?,
                &update,
            )?;
        }
        if !self.input_profiles().is_empty() {
            self.apply_input_value()?;
        }
        Ok(())
    }
}
