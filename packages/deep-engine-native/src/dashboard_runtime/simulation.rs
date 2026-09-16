use super::*;
impl DashboardRuntime {
    fn active_simulations(&self) -> Vec<String> {
        self.document()
            .pages
            .iter()
            .find(|p| p.id == self.page_id)
            .into_iter()
            .flat_map(|page| &page.nodes)
            .filter(|n| n.visible && self.simulations.contains_key(&n.id))
            .map(|n| n.id.clone())
            .collect()
    }
    pub fn next_due_ms(&self) -> Result<Option<u64>, String> {
        self.active_simulations()
            .iter()
            .map(|id| self.simulations[id].next_due_ms())
            .try_fold(None, |earliest, due| {
                let due = due?;
                Ok(Some(earliest.map_or(due, |old: u64| old.min(due))))
            })
    }
    pub fn tick(&mut self, elapsed_ms: u64) -> Result<bool, String> {
        self.transaction(|candidate| {
            let mut changed = false;
            for id in candidate.active_simulations() {
                let chart = candidate
                    .charts
                    .get_mut(&id)
                    .ok_or("simulation chart node missing")?;
                let source = candidate
                    .simulations
                    .get_mut(&id)
                    .ok_or("simulation source missing")?;
                if let Some(frame) = source.prepare(elapsed_ms, chart.data_revision())? {
                    chart.apply_data_message(frame.message().clone())?;
                    source.commit(frame, chart.data_revision())?;
                    changed = true;
                }
            }
            Ok(changed)
        })
    }
}
