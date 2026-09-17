//! 文件监听故障见证：只记录真实 decoder 返回，不通过等待时长推断拒绝。
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

static REJECTIONS: AtomicUsize = AtomicUsize::new(0);

pub(super) fn decode(
    bytes: &[u8],
    path: &std::path::Path,
    published: &crate::player_content::RuntimePackageSnapshot,
) -> Result<Option<package_watch::WatchedPackage>, String> {
    let result = package_watch::x_decoder(bytes, path, published);
    if result.is_err() {
        REJECTIONS.fetch_add(1, Ordering::Release);
    }
    result
}

#[derive(Default)]
pub(super) struct Faults {
    checked: usize,
}

impl Faults {
    pub(super) fn advance(&mut self, app: &NativeApp, root: &std::path::Path) {
        let rejected = REJECTIONS.load(Ordering::Acquire);
        if rejected == self.checked {
            return;
        }
        assert_eq!(rejected, self.checked + 1);
        assert!(app.content.active().pending_x_lkg.is_none());
        let store = crate::runtime_lkg::Store::new(
            root.join("local/DeepEngineNative/x-window-recovery"),
            &root.join("frame-1.json"),
        )
        .unwrap();
        let restored = deep_engine_native::runtime_package::parse_and_validate_x_runtime_package(
            &store.restore_x().unwrap(),
        )
        .unwrap();
        assert_eq!(
            restored.base.package_hash,
            app.content.active().runtime_package().unwrap().package_hash
        );
        self.checked = rejected;
        let next = if rejected == 1 {
            "ordinary.json"
        } else {
            "frame-3.json"
        };
        fs::write(
            root.join("frame-1.json"),
            fs::read(root.join(next)).unwrap(),
        )
        .unwrap();
    }

    pub(super) fn finish(&self) {
        assert_eq!(self.checked, 2);
        println!(
            "X live faults: bad-json=retained ordinary=retained LKG=unchanged valid=recovered"
        );
    }
}
