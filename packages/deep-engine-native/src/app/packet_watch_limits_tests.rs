use std::fs;

use super::{PacketIdentity, PacketUpdate, load_update};

#[test]
#[cfg(windows)]
fn temporarily_locked_packet_retries_without_a_metadata_change() {
    use std::os::windows::fs::OpenOptionsExt;
    let path = std::env::temp_dir().join(format!("locked-packet-{}.json", std::process::id()));
    fs::copy(deep_engine_native::contract::default_fixture_path(), &path).unwrap();
    let before = super::file_identity(&path).unwrap();
    let lock = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&path)
        .unwrap();
    let PacketUpdate::Rejected { identity, reason } = load_update(&path, None, u64::MAX) else {
        panic!("locked file must be rejected");
    };
    assert!(identity.is_none());
    assert!(reason.contains("cannot read watched packet"), "{reason}");
    drop(lock);
    assert_eq!(super::file_identity(&path).unwrap(), before);
    assert!(matches!(
        load_update(&path, identity.as_ref(), u64::MAX),
        PacketUpdate::Ready { .. }
    ));
    fs::remove_file(path).unwrap();
}

#[test]
fn first_poll_does_not_trust_metadata_and_retries_a_missing_source() {
    let path = std::env::temp_dir().join(format!("packet-first-poll-{}.json", std::process::id()));
    assert!(matches!(
        load_update(&path, None, u64::MAX),
        PacketUpdate::Rejected { identity: None, .. }
    ));
    fs::copy(deep_engine_native::contract::default_fixture_path(), &path).unwrap();
    let PacketUpdate::Ready { key, identity, .. } = load_update(&path, None, u64::MAX) else {
        panic!("first source content must be checked");
    };
    assert!(matches!(
        load_update(&path, Some(&identity), key),
        PacketUpdate::Unchanged
    ));
    fs::remove_file(&path).unwrap();
    assert!(matches!(
        load_update(&path, Some(&identity), key),
        PacketUpdate::Rejected { identity: None, .. }
    ));
    fs::copy(deep_engine_native::contract::default_fixture_path(), &path).unwrap();
    assert!(matches!(
        load_update(&path, None, key),
        PacketUpdate::Equivalent { .. }
    ));
    fs::remove_file(path).unwrap();
}

#[test]
fn oversized_watched_packet_fails_before_an_unbounded_read() {
    let path = std::env::temp_dir().join(format!(
        "deep-engine-native-oversized-packet-{}.json",
        std::process::id()
    ));
    let file = fs::File::create(&path).expect("create sparse oversized packet");
    file.set_len(160 * 1024 * 1024 + 1)
        .expect("size sparse packet");
    drop(file);
    let unseen = PacketIdentity {
        modified: None,
        len: 0,
    };
    let PacketUpdate::Rejected { reason, .. } = load_update(&path, Some(&unseen), u64::MAX) else {
        panic!("oversized packet must be rejected");
    };
    assert!(reason.contains("160 MiB input limit"), "{reason}");
    fs::remove_file(path).ok();
}
