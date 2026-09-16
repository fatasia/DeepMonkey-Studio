use super::*;

#[test]
fn query_layout_has_non_overlapping_pairs() {
    let pairs = GpuSegment::ALL.map(GpuSegment::pair);
    assert_eq!(pairs, [(0, 1), (2, 3), (4, 5), (6, 7), (8, 9), (10, 11)]);
    assert_eq!(u64::from(QUERY_COUNT) * 8, 96);
    assert_eq!(SLOT_STRIDE, 256);
}

#[test]
fn unsupported_timestamp_report_is_machine_readable() {
    let value = serde_json::to_value(GpuReadback::degraded("timestamp_query_unsupported")).unwrap();
    assert_eq!(value["status"], "degraded");
    assert_eq!(value["reason"], "timestamp_query_unsupported");
    assert_eq!(value["samples"], 0);
}
