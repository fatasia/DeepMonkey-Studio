use super::*;

#[derive(Clone)]
pub(super) struct FocusEntry {
    pub id: String,
    pub rect: [f64; 4],
    pub table: Option<TableAction>,
}
impl DashboardRuntime {
    pub(super) fn focus_entries(&self) -> Vec<FocusEntry> {
        let mut entries = Vec::new();
        let Some(page) = self.document().pages.iter().find(|p| p.id == self.page_id) else {
            return entries;
        };
        for node in page.nodes.iter().filter(|node| node.visible) {
            let start = entries.len();
            if self
                .input_profiles()
                .iter()
                .any(|input| input.node_id == node.id)
                || self
                    .select_node()
                    .is_some_and(|select| select.id == node.id)
            {
                entries.push(FocusEntry {
                    id: node.id.clone(),
                    rect: [
                        node.frame[0] + 17.0,
                        node.frame[1] + 17.0,
                        node.frame[2] - 34.0,
                        32.0,
                    ],
                    table: None,
                });
            }
            for table in self
                .document()
                .tables
                .iter()
                .filter(|t| t.page_id == page.id && t.node_ids.first() == Some(&node.id))
            {
                if let Some(view) = self.table_view(table) {
                    for control in view.controls.iter().filter(|c| c.enabled) {
                        let [x, y, w, h] = control.rect;
                        entries.push(FocusEntry {
                            id: format!(
                                "table:{}:{}:{}",
                                table.id,
                                control.action,
                                control.column.as_deref().unwrap_or("")
                            ),
                            rect: [node.frame[0] + x, node.frame[1] + y, w, h],
                            table: Some(TableAction {
                                table_id: table.id.clone(),
                                action: control.action.clone(),
                                column: control.column.clone(),
                            }),
                        });
                    }
                }
            }
            clip_entries(&mut entries[start..], node, page.width, page.height);
        }
        entries.retain(|entry| entry.rect[2] > 0.0 && entry.rect[3] > 0.0);
        entries
    }
    pub fn has_focus_controls(&self) -> bool {
        !self.focus_entries().is_empty()
    }
    pub fn focused_control(&self) -> Option<String> {
        if self.input_focused() {
            return self.input_node().map(|n| n.id.clone());
        }
        if self.select_focused() {
            return self.select_node().map(|n| n.id.clone());
        }
        self.focus_id
            .clone()
            .filter(|id| self.focus_entries().iter().any(|entry| &entry.id == id))
    }
    pub fn focus_step(&mut self, reverse: bool) -> Result<bool, String> {
        let entries = self.focus_entries();
        if entries.is_empty() {
            return Ok(false);
        }
        let current = self
            .focused_control()
            .and_then(|id| entries.iter().position(|e| e.id == id));
        let next = match (current, reverse) {
            (None, false) => Some(0),
            (None, true) => Some(entries.len() - 1),
            (Some(0), true) => None,
            (Some(index), true) => Some(index - 1),
            (Some(index), false) if index + 1 < entries.len() => Some(index + 1),
            _ => None,
        };
        let id = next.map(|index| entries[index].id.clone());
        self.focus_control(id)
    }
    fn focus_control(&mut self, id: Option<String>) -> Result<bool, String> {
        self.transaction(|candidate| {
            if let Some(id) = &id
                && candidate
                    .input_profiles()
                    .iter()
                    .any(|profile| &profile.node_id == id)
            {
                candidate.activate_input(id)?;
            }
            candidate.input_ui.ime = crate::platform_text::WinitImeAdapter::new();
            candidate.input_ui.preedit.clear();
            candidate.input_ui.focused = id
                .as_ref()
                .is_some_and(|id| candidate.input_node().is_some_and(|n| &n.id == id));
            candidate.select_ui.focused = id
                .as_ref()
                .is_some_and(|id| candidate.select_node().is_some_and(|n| &n.id == id));
            candidate.select_ui.open = false;
            candidate.select_ui.hovered = None;
            candidate.select_ui.clear_typeahead();
            candidate.focus_id = id;
            Ok(true)
        })
    }
    pub fn focus_at(&mut self, point: Option<[f64; 2]>) -> Result<bool, String> {
        let id = point.and_then(|p| {
            self.focus_entries()
                .into_iter()
                .rev()
                .find(|e| {
                    let [x, y, w, h] = e.rect;
                    p[0] >= x && p[0] < x + w && p[1] >= y && p[1] < y + h
                })
                .map(|e| e.id)
        });
        self.focus_control(id)
    }
    pub fn focused_table_action(&self) -> Option<TableAction> {
        let id = self.focused_control()?;
        self.focus_entries()
            .into_iter()
            .find(|entry| entry.id == id)?
            .table
    }
    pub fn blur_controls(&mut self) -> Result<bool, String> {
        self.focus_control(None)
    }
    pub fn clear_table_focus(&mut self) -> Result<bool, String> {
        if self.focus_id.is_none() {
            return Ok(false);
        }
        self.transaction(|candidate| {
            candidate.focus_id = None;
            Ok(true)
        })
    }
    pub(super) fn focus_layer(
        &self,
        clip: crate::deep2d::Deep2dRect,
    ) -> Option<crate::deep2d::Deep2dLayer> {
        let id = self.focused_control()?;
        let entry = self
            .focus_entries()
            .into_iter()
            .find(|entry| entry.id == id)?;
        entry.table.as_ref()?;
        let [x, y, w, h] = entry.rect;
        let mut canvas = crate::native_ui::ControlCanvas::new();
        let color = crate::native_ui::ControlPalette::dark().focus_ring;
        for (index, rect) in [
            [x, y, w, 1.0],
            [x, y + h - 1.0, w, 1.0],
            [x, y, 1.0, h],
            [x + w - 1.0, y, 1.0, h],
        ]
        .into_iter()
        .enumerate()
        {
            canvas.fill_rect(&format!("control-focus-{index}"), rect, color, 0.0, 1.0);
        }
        let mut list = canvas.into_display_list(clip.width, clip.height);
        list.id = "dashboard-control-focus".into();
        list.revision = self.revision;
        Some(crate::deep2d::Deep2dLayer {
            id: "dashboard-control-focus".into(),
            content: Arc::new(crate::deep2d::Deep2dRuntimeContent::DisplayList(list)),
            translation: [0.0, 0.0],
            clip,
        })
    }
}

fn clip_entries(
    entries: &mut [FocusEntry],
    node: &crate::runtime_package::DashboardNode,
    width: f64,
    height: f64,
) {
    let clip = node
        .clip
        .map(|[x, y, w, h]| [node.frame[0] + x, node.frame[1] + y, w, h])
        .unwrap_or([0.0, 0.0, width, height]);
    for entry in entries {
        let [x, y, w, h] = entry.rect;
        let left = x.max(clip[0]).max(0.0);
        let top = y.max(clip[1]).max(0.0);
        let right = (x + w).min(clip[0] + clip[2]).min(width);
        let bottom = (y + h).min(clip[1] + clip[3]).min(height);
        entry.rect = [left, top, (right - left).max(0.0), (bottom - top).max(0.0)];
    }
}
