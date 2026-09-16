//! P1-02 失效原因记账:改一个值只 miss 依赖子图,其余命令照常命中;原因按
//! 结构 → clip → resource → style 的固定顺序归入首要原因,LRU 逐出回归记 evicted。
use deep_engine_native::deep2d::*;

fn fixture() -> Deep2dDisplayList {
    decode_display_list(include_bytes!("../fixtures/deep2d_tessellated_v1.json")).unwrap()
}
fn command(list: &mut Deep2dDisplayList, i: usize) -> &mut PathCommand {
    let Deep2dCommand::Path(path) = &mut list.commands[i] else {
        unreachable!()
    };
    path
}
fn resource(list: &mut Deep2dDisplayList, i: usize) -> &mut PathResource {
    let Deep2dResource::Path(path) = &mut list.resources[i] else {
        unreachable!()
    };
    path
}
// 命令输出与未缓存路径逐字节等价,是每个场景的前置断言。
fn equal(list: &Deep2dDisplayList, cache: &mut Deep2dPathCache) {
    assert_eq!(
        prepare_display_list_cached(list, cache),
        prepare_display_list(list)
    );
}
// 相对 before 的一帧增量:(hits, misses) 与原因 (structure, clip, resource, style, evicted)。
// 首帧用 Default::default() 作快照,即从零起算。
fn counts(cache: &Deep2dPathCache, before: &Deep2dPathCacheStats) -> (u64, u64) {
    let after = cache.stats();
    (after.hits - before.hits, after.misses - before.misses)
}
fn reasons(cache: &Deep2dPathCache, before: &Deep2dPathCacheStats) -> (u64, u64, u64, u64, u64) {
    let after = cache.stats();
    (
        after.miss_reasons.structure_changed - before.miss_reasons.structure_changed,
        after.miss_reasons.clip_changed - before.miss_reasons.clip_changed,
        after.miss_reasons.resource_changed - before.miss_reasons.resource_changed,
        after.miss_reasons.style_changed - before.miss_reasons.style_changed,
        after.miss_reasons.evicted - before.miss_reasons.evicted,
    )
}

#[test]
fn style_change_invalidates_only_the_changed_series() {
    let mut list = fixture();
    let mut cache = Deep2dPathCache::default();
    equal(&list, &mut cache);
    command(&mut list, 2).stroke_width = Some(8.0);
    let before = cache.stats();
    equal(&list, &mut cache);
    assert_eq!(counts(&cache, &before), (2, 1));
    assert_eq!(reasons(&cache, &before), (0, 0, 0, 1, 0));
}

#[test]
fn resource_change_invalidates_only_the_referencing_series() {
    let mut list = fixture();
    let mut cache = Deep2dPathCache::default();
    equal(&list, &mut cache);
    resource(&mut list, 2).verbs[1] = Deep2dPathVerb::Line { x: 390.0, y: 40.0 };
    let before = cache.stats();
    equal(&list, &mut cache);
    assert_eq!(counts(&cache, &before), (2, 1));
    assert_eq!(reasons(&cache, &before), (0, 0, 1, 0, 0));
}

#[test]
fn clip_resource_change_flags_dependent_and_owner_with_clip_first() {
    let mut list = fixture();
    command(&mut list, 0).clip_path_ids = Some(vec!["overlay:status".into()]);
    let mut cache = Deep2dPathCache::default();
    equal(&list, &mut cache);
    // resources[1](overlay:status)既是命令 1 的自身资源又是命令 0 的 clip 依赖:
    // 命令 0 同时满足 clip_changed 与 resource_changed,按固定顺序只记 clip_changed。
    resource(&mut list, 1).verbs[1] = Deep2dPathVerb::Line { x: 86.0, y: 62.0 };
    resource(&mut list, 0).verbs[1] = Deep2dPathVerb::Line { x: 1.0, y: 2.0 };
    let before = cache.stats();
    equal(&list, &mut cache);
    assert_eq!(counts(&cache, &before), (1, 2));
    assert_eq!(reasons(&cache, &before), (0, 1, 1, 0, 0));
}

#[test]
fn inserted_command_misses_with_structure_reason_and_others_hit() {
    let mut list = fixture();
    let mut cache = Deep2dPathCache::default();
    equal(&list, &mut cache);
    let mut extra = command(&mut list, 2).clone();
    extra.id = "draw:appended".into();
    extra.z_order = 99;
    list.commands.push(Deep2dCommand::Path(extra));
    let before = cache.stats();
    equal(&list, &mut cache);
    assert_eq!(counts(&cache, &before), (3, 1));
    assert_eq!(reasons(&cache, &before), (1, 0, 0, 0, 0));
}

#[test]
fn removed_path_command_is_detected_after_successful_frame() {
    let mut list = fixture();
    let mut cache = Deep2dPathCache::default();
    equal(&list, &mut cache);
    assert_eq!(cache.stats().entries, 3);
    list.commands.remove(1);
    equal(&list, &mut cache);
    assert_eq!(cache.stats().deletions, 1);
    assert_eq!(cache.stats().entries, 2);
    // Re-adding the same id is a new structure entry, not a stale cache hit.
    let removed = fixture().commands[1].clone();
    list.commands.push(removed);
    equal(&list, &mut cache);
    assert_eq!(cache.stats().deletions, 1);
    assert_eq!(cache.stats().misses, 4);
}

