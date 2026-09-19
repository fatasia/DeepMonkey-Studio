//! 保存 Web 编译的冻结报表字节；取消不写文件，写入失败保留既有目标。
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
const MAX_BYTES: usize = 64 * 1024 * 1024;
static NEXT: AtomicU64 = AtomicU64::new(0);

pub fn save_report_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err("报表大小超出保存限制".into());
    }
    if !path.is_absolute() || path.file_name().is_none() {
        return Err("请选择完整的报表保存路径".into());
    }
    let parent = path.parent().ok_or("保存目录不存在")?;
    if !parent.is_dir() {
        return Err("保存目录不存在，请重新选择".into());
    }
    if let Ok(metadata) = fs::symlink_metadata(path)
        && (!metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.permissions().readonly()) {
            return Err("目标不可写，请选择其他文件".into());
    }
    let temporary = parent.join(format!(
        ".deep-report-{}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("无法创建报表文件：{error}"))?;
    let result = (|| {
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("报表写入失败：{error}"))?;
        drop(file);
        fs::rename(&temporary, path).map_err(|error| format!("报表保存失败：{error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(windows)]
pub fn choose_report_path(filename: &str, extension: &str, owner: isize) -> Result<Option<PathBuf>, String> {
    use windows::{
        Win32::UI::Controls::Dialogs::{
            CommDlgExtendedError, GetSaveFileNameW, OFN_EXPLORER, OFN_NOCHANGEDIR,
            OFN_NOREADONLYRETURN, OFN_OVERWRITEPROMPT, OFN_PATHMUSTEXIST, OPENFILENAMEW,
        },
        core::{PCWSTR, PWSTR},
    };
    if !matches!(extension, "csv" | "xlsx") || filename.contains(['/', '\\', '\0']) {
        return Err("无效的报表文件名".into());
    }
    let mut file = vec![0u16; 32768];
    let initial: Vec<u16> = filename.encode_utf16().collect();
    if initial.len() >= file.len() {
        return Err("报表文件名过长".into());
    }
    file[..initial.len()].copy_from_slice(&initial);
    let title: Vec<u16> = "保存报表\0".encode_utf16().collect();
    let filter: Vec<u16> = format!("{} 报表\0*.{}\0\0", extension.to_uppercase(), extension)
        .encode_utf16()
        .collect();
    let extension: Vec<u16> = extension.encode_utf16().chain(Some(0)).collect();
    let mut dialog = OPENFILENAMEW {
        hwndOwner: windows::Win32::Foundation::HWND(owner as *mut std::ffi::c_void),
        lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
        lpstrFile: PWSTR(file.as_mut_ptr()),
        nMaxFile: file.len() as u32,
        lpstrTitle: PCWSTR(title.as_ptr()),
        lpstrFilter: PCWSTR(filter.as_ptr()),
        lpstrDefExt: PCWSTR(extension.as_ptr()),
        Flags: OFN_EXPLORER
            | OFN_OVERWRITEPROMPT
            | OFN_PATHMUSTEXIST
            | OFN_NOCHANGEDIR
            | OFN_NOREADONLYRETURN,
        ..Default::default()
    };
    if unsafe { GetSaveFileNameW(&mut dialog) }.as_bool() {
        let end = file
            .iter()
            .position(|value| *value == 0)
            .ok_or("保存路径无效")?;
        return Ok(Some(PathBuf::from(
            String::from_utf16(&file[..end]).map_err(|_| "保存路径编码无效")?,
        )));
    }
    let code = unsafe { CommDlgExtendedError() };
    if code.0 == 0 {
        Ok(None)
    } else {
        Err(format!("无法打开保存窗口：{}", code.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn saves_exact_snapshot_replaces_atomically_and_keeps_existing_file_on_error() {
        let directory = std::env::temp_dir().join(format!(
            "deep-report-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&directory).unwrap();
        let file = directory.join("机组.csv");
        save_report_bytes(&file, b"first").unwrap();
        save_report_bytes(&file, b"second").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"second");
        assert!(save_report_bytes(&file, b"").is_err());
        assert_eq!(fs::read(&file).unwrap(), b"second");
        assert!(save_report_bytes(&directory, b"bad").is_err());
        assert!(save_report_bytes(&directory.join("missing/file.csv"), b"bad").is_err());
        let original_permissions = fs::metadata(&file).unwrap().permissions();
        let mut readonly = original_permissions.clone();
        readonly.set_readonly(true);
        fs::set_permissions(&file, readonly).unwrap();
        assert!(save_report_bytes(&file, b"bad").is_err());
        assert_eq!(fs::read(&file).unwrap(), b"second");
        fs::set_permissions(&file, original_permissions).unwrap();
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_file(file).unwrap();
        fs::remove_dir(directory).unwrap();
    }
}
