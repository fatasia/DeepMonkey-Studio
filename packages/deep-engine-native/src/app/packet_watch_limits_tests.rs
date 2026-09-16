use std::fs;

use super::{PacketIdentity, PacketUpdate, load_update};

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
    let PacketUpdate::Rejected { reason, .. } = load_update(&path, &unseen, u64::MAX) else {
        panic!("oversized packet must be rejected");
    };
    assert!(reason.contains("160 MiB input limit"), "{reason}");
    fs::remove_file(path).ok();
}