#[test]
fn simultaneous_resource_and_style_change_reports_resource_first() {
    let mut list = fixture();
    let mut cache = Deep2dPathCache::default();
    equal(&list, &mut cache);
    resource(&mut list, 1).verbs[1] = Deep2dPathVerb::Line { x: 5.0, y: 6.0 };
    command(&mut list, 1).stroke_width = Some(9.0);
    let before = cache.stats();
    equal(&list, &mut cache);
    assert_eq!(counts(&cache, &before), (2, 1));
    assert_eq!(reasons(&cache, &before), (0, 0, 1, 0, 0));
}

#[test]
fn empty_frame_releases_payload_and_forgets_evicted_ids() {
    let mut list = fixture();
    let mut cache = Deep2dPathCache::with_limits(2, 8 * 1024 * 1024);
    equal(&list, &mut cache);
    assert!(cache.stats().payload_bytes > 0);
    list.commands.clear();
    equal(&list, &mut cache);
    assert_eq!(cache.stats().entries, 0);
    assert_eq!(cache.stats().payload_bytes, 0);
    assert_eq!(cache.stats().deletions, 2);
    equal(&list, &mut cache);
    assert_eq!(cache.stats().deletions, 2);
    list.commands.push(fixture().commands[0].clone());
    let before = cache.stats();
    equal(&list, &mut cache);
    assert_eq!(reasons(&cache, &before), (1, 0, 0, 0, 0));
}

#[test]
fn rejected_frame_does_not_prune_absent_commands() {
    let original = fixture();
    let mut cache = Deep2dPathCache::default();
    equal(&original, &mut cache);
    let before = cache.stats();
    let mut invalid = original.clone();
    invalid.commands.truncate(1);
    invalid.scale_factor = 0.0;
    assert!(prepare_display_list_cached(&invalid, &mut cache).is_err());
    assert_eq!(cache.stats(), before);
    invalid.scale_factor = 1.0;
    let unbaked =
        decode_display_list(include_bytes!("../fixtures/deep2d_display_list_v1.json")).unwrap();
    invalid.resources.push(unbaked.resources[1].clone());
    invalid.commands.push(unbaked.commands[1].clone());
    assert!(validate_display_list(&invalid).valid);
    let error = prepare_display_list_cached(&invalid, &mut cache).unwrap_err();
    assert_eq!(
        error.issues[0].code,
        Deep2dPainterIssueCode::UnsupportedCommand
    );
    assert_eq!(cache.stats().deletions, before.deletions);
    assert_eq!(cache.stats().entries, before.entries);
    assert_eq!(cache.stats().payload_bytes, before.payload_bytes);
    let before_restore = cache.stats();
    equal(&original, &mut cache);
    assert_eq!(counts(&cache, &before_restore), (3, 0));
}

#[test]
fn lru_evicted_id_returns_with_evicted_reason() {
    let list = fixture();
    let mut cache = Deep2dPathCache::with_limits(2, 8 * 1024 * 1024);
    equal(&list, &mut cache);
    assert_eq!(cache.stats().evictions, 1);
    let mut only_first = list.clone();
    only_first.commands.truncate(1);
    let before = cache.stats();
    equal(&only_first, &mut cache);
    assert_eq!(counts(&cache, &before), (0, 1));
    assert_eq!(reasons(&cache, &before), (0, 0, 0, 0, 1));
    let before = cache.stats();
    equal(&only_first, &mut cache);
    assert_eq!(counts(&cache, &before), (1, 0));
    assert_eq!(reasons(&cache, &before), (0, 0, 0, 0, 0));
}

#[test]
fn first_prepare_is_structure_changed_not_evicted() {
    let list = fixture();
    let mut cache = Deep2dPathCache::default();
    equal(&list, &mut cache);
    assert_eq!(counts(&cache, &Default::default()), (0, 3));
    assert_eq!(reasons(&cache, &Default::default()), (3, 0, 0, 0, 0));
}

#[test]
fn stats_display_and_json_summarize_miss_reasons() {
    let mut list = fixture();
    let mut cache = Deep2dPathCache::default();
    equal(&list, &mut cache);
    command(&mut list, 0).fill = Some([0.1, 0.2, 0.3, 1.0]);
    equal(&list, &mut cache);
    let stats = cache.stats();
    assert_eq!(stats.miss_reasons.total(), stats.misses);
    // 累计口径:冷启动 3 个 structure_changed + 本帧 1 个 style_changed。
    let line = format!("{stats}");
    assert!(
        line.contains("misses=4")
            && line.contains("style_changed=1")
            && line.contains("structure_changed=3"),
        "{line}"
    );
    // P1-02 第二批新增 epoch/相机两个帧级维度:JSON 字段序随结构体顺序前移,
    // 本断言同步到新形状(消费方按字段名读取,顺序变化已在此披露)。
    assert!(
        line.contains("camera_changed=0") && line.contains("epoch_changed=0"),
        "Display 必须同时暴露新增维度: {line}"
    );
    let json = serde_json::to_string(&stats).unwrap();
    assert!(
        json.contains(
            "\"miss_reasons\":{\"camera_changed\":0,\"epoch_changed\":0,\"structure_changed\":3,\"clip_changed\":0,"
        ) && json.contains("\"style_changed\":1,\"evicted\":0"),
        "{json}"
    );
}
