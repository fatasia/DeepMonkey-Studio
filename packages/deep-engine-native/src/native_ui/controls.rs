//! Pure control state machines for the retained UI (U04): button, toggle,
//! checkbox, select, slider — no timers, no platform input. Shared rules:
//! `disabled`/`loading` swallows activating input (including focusing),
//! `Focus`/`Blur` never fire responses, press/release pairs are deduplicated.

/// Input edge fed by the runtime stage.
#[derive(Debug, Clone, PartialEq)]
pub enum ControlEvent {
    Press,
    Release,
    Hover,
    Focus,
    Blur,
    KeyInput(String),
    ValueChange(f64),
}

/// What a control wants the outside world to do; one response per event.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ControlResponse {
    Clicked,
    Toggled(bool),
    ValueChanged(f64),
    SelectionChanged(usize),
    Opened,
    Closed,
}

/// Armed half of a press/release pair; the dedup signal for double presses.
#[derive(Debug, Default, Clone, Copy)]
struct PressArm {
    pressed: bool,
}

fn interactive(disabled: bool, loading: bool) -> bool {
    !disabled && !loading
}

/// Shared press cycle for click-style controls; `enabled` is the composite
/// `!disabled && !loading` gate (it also gates focusing). `Blur` disarms.
/// Returns true only when this event completes an armed press/release pair.
fn press_cycle(
    enabled: bool,
    focused: &mut bool,
    press: &mut PressArm,
    event: &ControlEvent,
) -> bool {
    match event {
        ControlEvent::Focus if enabled => *focused = true,
        ControlEvent::Blur => {
            *focused = false;
            press.pressed = false;
        }
        ControlEvent::Press if enabled => press.pressed = true,
        ControlEvent::Release if enabled && press.pressed => {
            press.pressed = false;
            return true;
        }
        _ => {}
    }
    false
}

/// Button: emits `Clicked` once per completed press/release pair.
#[derive(Debug, Default, Clone)]
pub struct Button {
    pub disabled: bool,
    pub focused: bool,
    pub loading: bool,
    press: PressArm,
}

impl Button {
    pub fn handle(&mut self, event: &ControlEvent) -> Option<ControlResponse> {
        if let ControlEvent::KeyInput(key) = event
            && interactive(self.disabled, self.loading)
            && matches!(key.as_str(), "Enter" | "Space")
        {
            self.press.pressed = false;
            return Some(ControlResponse::Clicked);
        }
        press_cycle(
            interactive(self.disabled, self.loading),
            &mut self.focused,
            &mut self.press,
            event,
        )
        .then_some(ControlResponse::Clicked)
    }
}

/// Toggle: flips `checked` on each completed press/release pair. Checkbox is
/// the same machine under a different a11y role, kept a distinct struct.
#[derive(Debug, Default, Clone)]
pub struct Toggle {
    pub disabled: bool,
    pub focused: bool,
    pub loading: bool,
    pub checked: bool,
    press: PressArm,
}

impl Toggle {
    pub fn handle(&mut self, event: &ControlEvent) -> Option<ControlResponse> {
        if let ControlEvent::KeyInput(key) = event
            && interactive(self.disabled, self.loading)
            && matches!(key.as_str(), "Enter" | "Space")
        {
            self.press.pressed = false;
            self.checked = !self.checked;
            return Some(ControlResponse::Toggled(self.checked));
        }
        press_cycle(
            interactive(self.disabled, self.loading),
            &mut self.focused,
            &mut self.press,
            event,
        )
        .then(|| {
            self.checked = !self.checked;
            ControlResponse::Toggled(self.checked)
        })
    }
}

#[derive(Debug, Default, Clone)]
pub struct Checkbox {
    pub disabled: bool,
    pub focused: bool,
    pub loading: bool,
    pub checked: bool,
    press: PressArm,
}

