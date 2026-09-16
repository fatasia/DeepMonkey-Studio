use std::{
    fmt::Display,
    fs::{self, FileTimes, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, UNIX_EPOCH},
};

use super::{read, read_with_hook};

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        static NEXT_ID: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "deep-runtime-read-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).expect("create isolated read test directory");
        Self(path)
    }

    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn assert_path_redacted(error: impl Display, path: &Path) {
    let diagnostic = error.to_string();
    assert!(
        !diagnostic.contains(&path.to_string_lossy().to_string()),
        "runtime package diagnostic exposed an input path: {diagnostic}"
    );
}

#[test]
fn unicode_file_path_reads_without_lossy_conversion() {
    let directory = TestDirectory::new();
    let path = directory.path("深引擎-运行包-纹理.json");
    fs::write(&path, b"{\"unicode\":true}").expect("write unicode package path");
    assert_eq!(
        read(&path).expect("read unicode package path"),
        b"{\"unicode\":true}"
    );
}

#[test]
fn missing_unicode_file_path_is_redacted_from_read_errors() {
    let directory = TestDirectory::new();
    let path = directory
        .path("\u{4e0d}\u{5b58}\u{5728}-\u{6df1}\u{5f15}\u{64ce}-\u{8fd0}\u{884c}\u{5305}.json");
    let error = read(&path).expect_err("missing package must fail");
    assert!(error.to_string().contains("metadata-failed"), "{error}");
    assert_path_redacted(error, &path);
}

#[test]
fn directory_is_rejected_as_a_non_regular_file() {
    let directory = TestDirectory::new();
    let error = read(&directory.0).expect_err("directory must be rejected");
    assert!(error.to_string().contains("non-regular-file"), "{error}");
    assert_path_redacted(error, &directory.0);
}

#[test]
fn symbolic_link_is_rejected_when_platform_allows_creating_one() {
    let directory = TestDirectory::new();
    let target = directory.path("target.json");
    let link = directory.path("link.json");
    fs::write(&target, b"{}").expect("write symlink target");
    if let Err(error) = create_file_symlink(&target, &link) {
        if error.kind() == std::io::ErrorKind::PermissionDenied
            || error.raw_os_error() == Some(1_314)
        {
            return;
        }
        panic!("create file symlink: {error}");
    }
    let error = read(&link).expect_err("symlink must be rejected");
    assert!(error.to_string().contains("symlink-rejected"), "{error}");
    assert_path_redacted(error, &link);
}

#[test]
fn size_change_after_open_is_rejected() {
    let directory = TestDirectory::new();
    let path = directory.path("size.json");
    fs::write(&path, b"{}").expect("write package");
    let error = read_with_hook(&path, || {
        OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("open package for append")
            .write_all(b" ")
            .expect("append package");
    })
    .expect_err("size race must be rejected");
    assert!(error.to_string().contains("input-size-changed"), "{error}");
    assert_path_redacted(error, &path);
}

#[test]
fn modification_time_change_after_open_is_rejected() {
    let directory = TestDirectory::new();
    let path = directory.path("mtime.json");
    fs::write(&path, b"{}").expect("write package");
    let error = read_with_hook(&path, || {
        let file = OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("open package for timestamp change");
        let changed = UNIX_EPOCH + Duration::from_secs(1_234_567_890);
        file.set_times(FileTimes::new().set_modified(changed))
            .expect("change package timestamp");
    })
    .expect_err("mtime race must be rejected");
    assert!(error.to_string().contains("input-modified"), "{error}");
    assert_path_redacted(error, &path);
}

#[test]
fn path_replacement_after_open_is_rejected() {
    let directory = TestDirectory::new();
    let path = directory.path("active.json");
    let retired = directory.path("retired.json");
    fs::write(&path, b"{\"generation\":1}").expect("write package");
    let error = read_with_hook(&path, || {
        fs::rename(&path, &retired).expect("retire open package");
        fs::write(&path, b"{\"generation\":2}").expect("publish replacement package");
    })
    .expect_err("identity race must be rejected");
    assert!(
        error.to_string().contains("input-identity-changed"),
        "{error}"
    );
    assert_path_redacted(error, &path);
}

#[cfg(unix)]
fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(target, link)
}
