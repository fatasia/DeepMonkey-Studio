use super::*;
use crate::runtime_package::DashboardNode;

#[derive(Clone, Default)]
pub(super) struct SelectState {
    pub open: bool,
    pub focused: bool,
    pub highlighted: usize,
    pub first: usize,
    pub hovered: Option<usize>,
    pub typeahead: String,
    pub typeahead_deadline: Option<std::time::Instant>,
}

impl SelectState {
    pub(super) fn clear_typeahead(&mut self) {
        self.typeahead.clear();
        self.typeahead_deadline = None;
    }
}

impl DashboardRuntime {
    pub fn select_owns_pointer(&self, point: Option<[f64; 2]>) -> bool {
        self.select_ui.open
            || self
                .select_geometry()
                .is_some_and(|(header, _, _)| point.is_some_and(|p| contains(header, p)))
    }
    pub fn select_focused(&self) -> bool {
        self.select_ui.focused && self.select_node().is_some()
    }
    pub fn select_accepts_key(&self, key: &str) -> bool {
        self.select_geometry().is_some()
            && (key == "Tab"
                || (self.select_ui.focused
                    && matches!(
                        key,
                        "ArrowDown" | "ArrowUp" | "Home" | "End" | "Enter" | "Space"
                    )
                    || (key == "Escape" && self.select_ui.open)))
    }
    pub(super) fn select_node(&self) -> Option<&DashboardNode> {
        let filter = self.document().filter.as_ref()?;
        filter.presentation.as_ref()?;
        self.document()
            .pages
            .iter()
            .find(|p| p.id == self.page_id)?
            .nodes
            .iter()
            .find(|node| node.id == filter.node_id && node.visible)
    }
    pub(super) fn select_geometry(&self) -> Option<([f64; 4], [f64; 4], usize)> {
        let node = self.select_node()?;
        let page = self
            .document()
            .pages
            .iter()
            .find(|p| p.id == self.page_id)?;
        let header = [
            node.frame[0] + 17.0,
            node.frame[1] + 17.0,
            node.frame[2] - 34.0,
            32.0,
        ];
        let count = self.document().filter.as_ref()?.options.len();
        let below = (page.height - header[1] - header[3]).max(0.0);
        let above = header[1].max(0.0);
        let upwards = below < 32.0 * count.min(8) as f64 && above > below;
        let available = if upwards { above } else { below };
        let rows = ((available / 32.0).floor() as usize).min(8).min(count);
        if rows == 0 {
            return None;
        }
        let height = 32.0 * rows as f64;
        let panel_width = header[2].min(page.width);
        let panel = [
            header[0].clamp(0.0, page.width - panel_width),
            if upwards {
                header[1] - height
            } else {
                header[1] + 32.0
            },
            panel_width,
            height,
        ];
        Some((header, panel, rows))
    }
    pub(super) fn reveal_select_highlight(&mut self) {
        let rows = self.select_geometry().map_or(1, |(_, _, rows)| rows);
        let count = self
            .document()
            .filter
            .as_ref()
            .map_or(0, |f| f.options.len());
        self.select_ui.highlighted = self.select_ui.highlighted.min(count.saturating_sub(1));
        if self.select_ui.highlighted < self.select_ui.first {
            self.select_ui.first = self.select_ui.highlighted;
        }
        if self.select_ui.highlighted >= self.select_ui.first + rows {
            self.select_ui.first = self.select_ui.highlighted + 1 - rows;
        }
        self.select_ui.first = self.select_ui.first.min(count.saturating_sub(rows));
    }
    pub(super) fn open_select(&mut self) {
        self.select_ui.open = true;
        self.select_ui.focused = true;
        self.select_ui.highlighted = self.selected_filter.unwrap_or(0);
        self.select_ui.clear_typeahead();
        self.reveal_select_highlight();
    }
    pub fn blur_select(&mut self) -> Result<bool, String> {
        if !self.select_ui.open && !self.select_ui.focused && self.select_ui.hovered.is_none() {
            return Ok(false);
        }
        self.transaction(|candidate| {
            candidate.select_ui.open = false;
            candidate.select_ui.focused = false;
            candidate.select_ui.hovered = None;
            candidate.select_ui.clear_typeahead();
            Ok(true)
        })
    }
    /// Some 表示控件消费按键；Esc 先关闭弹层，不传递给窗口关闭逻辑。
    pub fn select_key(&mut self, key: &str) -> Result<Option<bool>, String> {
        if !self.select_accepts_key(key) {
            return Ok(None);
        }
        self.transaction(|candidate| {
            candidate.select_ui.hovered = None;
            let count = candidate.document().filter.as_ref().unwrap().options.len();
            match key {
                "Tab" => {
                    candidate.select_ui.focused = !candidate.select_ui.focused;
                    candidate.select_ui.open = false;
                    candidate.select_ui.clear_typeahead();
                }
                "Escape" => {
                    candidate.select_ui.open = false;
                    candidate.select_ui.clear_typeahead();
                }
                "Enter" | "Space" if candidate.select_ui.open => {
                    candidate.apply_filter_option(candidate.select_ui.highlighted)?;
                    candidate.select_ui.open = false;
                    candidate.select_ui.clear_typeahead();
                }
                "Enter" | "Space" => candidate.open_select(),
                _ => {
                    if !candidate.select_ui.open {
                        candidate.open_select();
                    }
                    candidate.select_ui.highlighted = match key {
                        "Home" => 0,
                        "End" => count - 1,
                        "ArrowUp" => candidate.select_ui.highlighted.saturating_sub(1),
                        _ => (candidate.select_ui.highlighted + 1).min(count - 1),
                    };
                    candidate.select_ui.clear_typeahead();
                    candidate.reveal_select_highlight();
                }
            }
            Ok(true)
        })
        .map(Some)
    }
    pub(super) fn select_pointer(
        &mut self,
        point: Option<[f64; 2]>,
        press: bool,
    ) -> Result<Option<bool>, String> {
        let Some((header, panel, rows)) = self.select_geometry() else {
            return Ok(None);
        };
        let in_header = point.is_some_and(|p| contains(header, p));
        let in_panel = self.select_ui.open && point.is_some_and(|p| contains(panel, p));
        if !in_header && !in_panel && !(press && (self.select_ui.open || self.select_ui.focused)) {
            if self.select_ui.hovered.is_some() {
                return self
                    .transaction(|candidate| {
                        candidate.select_ui.hovered = None;
                        Ok(true)
                    })
                    .map(Some);
            }
            return Ok(None);
        }
        let index = point
            .map(|p| self.select_ui.first + ((p[1] - panel[1]) / 32.0).floor().max(0.0) as usize);
        let hovered = if in_panel {
            index
        } else if in_header {
            self.selected_filter
        } else {
            None
        };
        if !press && hovered == self.select_ui.hovered {
            return Ok(Some(false));
        }
        self.transaction(|candidate| {
            candidate.select_ui.hovered = if press { None } else { hovered };
            if in_panel {
                candidate.select_ui.highlighted =
                    index.unwrap().min(candidate.select_ui.first + rows - 1);
                if press {
                    candidate.apply_filter_option(candidate.select_ui.highlighted)?;
                    candidate.select_ui.open = false;
                    candidate.select_ui.clear_typeahead();
                }
            } else if in_header && press {
                if candidate.select_ui.open {
                    candidate.select_ui.open = false;
                    candidate.select_ui.clear_typeahead();
                } else {
                    candidate.open_select();
                }
            } else if press {
                candidate.select_ui.open = false;
                candidate.select_ui.focused = false;
                candidate.select_ui.clear_typeahead();
            }
            Ok(true)
        })
        .map(Some)
    }
    pub(super) fn select_scroll(
        &mut self,
        point: [f64; 2],
        delta: f64,
    ) -> Result<Option<bool>, String> {
        let Some((_, panel, rows)) = self.select_geometry() else {
            return Ok(None);
        };
        if !self.select_ui.open || !contains(panel, point) {
            return Ok(None);
        }
        if !delta.is_finite() || delta == 0.0 {
            return Ok(Some(false));
        }
        let count = self.document().filter.as_ref().unwrap().options.len();
        let next = if delta > 0.0 {
            self.select_ui.first.saturating_sub(1)
        } else {
            (self.select_ui.first + 1).min(count - rows)
        };
        if next == self.select_ui.first {
            return Ok(Some(false));
        }
        self.transaction(|candidate| {
            candidate.select_ui.first = next;
            candidate.select_ui.highlighted =
                candidate.select_ui.highlighted.clamp(next, next + rows - 1);
            candidate.select_ui.hovered = None;
            Ok(true)
        })
        .map(Some)
    }
}

fn contains([x, y, w, h]: [f64; 4], point: [f64; 2]) -> bool {
    point[0] >= x && point[0] < x + w && point[1] >= y && point[1] < y + h
}
