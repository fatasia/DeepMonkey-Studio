use super::*;
#[test]
fn entry_and_payload_limits_evict_without_changing_geometry() {
    let list = crate::deep2d::decode_display_list(include_bytes!(
        "../../fixtures/deep2d_tessellated_v1.json"
    ))
    .unwrap();
    let expected = crate::deep2d::prepare_display_list(&list).unwrap();
    let mut cache = Deep2dPathCache {
        max_entries: 1,
        ..Default::default()
    };
    assert_eq!(
        crate::deep2d::prepare_display_list_cached(&list, &mut cache).unwrap(),
        expected
    );
    assert_eq!(cache.stats().entries, 1);
    assert_eq!(cache.stats().evictions, 2);
    assert!(cache.stats().payload_bytes <= cache.max_bytes);
    let mut tiny = Deep2dPathCache {
        max_bytes: 1,
        ..Default::default()
    };
    assert_eq!(
        crate::deep2d::prepare_display_list_cached(&list, &mut tiny).unwrap(),
        expected
    );
    assert_eq!(tiny.stats().entries, 0);
    assert_eq!(tiny.stats().payload_bytes, 0);
}

#[test]
fn touching_entries_updates_lru_without_unbounded_bookkeeping() {
    let all = crate::deep2d::decode_display_list(include_bytes!(
        "../../fixtures/deep2d_tessellated_v1.json"
    ))
    .unwrap();
    let mut list = all.clone();
    list.commands.truncate(2);
    let mut cache = Deep2dPathCache {
        max_entries: 2,
        ..Default::default()
    };
    crate::deep2d::prepare_display_list_cached(&list, &mut cache).unwrap();
    list.commands.truncate(1);
    for _ in 0..100 {
        crate::deep2d::prepare_display_list_cached(&list, &mut cache).unwrap();
    }
    assert_eq!(cache.entries.len(), cache.order.len());
    list.commands = vec![all.commands[2].clone()];
    crate::deep2d::prepare_display_list_cached(&list, &mut cache).unwrap();
    assert!(!cache.entries.contains_key("draw:panel"));
    assert!(cache.entries.contains_key("draw:curve"));
    assert!(!cache.entries.contains_key("draw:status"));
    // status 在前一帧已清理，插入 curve 不触发容量逐出。
    assert_eq!(cache.stats().evictions, 0);
}

#[test]
fn clipped_entry_stores_with_owned_clips_and_hits_with_current_metadata() {
    let mut list = crate::deep2d::decode_display_list(include_bytes!(
        "../../fixtures/deep2d_tessellated_v1.json"
    ))
    .unwrap();
    let crate::deep2d::Deep2dCommand::Path(command) = &mut list.commands[0] else {
        unreachable!()
    };
    command.clip_path_ids = Some(vec!["overlay:status".into()]);
    let mut cache = Deep2dPathCache {
        max_entries: 8,
        ..Default::default()
    };
    crate::deep2d::prepare_display_list_cached(&list, &mut cache).unwrap();
    assert_eq!(cache.stats().misses, 3);
    list.revision += 1;
    let crate::deep2d::Deep2dCommand::Path(command) = &mut list.commands[0] else {
        unreachable!()
    };
    command.z_order = 7;
    command.hit_id = Some("hit".into());
    let expected = crate::deep2d::prepare_display_list(&list).unwrap();
    assert_eq!(
        crate::deep2d::prepare_display_list_cached(&list, &mut cache).unwrap(),
        expected
    );
    assert_eq!(cache.stats().hits, 3);
}
