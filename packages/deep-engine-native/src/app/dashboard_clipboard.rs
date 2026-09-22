//! Windows Unicode clipboard, bounded before allocation; ownership transfers only on success.
use windows::Win32::{
    Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND},
    System::{DataExchange::*, Memory::*},
};
const UNICODE_TEXT: u32 = 13;
const MAX_BYTES: usize = 128 * 1024;
struct Open;
impl Drop for Open {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseClipboard();
        }
    }
}
struct Allocation(HGLOBAL);
impl Drop for Allocation {
    fn drop(&mut self) {
        unsafe {
            let _ = GlobalFree(Some(self.0));
        }
    }
}

pub(super) fn read(owner: HWND) -> Result<String, String> {
    unsafe {
        OpenClipboard(Some(owner)).map_err(|e| format!("Cannot open clipboard: {e}"))?;
        let _open = Open;
        let handle = GetClipboardData(UNICODE_TEXT)
            .map_err(|e| format!("Clipboard has no Unicode text: {e}"))?;
        let memory = HGLOBAL(handle.0);
        let bytes = GlobalSize(memory);
        if bytes == 0 || bytes > MAX_BYTES || bytes % 2 != 0 {
            return Err("Clipboard text exceeds the input byte budget".into());
        }
        let ptr = GlobalLock(memory).cast::<u16>();
        if ptr.is_null() {
            return Err("Cannot read clipboard text".into());
        }
        let units = std::slice::from_raw_parts(ptr, bytes / 2);
        let result = decode(units);
        let _ = GlobalUnlock(memory);
        result
    }
}
pub(super) fn write(owner: HWND, text: &str) -> Result<(), String> {
    if text.contains('\0') {
        return Err("Clipboard text contains NUL".into());
    }
    let units: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes = units
        .len()
        .checked_mul(2)
        .filter(|n| *n <= MAX_BYTES)
        .ok_or("Clipboard text exceeds the input byte budget")?;
    unsafe {
        let allocation = Allocation(GlobalAlloc(GMEM_MOVEABLE, bytes).map_err(|e| e.to_string())?);
        let ptr = GlobalLock(allocation.0).cast::<u16>();
        if ptr.is_null() {
            return Err("Cannot allocate clipboard text".into());
        }
        std::ptr::copy_nonoverlapping(units.as_ptr(), ptr, units.len());
        let _ = GlobalUnlock(allocation.0);
        OpenClipboard(Some(owner)).map_err(|e| format!("Cannot open clipboard: {e}"))?;
        let _open = Open;
        EmptyClipboard().map_err(|e| e.to_string())?;
        SetClipboardData(UNICODE_TEXT, Some(HANDLE(allocation.0.0))).map_err(|e| e.to_string())?;
        std::mem::forget(allocation);
        Ok(())
    }
}
fn decode(units: &[u16]) -> Result<String, String> {
    let end = units
        .iter()
        .position(|&c| c == 0)
        .ok_or("Clipboard text has no terminator")?;
    String::from_utf16(&units[..end]).map_err(|_| "Clipboard text is invalid UTF-16".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_and_invalid_clipboard_buffers() {
        let valid: Vec<_> = "中🙂".encode_utf16().chain([0, 1]).collect();
        assert_eq!(decode(&valid).unwrap(), "中🙂");
        assert!(decode(&[0xd800, 0]).is_err());
        assert!(decode(&[65]).is_err());
    }
}
