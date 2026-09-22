use super::*;
pub(super) type StoredInput = (
    input_text::InputState,
    Option<Arc<Mutex<crate::platform_text::FrozenTextRasterizer>>>,
);
impl DashboardRuntime {
    pub(super) fn input_profiles(&self) -> Vec<&crate::runtime_package::DashboardTextInput> {
        self.document()
            .text_input
            .iter()
            .chain(self.document().text_inputs.iter())
            .collect()
    }
    pub(super) fn input_profile(&self) -> Option<&crate::runtime_package::DashboardTextInput> {
        let profiles = self.input_profiles();
        profiles
            .iter()
            .find(|profile| Some(&profile.node_id) == self.active_input.as_ref())
            .copied()
            .or_else(|| profiles.first().copied())
    }
    pub fn has_text_inputs(&self) -> bool {
        self.input_profile().is_some()
    }
    pub(super) fn initialize_input(&mut self) -> Result<(), String> {
        let profiles: Vec<_> = self.input_profiles().into_iter().cloned().collect();
        if profiles.len() > 16
            || self.document().text_input.is_some() && !self.document().text_inputs.is_empty()
        {
            return Err("ambiguous or over-budget text input collection".into());
        }
        let mut ids = std::collections::HashSet::new();
        let mut keys = std::collections::HashSet::new();
        let mut bytes = 0usize;
        for profile in &profiles {
            if !ids.insert(&profile.node_id) || !keys.insert(&profile.key) {
                return Err("duplicate text input identity or filter key".into());
            }
            for font in &profile.fonts {
                bytes = bytes
                    .checked_add(
                        crate::deep2d::runtime_base64::decoded_len(&font.data_base64)
                            .map_err(str::to_owned)?,
                    )
                    .ok_or("input font budget overflow")?;
                if bytes > 32 * 1024 * 1024 {
                    return Err("combined input fonts exceed 32 MiB".into());
                }
            }
            self.active_input = Some(profile.node_id.clone());
            self.initialize_active_input()?;
            self.input_bank.insert(
                profile.node_id.clone(),
                (input_text::InputState::default(), self.input_fonts.clone()),
            );
        }
        self.active_input = None;
        if let Some(first) = profiles.first() {
            self.activate_input(&first.node_id)?;
        }
        Ok(())
    }
    pub(super) fn activate_input(&mut self, id: &str) -> Result<(), String> {
        if self.active_input.as_deref() == Some(id) {
            return Ok(());
        }
        if let Some(old) = &self.active_input {
            self.input_ui.focused = false;
            self.input_ui.preedit.clear();
            self.input_ui.ime = crate::platform_text::WinitImeAdapter::new();
            self.input_bank.insert(
                old.clone(),
                (self.input_ui.clone(), self.input_fonts.clone()),
            );
        }
        let (state, fonts) = self
            .input_bank
            .get(id)
            .ok_or("input control missing")?
            .clone();
        self.input_ui = state;
        self.input_fonts = fonts;
        self.active_input = Some(id.into());
        Ok(())
    }
    pub fn input_value_for(&self, id: &str) -> Option<&str> {
        if self.active_input.as_deref() == Some(id) {
            Some(&self.input_ui.editor.document)
        } else {
            self.input_bank
                .get(id)
                .map(|(state, _)| state.editor.document.as_str())
        }
    }
    pub(super) fn input_content_for(
        &self,
        id: &str,
    ) -> Result<Option<crate::deep2d::Deep2dRuntimeContent>, String> {
        if !self
            .input_profiles()
            .iter()
            .any(|profile| profile.node_id == id)
        {
            return Ok(None);
        }
        if self.active_input.as_deref() == Some(id) {
            return self.input_content();
        }
        let mut candidate = self.clone();
        candidate.activate_input(id)?;
        candidate.input_content()
    }
    pub(super) fn input_id_at(&self, point: [f64; 2]) -> Option<String> {
        let page = self
            .document()
            .pages
            .iter()
            .find(|p| p.id == self.page_id)?;
        page.nodes
            .iter()
            .rev()
            .find(|node| {
                let [x, y, w, _] = node.frame;
                node.visible
                    && self
                        .input_profiles()
                        .iter()
                        .any(|profile| profile.node_id == node.id)
                    && point[0] >= x + 17.0
                    && point[0] < x + w - 17.0
                    && point[1] >= y + 17.0
                    && point[1] < y + 49.0
            })
            .map(|n| n.id.clone())
    }
}
