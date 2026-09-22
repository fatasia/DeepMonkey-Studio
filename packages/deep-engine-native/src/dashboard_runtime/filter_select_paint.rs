use super::*;
use crate::{
    deep2d::*,
    native_ui::{ControlCanvas, ControlPalette},
};

impl DashboardRuntime {
    pub(super) fn select_content(
        &self,
        content: &Deep2dRuntimeContent,
        popup: bool,
    ) -> Deep2dRuntimeContent {
        let Deep2dRuntimeContent::Package(source) = content else {
            return content.clone();
        };
        let Some((header, panel, rows)) = self.select_geometry() else {
            return content.clone();
        };
        let node = self.select_node().unwrap();
        let first = if popup {
            self.select_ui.first
        } else {
            self.selected_filter.unwrap_or(0)
        };
        let count = if popup { rows } else { 1 };
        let mut package = glyph_package(source, |quad| {
            quad.z_order > 0 && (first..first + count).contains(&((quad.z_order - 1) as usize))
        });
        let mut palette = ControlPalette::dark();
        if let Some(surface) =
            package
                .display_list
                .commands
                .iter()
                .find_map(|command| match command {
                    Deep2dCommand::Path(path) if path.hit_id.is_none() => path.fill,
                    _ => None,
                })
        {
            palette.surface = surface;
            palette.surface[3] = 1.0;
        }
        let mut canvas = ControlCanvas::new();
        for quad in &mut package.quads {
            let index = (quad.z_order - 1) as usize;
            if popup {
                quad.destination[0] -= 17.0;
                quad.destination[1] += (index - first) as f64 * 32.0 - 17.0;
            }
            quad.z_order = 100;
        }
        // 不把未显示选项的纹理复制进每一帧合成。
        let used: std::collections::HashSet<_> =
            package.quads.iter().map(|q| q.atlas_id.clone()).collect();
        package.atlases.retain(|atlas| used.contains(&atlas.id));
        let (width, height) = if popup {
            package.id.push_str(".popup");
            package.display_list.commands.clear();
            package.display_list.resources.clear();
            canvas.fill_rect(
                "select-panel",
                [0.0, 0.0, panel[2], panel[3]],
                palette.surface,
                2.0,
                1.0,
            );
            if (first..first + rows).contains(&self.select_ui.highlighted) {
                canvas.fill_rect(
                    "select-highlight",
                    [
                        0.0,
                        (self.select_ui.highlighted - first) as f64 * 32.0,
                        panel[2],
                        32.0,
                    ],
                    palette.accent,
                    0.0,
                    0.25,
                );
            }
            let total = self.document().filter.as_ref().unwrap().options.len();
            if total > rows {
                let thumb_height = (panel[3] * rows as f64 / total as f64).max(12.0);
                let top = (panel[3] - thumb_height) * first as f64 / (total - rows) as f64;
                canvas.fill_rect(
                    "select-scroll",
                    [panel[2] - 5.0, top, 3.0, thumb_height],
                    palette.line,
                    1.0,
                    1.0,
                );
            }
            (panel[2], panel[3])
        } else {
            let rect = [17.0, 17.0, header[2], 32.0];
            canvas.fill_rect("select-value", rect, palette.surface, 3.0, 1.0);
            let x = 17.0 + header[2] - 15.0;
            canvas.stroke_polyline(
                "select-chevron",
                &[[x - 4.0, 30.0], [x, 35.0], [x + 4.0, 30.0]],
                palette.line,
                2.0,
                1.0,
            );
            if self.select_ui.focused {
                for (index, edge) in [
                    [14.0, 14.0, header[2] + 6.0, 1.0],
                    [14.0, 51.0, header[2] + 6.0, 1.0],
                    [14.0, 15.0, 1.0, 36.0],
                    [header[2] + 19.0, 15.0, 1.0, 36.0],
                ]
                .into_iter()
                .enumerate()
                {
                    canvas.fill_rect(
                        &format!("select-focus-{index}"),
                        edge,
                        palette.focus_ring,
                        0.0,
                        1.0,
                    );
                }
            }
            (node.frame[2], node.frame[3])
        };
        let mut chrome = canvas.into_display_list(width, height);
        for command in &mut chrome.commands {
            if let Deep2dCommand::Path(path) = command {
                path.z_order += 1;
            }
        }
        package.display_list.commands.extend(chrome.commands);
        package.display_list.resources.extend(chrome.resources);
        package.display_list.logical_width = width;
        package.display_list.logical_height = height;
        // revision也纳入内容缓存身份，避免选项切换复用旧GPU绘制。
        package.revision = self.revision;
        package.display_list.revision = self.revision;
        Deep2dRuntimeContent::Package(package)
    }

