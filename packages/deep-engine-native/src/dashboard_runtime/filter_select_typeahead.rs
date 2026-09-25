use super::*;
use std::time::Duration;
use web_time::Instant;

const TYPEAHEAD_TIMEOUT: Duration = Duration::from_millis(900);
const TYPEAHEAD_MAX_CHARS: usize = 64;

impl DashboardRuntime {
    /// Native select typeahead. The published option values remain the single
    /// source of truth; typing only moves the pending highlight and Enter keeps
    /// the existing atomic filter transaction.
    pub fn select_text(&mut self, text: &str) -> Result<bool, String> {
        self.select_text_at(text, Instant::now())
    }

    pub(super) fn select_text_at(&mut self, text: &str, now: Instant) -> Result<bool, String> {
        if !self.select_focused() {
            return Ok(false);
        }
        let fragment: String = text
            .chars()
            .filter(|ch| !ch.is_control())
            .take(TYPEAHEAD_MAX_CHARS)
            .collect();
        if fragment.trim().is_empty() {
            return Ok(false);
        }
        self.transaction(|candidate| {
            if !candidate.select_ui.open {
                candidate.open_select();
            }
            if candidate
                .select_ui
                .typeahead_deadline
                .is_none_or(|deadline| now > deadline)
            {
                candidate.select_ui.typeahead.clear();
            }
            let remaining =
                TYPEAHEAD_MAX_CHARS.saturating_sub(candidate.select_ui.typeahead.chars().count());
            candidate
                .select_ui
                .typeahead
                .extend(fragment.chars().take(remaining));
            candidate.select_ui.typeahead_deadline = now.checked_add(TYPEAHEAD_TIMEOUT);

            let query = candidate.select_ui.typeahead.to_lowercase();
            let (match_index, reset_to_fragment) = {
                let options = &candidate.document().filter.as_ref().unwrap().options;
                let direct = find_match(options.iter().map(|option| option.value.as_str()), &query);
                let fallback = fragment.to_lowercase();
                let fallback_match = direct
                    .is_none()
                    .then(|| {
                        find_match(
                            options.iter().map(|option| option.value.as_str()),
                            &fallback,
                        )
                    })
                    .flatten();
                let reset = direct.is_none() && fallback_match.is_some();
                (direct.or(fallback_match), reset)
            };
            if reset_to_fragment {
                candidate.select_ui.typeahead = fragment.clone();
            }
            if let Some(index) = match_index {
                candidate.select_ui.highlighted = index;
                candidate.select_ui.hovered = None;
                candidate.reveal_select_highlight();
            }
            Ok(true)
        })
    }

    pub fn select_ime_rect(&self) -> Option<[f64; 4]> {
        self.select_focused()
            .then(|| self.select_geometry().map(|(header, _, _)| header))
            .flatten()
    }
}

fn find_match<'a>(mut values: impl Iterator<Item = &'a str> + Clone, query: &str) -> Option<usize> {
    values
        .clone()
        .position(|value| value.to_lowercase().starts_with(query))
        .or_else(|| values.position(|value| value.to_lowercase().contains(query)))
}
