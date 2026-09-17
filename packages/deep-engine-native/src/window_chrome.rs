//! Native window chrome: system controls, stable application identity and fullscreen.
use std::sync::OnceLock;
use winit::{
    keyboard::KeyCode,
    window::{Fullscreen, Window},
};

fn application_name() -> &'static str {
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| {
        let path = std::env::current_exe().ok();
        let stem = path
            .as_ref()
            .and_then(|path| path.file_stem())
            .and_then(|s| s.to_str());
        clean_name(stem.unwrap_or(""))
    })
}

fn clean_name(stem: &str) -> String {
    let name: String = stem
        .chars()
        .filter(|ch| !ch.is_control())
        .take(96)
        .collect();
    let name = name.trim();
    if name.is_empty() || name.starts_with("deep-engine-native") {
        "Deep Monkey".into()
    } else {
        name.into()
    }
}

pub fn title(status: &str) -> String {
    format_title(application_name(), status)
}

fn format_title(name: &str, status: &str) -> String {
    let status = [
        "Deep Engine Native Viewer — ",
        "Deep Engine Dashboard — ",
        "Deep Engine Chart — ",
        "Deep Engine X — ",
    ]
    .iter()
    .find_map(|prefix| status.strip_prefix(prefix))
    .unwrap_or(status)
    .trim();
    if status.is_empty() {
        format!("{name}  |  F11 全屏")
    } else {
        format!("{name}  —  {status}")
    }
}

pub fn set_title(window: &Window, status: &str) {
    window.set_title(&title(status));
}

pub fn fullscreen_key(window: &Window, key: KeyCode) -> bool {
    let Some(enabled) = fullscreen_action(key, window.fullscreen().is_some()) else {
        return false;
    };
    window.set_fullscreen(enabled.then(|| Fullscreen::Borderless(window.current_monitor())));
    window.request_redraw();
    true
}

fn fullscreen_action(key: KeyCode, fullscreen: bool) -> Option<bool> {
    match key {
        KeyCode::F11 => Some(!fullscreen),
        KeyCode::Escape if fullscreen => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn title_keeps_application_identity_and_removes_engine_prefixes() {
        assert_eq!(format_title("工厂看板", ""), "工厂看板  |  F11 全屏");
        assert_eq!(
            format_title("工厂看板", "Deep Engine Dashboard — 页面 2 / 3"),
            "工厂看板  —  页面 2 / 3"
        );
        assert_eq!(clean_name("deep-engine-native"), "Deep Monkey");
        assert_eq!(clean_name("  工厂\n看板  "), "工厂看板");
        assert_eq!(clean_name("   "), "Deep Monkey");
        assert_eq!(clean_name(&"中".repeat(100)).chars().count(), 96);
    }
    #[test]
    fn fullscreen_keys_never_exit_the_window() {
        assert_eq!(fullscreen_action(KeyCode::F11, false), Some(true));
        assert_eq!(fullscreen_action(KeyCode::F11, true), Some(false));
        assert_eq!(fullscreen_action(KeyCode::Escape, true), Some(false));
        assert_eq!(fullscreen_action(KeyCode::Escape, false), None);
        assert_eq!(fullscreen_action(KeyCode::KeyA, true), None);
    }
}