    pub(super) fn select_popup_layer(&self, clip: Deep2dRect) -> Option<Deep2dLayer> {
        if !self.select_ui.open {
            return None;
        }
        let node = self.select_node()?;
        let (_, panel, _) = self.select_geometry()?;
        let content = self.loaded.deep2d.get(node.deep2d.as_ref()?)?;
        Some(Deep2dLayer {
            id: format!("{}:select-popup", node.id),
            content: Arc::new(self.select_content(content, true)),
            translation: [panel[0], panel[1]],
            clip,
        })
    }

    pub(super) fn select_tooltip_layer(&self, clip: Deep2dRect) -> Option<Deep2dLayer> {
        let index = self.select_ui.hovered?;
        let node = self.select_node()?;
        let Deep2dRuntimeContent::Package(source) =
            self.loaded.deep2d.get(node.deep2d.as_ref()?)?
        else {
            return None;
        };
        let mut package = glyph_package(source, |quad| quad.z_order == 1001 + index as i32);
        if package.quads.is_empty() {
            return None;
        }
        let (header, panel, rows) = self.select_geometry()?;
        let width = package
            .quads
            .iter()
            .map(|quad| quad.destination[2])
            .fold(0.0, f64::max)
            + 8.0;
        let height = package
            .quads
            .iter()
            .map(|quad| quad.destination[3])
            .fold(0.0, f64::max)
            + 8.0;
        let top = if self.select_ui.open
            && (self.select_ui.first..self.select_ui.first + rows).contains(&index)
        {
            panel[1] + (index - self.select_ui.first) as f64 * 32.0
        } else {
            header[1]
        };
        let y = if top + 32.0 + height <= clip.height {
            top + 32.0
        } else {
            (top - height).max(0.0)
        };
        for quad in &mut package.quads {
            quad.destination[0] = 4.0;
            quad.destination[1] = 4.0;
            quad.z_order = 100;
        }
        let used: std::collections::HashSet<_> =
            package.quads.iter().map(|q| q.atlas_id.clone()).collect();
        package.atlases.retain(|atlas| used.contains(&atlas.id));
        let palette = ControlPalette::dark();
        let mut canvas = ControlCanvas::new();
        canvas.fill_rect(
            "select-tooltip",
            [0.0, 0.0, width, height],
            palette.surface,
            2.0,
            1.0,
        );
        package.display_list = canvas.into_display_list(width, height);
        package.id.push_str(".tooltip");
        package.display_list.id = package.id.clone();
        package.revision = self.revision;
        package.display_list.revision = self.revision;
        Some(Deep2dLayer {
            id: format!("{}:select-tooltip", node.id),
            content: Arc::new(Deep2dRuntimeContent::Package(package)),
            translation: [header[0].min((clip.width - width).max(0.0)), y],
            clip,
        })
    }
}

// 只克隆可见字形纹理；不能先克隆整个256项字形池再retain。
fn glyph_package(
    source: &Deep2dRuntimePackage,
    keep: impl Fn(&Deep2dAtlasQuad) -> bool,
) -> Deep2dRuntimePackage {
    let quads: Vec<_> = source
        .quads
        .iter()
        .filter(|quad| keep(quad))
        .cloned()
        .collect();
    let used: std::collections::HashSet<_> = quads.iter().map(|quad| &quad.atlas_id).collect();
    let atlases = source
        .atlases
        .iter()
        .filter(|atlas| used.contains(&atlas.id))
        .cloned()
        .collect();
    Deep2dRuntimePackage {
        schema: source.schema.clone(),
        schema_version: source.schema_version,
        id: source.id.clone(),
        revision: source.revision,
        composition: source.composition,
        display_list: source.display_list.clone(),
        atlases,
        quads,
    }
}