impl Checkbox {
    pub fn handle(&mut self, event: &ControlEvent) -> Option<ControlResponse> {
        if let ControlEvent::KeyInput(key) = event
            && interactive(self.disabled, self.loading)
            && matches!(key.as_str(), "Enter" | "Space")
        {
            self.press.pressed = false;
            self.checked = !self.checked;
            return Some(ControlResponse::Toggled(self.checked));
        }
        press_cycle(
            interactive(self.disabled, self.loading),
            &mut self.focused,
            &mut self.press,
            event,
        )
        .then(|| {
            self.checked = !self.checked;
            ControlResponse::Toggled(self.checked)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{Button, Checkbox, ControlEvent, ControlResponse, Toggle};

    #[test]
    fn authored_buttons_activate_from_enter_and_space_once() {
        for key in ["Enter", "Space"] {
            let mut button = Button::default();
            assert_eq!(
                button.handle(&ControlEvent::KeyInput(key.into())),
                Some(ControlResponse::Clicked)
            );
            button.disabled = true;
            assert_eq!(button.handle(&ControlEvent::KeyInput(key.into())), None);
        }
    }

    #[test]
    fn toggle_and_checkbox_keyboard_activation_preserves_state() {
        let mut toggle = Toggle::default();
        assert_eq!(
            toggle.handle(&ControlEvent::KeyInput("Enter".into())),
            Some(ControlResponse::Toggled(true))
        );
        assert_eq!(
            toggle.handle(&ControlEvent::KeyInput("Space".into())),
            Some(ControlResponse::Toggled(false))
        );
        let mut checkbox = Checkbox {
            checked: true,
            ..Checkbox::default()
        };
        assert_eq!(
            checkbox.handle(&ControlEvent::KeyInput("Space".into())),
            Some(ControlResponse::Toggled(false))
        );
    }

    #[test]
    fn keyboard_activation_does_not_leave_pointer_press_armed() {
        let mut button = Button::default();
        assert_eq!(button.handle(&ControlEvent::Press), None);
        assert_eq!(
            button.handle(&ControlEvent::KeyInput("Enter".into())),
            Some(ControlResponse::Clicked)
        );
        assert_eq!(button.handle(&ControlEvent::Release), None);
    }
}

/// Select: `Press` opens/commits; arrows move the highlight; Escape/blur close.
#[derive(Debug, Default, Clone)]
pub struct Select {
    pub disabled: bool,
    pub focused: bool,
    pub loading: bool,
    pub open: bool,
    pub highlighted_index: usize,
    pub option_count: usize,
}

impl Select {
    pub fn handle(&mut self, event: &ControlEvent) -> Option<ControlResponse> {
        match event {
            ControlEvent::Focus if !self.disabled => self.focused = true,
            ControlEvent::Blur => {
                self.focused = false;
                self.open = false;
            }
            ControlEvent::Press if interactive(self.disabled, self.loading) => {
                if self.open {
                    return self.commit();
                }
                self.open = true;
                return Some(ControlResponse::Opened);
            }
            ControlEvent::KeyInput(key) if interactive(self.disabled, self.loading) => {
                return self.handle_key(key);
            }
            _ => {}
        }
        None
    }

    fn handle_key(&mut self, key: &str) -> Option<ControlResponse> {
        if !self.open {
            return None;
        }
        match key {
            "ArrowDown" if self.option_count > 0 => {
                self.highlighted_index = (self.highlighted_index + 1).min(self.option_count - 1);
            }
            "ArrowUp" => self.highlighted_index = self.highlighted_index.saturating_sub(1),
            "Enter" => return self.commit(),
            "Escape" => {
                self.open = false;
                return Some(ControlResponse::Closed);
            }
            _ => {}
        }
        None
    }

    fn commit(&mut self) -> Option<ControlResponse> {
        self.open = false;
        (self.option_count > 0).then_some(ControlResponse::SelectionChanged(self.highlighted_index))
    }
}

/// Slider: clamps to `[min, max]`, snaps to `step` from `min` (step <= 0
/// disables snapping); arrows nudge.
#[derive(Debug, Clone)]
pub struct Slider {
    pub disabled: bool,
    pub focused: bool,
    pub loading: bool,
    pub min: f64,
    pub max: f64,
    pub step: f64,
    pub value: f64,
}

impl Slider {
    pub fn handle(&mut self, event: &ControlEvent) -> Option<ControlResponse> {
        match event {
            ControlEvent::Focus if !self.disabled => self.focused = true,
            ControlEvent::Blur => self.focused = false,
            ControlEvent::ValueChange(v) if interactive(self.disabled, self.loading) => {
                return self.set_value(*v);
            }
            ControlEvent::KeyInput(key) if interactive(self.disabled, self.loading) => {
                return match key.as_str() {
                    "ArrowRight" => self.set_value(self.value + self.step),
                    "ArrowLeft" => self.set_value(self.value - self.step),
                    _ => None,
                };
            }
            _ => {}
        }
        None
    }

    fn set_value(&mut self, requested: f64) -> Option<ControlResponse> {
        if !requested.is_finite() {
            return None;
        }
        let snapped = if self.step > 0.0 && (self.max - self.min).is_finite() {
            self.min + ((requested - self.min) / self.step).round() * self.step
        } else {
            requested
        };
        let clamped = snapped.clamp(self.min.min(self.max), self.max.max(self.min));
        if clamped == self.value {
            return None;
        }
        self.value = clamped;
        Some(ControlResponse::ValueChanged(clamped))
    }
}
