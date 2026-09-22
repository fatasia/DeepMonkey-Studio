use super::*;
use crate::platform_text::{FrozenFontInput, TextRasterizer};
impl DashboardRuntime {
    pub(super) fn initialize_active_input(&mut self) -> Result<(), String> {
        let Some(input) = self.input_profile().cloned() else {
            return Ok(());
        };
        let node = self
            .document()
            .pages
            .iter()
            .flat_map(|p| &p.nodes)
            .find(|n| n.id == input.node_id)
            .ok_or("input node missing")?;
        if input.kind != "text-v1"
            || input.max_graphemes != 256
            || !["contains", "exact"].contains(&input.r#match.as_str())
            || !["zh-CN", "en-US"].contains(&input.locale.as_str())
            || self
                .document()
                .filter
                .as_ref()
                .is_some_and(|filter| filter.key == input.key || filter.node_id == input.node_id)
            || input.key.is_empty()
            || input.key.len() > 256
            || input.key.chars().any(char::is_control)
            || !node.visible
            || node.hit_id.as_ref() != Some(&node.id)
            || node.deep2d.is_none()
            || node.chart.is_some()
            || node.frame[2] < 96.0
            || node.frame[2] > 2048.0
            || node.frame[3] < 66.0
            || input.fonts.is_empty()
            || input.fonts.len() > 8
            || input.bindings.is_empty()
            || input.bindings.len() > 32
            || !(1.0..=32.0).contains(&input.style.font_size)
            || !(input.style.font_size..=32.0).contains(&input.style.line_height)
            || !(1..=1000).contains(&input.style.font_weight)
        {
            return Err("unsupported text input profile".into());
        }
        let mut targets = std::collections::HashSet::new();
        if serde_json::to_vec(&input.bindings)
            .map_err(|e| e.to_string())?
            .len()
            > 4 * 1024 * 1024
        {
            return Err("input bindings exceed budget".into());
        }
        for binding in &input.bindings {
            let chart = self
                .charts
                .get(&binding.node_id)
                .ok_or("input chart missing")?;
            if !targets.insert(&binding.node_id)
                || self.simulations.contains_key(&binding.node_id)
                || chart.source().datasets.len() != 1
                || chart.source().datasets[0].id != binding.dataset_id
                || chart.source().datasets[0].rows != binding.rows
                || binding.rows.len() > 10000
                || binding.rows.iter().any(|row| {
                    row.first().and_then(|v| v.as_str()).is_none_or(|v| {
                        v.chars().any(|c| {
                            !c.is_ascii()
                                && c.to_lowercase().to_string() != c.to_uppercase().to_string()
                        })
                    })
                })
            {
                return Err(
                    "input binding must preserve exact frozen chart rows and supported casing"
                        .into(),
                );
            }
        }
        let mut bytes = 0usize;
        let fonts = input
            .fonts
            .iter()
            .map(|font| {
                let count = crate::deep2d::runtime_base64::decoded_len(&font.data_base64)
                    .map_err(str::to_owned)?;
                bytes = bytes.checked_add(count).ok_or("font budget overflow")?;
                if bytes > 32 * 1024 * 1024 {
                    return Err("input fonts exceed 32 MiB".into());
                }
                Ok(FrozenFontInput {
                    bytes: crate::deep2d::runtime_base64::decode(&font.data_base64)
                        .map_err(str::to_owned)?,
                    sha256: font.sha256.clone(),
                    face_index: font.face_index,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        self.input_fonts = Some(Arc::new(Mutex::new(TextRasterizer::from_frozen_fonts(
            &input.locale,
            fonts,
        )?)));
        Ok(())
    }
}
