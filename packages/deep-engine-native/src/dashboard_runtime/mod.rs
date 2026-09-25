//! CPU dashboard candidates. Hosts publish this snapshot only after whole-frame presentation.
use crate::{
    chart::{ChartDataMessage, ChartRuntime, simulation::ChartSimulationSource},
    deep2d::Deep2dRuntimeContent,
    platform_text::TextRasterizer,
    runtime_package::{DashboardRuntimeV1, LoadedDashboard},
};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
mod compose;
mod filter;
mod filter_multi;
mod filter_select;
mod filter_select_paint;
#[cfg(test)]
mod filter_select_tests;
mod filter_select_typeahead;
mod filter_select_validation;
mod table;
#[cfg(test)]
mod table_tests;
pub use table::TableAction;
#[cfg(test)]
mod filter_multi_tests;
#[cfg(test)]
mod filter_tests;
mod focus;
mod hit;
mod input;
mod input_text;
mod input_text_filter;
mod input_text_group;
#[cfg(test)]
mod input_text_group_tests;
mod input_text_layout;
mod input_text_paint;
mod input_text_selection;
#[cfg(test)]
mod input_text_tests;
mod input_text_validation;
pub mod report_save;
mod simulation;
#[cfg(windows)]
mod video;
#[cfg(windows)]
pub use video::{
    DashboardVideoAdvance, DashboardVideoCommand, DashboardVideoFit, DashboardVideoPlacement,
    DashboardVideoPlayback, dashboard_video_drag_command, dashboard_video_key_command,
};
#[cfg(test)]
mod tests;
pub use hit::DashboardHit;

