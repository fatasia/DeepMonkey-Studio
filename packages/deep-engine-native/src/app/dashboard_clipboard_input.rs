use super::{NativeApp, apply};
use winit::keyboard::KeyCode;

pub(super) fn key(app: &mut NativeApp, code: KeyCode) -> bool {
    if ![KeyCode::KeyC, KeyCode::KeyX, KeyCode::KeyV].contains(&code) {
        return false;
    }
    if !app
        .content
        .active()
        .dashboard
        .as_ref()
        .is_some_and(|r| r.input_focused() && !r.input_composing())
    {
        return true;
    }
    #[cfg(windows)]
    let result = (|| -> Result<(), String> {
        use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
        let window = app.window.as_ref().ok_or("Input window absent")?;
        let RawWindowHandle::Win32(handle) =
            window.window_handle().map_err(|e| e.to_string())?.as_raw()
        else {
            return Err("Input window is not Win32".into());
        };
        let owner = windows::Win32::Foundation::HWND(handle.hwnd.get() as *mut _);
        if code == KeyCode::KeyV {
            let text = super::clipboard::read(owner)?;
            apply(app, |candidate| candidate.input_paste(&text));
        } else if let Some(text) = app
            .content
            .active()
            .dashboard
            .as_ref()
            .and_then(|r| r.input_selected_text())
            .map(str::to_owned)
        {
            super::clipboard::write(owner, &text)?;
            if code == KeyCode::KeyX {
                apply(app, |candidate| candidate.input_cut_selection());
            }
        }
        Ok(())
    })();
    #[cfg(not(windows))]
    let result: Result<(), String> =
        Err("Clipboard is only available in the Windows player".into());
    if let Err(error) = result {
        super::report(app, Some(&error));
    }
    super::text_input::refresh(app);
    true
}
