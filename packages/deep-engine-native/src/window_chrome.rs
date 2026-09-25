//! Native window chrome: system controls, stable application identity and fullscreen.
use std::sync::OnceLock;
use winit::{
    keyboard::KeyCode,
    window::{Fullscreen, Window},
};

fn application_name() -> &'static str {
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| clean_name(&embedded_application_name().unwrap_or_default()))
}

fn clean_name(stem: &str) -> String {
    let name: String = stem
        .chars()
        .filter(|ch| !ch.is_control())
        .take(96)
        .collect();
    let name = name.trim();
    if name.is_empty() {
        "Deep Monkey Studio".into()
    } else {
        name.into()
    }
}

#[cfg(target_os = "windows")]
fn embedded_application_name() -> Option<String> {
    use windows::{
        Win32::System::LibraryLoader::{
            FindResourceW, GetModuleHandleW, LoadResource, LockResource, SizeofResource,
        },
        core::PCWSTR,
    };
    // 发布器写入 UTF-8 RCDATA 102；不依赖文件名或工作目录中的旁车文件。
    unsafe {
        let module = GetModuleHandleW(None).ok()?;
        let resource = FindResourceW(
            Some(module),
            PCWSTR(102usize as *const u16),
            PCWSTR(10usize as *const u16),
        );
        if resource.is_invalid() {
            return None;
        }
        let size = SizeofResource(Some(module), resource) as usize;
        if size == 0 || size > 1024 {
            return None;
        }
        let loaded = LoadResource(Some(module), resource).ok()?;
        let data = LockResource(loaded);
        if data.is_null() {
            return None;
        }
        String::from_utf8(std::slice::from_raw_parts(data.cast::<u8>(), size).to_vec()).ok()
    }
}

#[cfg(not(target_os = "windows"))]
fn embedded_application_name() -> Option<String> {
    None
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

/// Hidden product windows are shown only after their first successful present.
/// Disable DWM's fade animation before that handoff so the compositor never
/// blends the fully rendered player with whatever white/black window is behind
/// it. The window remains opaque and keeps the normal system title bar.
#[cfg(target_os = "windows")]
pub fn disable_show_transition(window: &Window) -> Result<(), String> {
    use windows::Win32::{
        Foundation::HWND,
        Graphics::Dwm::{DWMWA_TRANSITIONS_FORCEDISABLED, DwmSetWindowAttribute},
    };
    use windows::core::BOOL;
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let handle = window.window_handle().map_err(|error| error.to_string())?;
    let RawWindowHandle::Win32(handle) = handle.as_raw() else {
        return Err("native Windows player has no Win32 window handle".into());
    };
    let disabled = BOOL(1);
    unsafe {
        DwmSetWindowAttribute(
            HWND(handle.hwnd.get() as *mut _),
            DWMWA_TRANSITIONS_FORCEDISABLED,
            (&disabled as *const BOOL).cast(),
            std::mem::size_of::<BOOL>() as u32,
        )
        .map_err(|error| error.to_string())
    }
}

/// Publish a frame that was rendered while the product window was hidden.
///
/// DWM does not necessarily commit a hidden swapchain before `ShowWindow`.
/// Showing it at its final position can therefore expose one compositor frame
/// of the dark window background before the already-presented scene arrives.
/// Stage the window off-screen for one DWM composition, then move the opaque,
/// composed surface to its intended position. This is only used for the first
/// successful product frame; later presents follow the normal winit path.
#[cfg(target_os = "windows")]
pub fn reveal_presented_window(window: &Window) -> Result<(), String> {
    use windows::Win32::{
        Foundation::{HWND, RECT},
        Graphics::Dwm::DwmFlush,
        UI::WindowsAndMessaging::{
            GetWindowRect, HWND_TOP, SET_WINDOW_POS_FLAGS, SWP_NOACTIVATE, SWP_NOSENDCHANGING,
            SWP_NOSIZE, SWP_NOZORDER, SetWindowPos,
        },
    };
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let handle = window.window_handle().map_err(|error| error.to_string())?;
    let RawWindowHandle::Win32(handle) = handle.as_raw() else {
        window.set_visible(true);
        return Err("native Windows player has no Win32 window handle".into());
    };
    let hwnd = HWND(handle.hwnd.get() as *mut _);
    let mut original = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut original) }.map_err(|error| {
        window.set_visible(true);
        error.to_string()
    })?;
    let flags: SET_WINDOW_POS_FLAGS =
        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSENDCHANGING;
    unsafe { SetWindowPos(hwnd, Some(HWND_TOP), -10_000, -10_000, 0, 0, flags) }.map_err(
        |error| {
            window.set_visible(true);
            error.to_string()
        },
    )?;
    window.set_visible(true);
    let staged = unsafe { DwmFlush() };
    let restored = unsafe {
        SetWindowPos(
            hwnd,
            Some(HWND_TOP),
            original.left,
            original.top,
            0,
            0,
            flags,
        )
    };
    if let Err(error) = restored {
        return Err(error.to_string());
    }
    if let Err(error) = staged {
        return Err(error.to_string());
    }
    unsafe { DwmFlush() }.map_err(|error| error.to_string())
}

#[cfg(not(target_os = "windows"))]
pub fn reveal_presented_window(window: &Window) -> Result<(), String> {
    window.set_visible(true);
    Ok(())
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
        assert_eq!(clean_name("deep-engine-native"), "deep-engine-native");
        assert_eq!(clean_name("  工厂\n看板  "), "工厂看板");
        assert_eq!(clean_name("   "), "Deep Monkey Studio");
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