#[derive(Clone)]
pub struct DashboardRuntime {
    active_input: Option<String>,
    input_bank: BTreeMap<String, input_text_group::StoredInput>,
    focus_id: Option<String>,
    input_ui: input_text::InputState,
    input_fonts: Option<Arc<Mutex<crate::platform_text::FrozenTextRasterizer>>>,
    table_states: BTreeMap<String, table::TableState>,
    loaded: Arc<LoadedDashboard>,
    page_id: String,
    charts: BTreeMap<String, ChartRuntime>,
    simulations: BTreeMap<String, ChartSimulationSource>,
    legend_pages: BTreeMap<String, usize>,
    anchors: BTreeMap<String, [f64; 2]>,
    text: Arc<Mutex<TextRasterizer>>,
    content: Arc<Deep2dRuntimeContent>,
    prepare_cache: Arc<Mutex<crate::deep2d::Deep2dPathCache>>,
    hits: Vec<hit::HitLayer>,
    revision: u64,
    text_scale: f64,
    selected_filter: Option<usize>,
    /// 多选过滤的已选索引集合;单选包恒为空,不参与 `selected_filter` 单选指针语义。
    selected_options: std::collections::BTreeSet<usize>,
    hovered_filter: Option<usize>,
    keyboard_filter_focus: bool,
    select_ui: filter_select::SelectState,
}
impl DashboardRuntime {
    pub fn new(loaded: LoadedDashboard) -> Result<Self, String> {
        let mut atlas_bytes = 0usize;
        for content in loaded.deep2d.values() {
            let prepared = crate::deep2d::prepare_runtime_content(content)?;
            atlas_bytes = atlas_bytes
                .checked_add(prepared.summary.atlas_bytes)
                .ok_or("dashboard atlas budget overflow")?;
            if atlas_bytes > 64 * 1024 * 1024 {
                return Err("dashboard static atlas budget exceeded".into());
            }
        }
        let mut charts = BTreeMap::new();
        let mut simulations = BTreeMap::new();
        for page in &loaded.document.pages {
            for node in &page.nodes {
                if node
                    .deep2d
                    .as_ref()
                    .is_some_and(|id| !loaded.deep2d.contains_key(id))
                {
                    return Err("dashboard static resource missing".into());
                }
                if let Some(id) = &node.chart {
                    let source = loaded
                        .charts
                        .get(id)
                        .ok_or("dashboard chart resource missing")?;
                    let chart = ChartRuntime::new(source.clone(), node.frame[2], node.frame[3])?;
                    if let Some(id) = &node.chart_sim {
                        let fixture = loaded
                            .simulations
                            .get(id)
                            .ok_or("dashboard simulation missing")?;
                        simulations.insert(
                            node.id.clone(),
                            ChartSimulationSource::new(fixture.clone(), &chart)?,
                        );
                    }
                    if charts.insert(node.id.clone(), chart).is_some() {
                        return Err("duplicate dashboard chart node".into());
                    }
                }
            }
        }
        let page_id = loaded.document.entry_page_id.clone();
        let page = loaded
            .document
            .pages
            .iter()
            .find(|p| p.id == page_id)
            .ok_or("dashboard entry page missing")?;
        let initial = crate::deep2d::Deep2dComposite::new(
            loaded.document.id.clone(),
            1,
            [page.width, page.height],
            Vec::new(),
        )?;
        let mut runtime = Self {
            active_input: None,
            input_bank: BTreeMap::new(),
            focus_id: None,
            input_ui: input_text::InputState::default(),
            input_fonts: None,
            table_states: BTreeMap::new(),
            prepare_cache: Arc::new(Mutex::new(
                crate::deep2d::Deep2dPathCache::with_package_cache(),
            )),
            loaded: Arc::new(loaded),
            page_id,
            charts,
            simulations,
            legend_pages: BTreeMap::new(),
            anchors: BTreeMap::new(),
            text: Arc::new(Mutex::new(crate::platform_text::runtime_text_rasterizer()?)),
            content: Arc::new(Deep2dRuntimeContent::Composite(initial)),
            hits: Vec::new(),
            revision: 1,
            text_scale: 1.0,
            selected_filter: None,
            selected_options: std::collections::BTreeSet::new(),
            hovered_filter: None,
            keyboard_filter_focus: false,
            select_ui: filter_select::SelectState::default(),
        };
        runtime.validate_filter()?;
        runtime.initialize_input()?;
        if runtime.document().filter.is_some() {
            // 多选包初始为空选集(无约束,保留包内原始行);单选包维持默认选中第一项。
            if !runtime
                .document()
                .filter
                .as_ref()
                .is_some_and(|filter| filter.multi_select)
            {
                runtime.apply_filter_option(0)?;
            }
        }
        runtime.rebuild()?;
        Ok(runtime)
    }
    pub fn content(&self) -> &Deep2dRuntimeContent {
        &self.content
    }
    pub fn set_text_scale(&mut self, scale: f64) -> Result<bool, String> {
        if !scale.is_finite() || scale <= 0.0 || !(scale as f32).is_finite() {
            return Err("dashboard text scale must be finite and positive".into());
        }
        if scale == self.text_scale {
            return Ok(false);
        }
        self.transaction(|candidate| {
            candidate.text_scale = scale;
            Ok(true)
        })
    }
    pub fn text_scale(&self) -> f64 {
        self.text_scale
    }
    pub fn document(&self) -> &DashboardRuntimeV1 {
        &self.loaded.document
    }
    pub fn video_diagnostics(&self) -> &[crate::runtime_package::DashboardVideoDiagnostic] {
        &self.loaded.document.videos
    }
    pub fn active_page_id(&self) -> &str {
        &self.page_id
    }
    pub fn chart(&self, node_id: &str) -> Option<&ChartRuntime> {
        self.charts.get(node_id)
    }
    pub fn switch_page(&mut self, id: &str) -> Result<bool, String> {
        if id == self.page_id {
            return Ok(false);
        }
        if !self.document().pages.iter().any(|p| p.id == id) {
            return Err("dashboard page missing".into());
        }
        self.transaction(|candidate| {
            candidate.page_id = id.into();
            candidate.focus_id = None;
            candidate.select_ui = filter_select::SelectState::default();
            candidate.input_ui.focused = false;
            candidate.input_ui.preedit.clear();
            candidate.input_ui.ime = crate::platform_text::WinitImeAdapter::new();
            candidate.anchors.clear();
            candidate.legend_pages.clear();
            for chart in candidate.charts.values_mut() {
                chart.dispatch(crate::chart::ChartAction::HoverEnd)?;
            }
            Ok(true)
        })
    }
    pub fn apply_data(&mut self, node_id: &str, message: ChartDataMessage) -> Result<bool, String> {
        self.transaction(|candidate| {
            candidate
                .charts
                .get_mut(node_id)
                .ok_or("dashboard chart node missing")?
                .apply_data_message(message)?;
            Ok(true)
        })
    }
    fn transaction(
        &mut self,
        action: impl FnOnce(&mut Self) -> Result<bool, String>,
    ) -> Result<bool, String> {
        let mut candidate = self.clone();
        if !action(&mut candidate)? {
            return Ok(false);
        }
        candidate.revision = candidate
            .revision
            .checked_add(1)
            .filter(|v| *v <= 9_007_199_254_740_991)
            .ok_or("dashboard revision exhausted")?;
        candidate.rebuild()?;
        *self = candidate;
        Ok(true)
    }
}
