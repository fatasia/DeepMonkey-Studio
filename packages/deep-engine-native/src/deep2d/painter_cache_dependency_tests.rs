use super::*;

// ---- P1-02 第二批:epoch / 相机依赖维度 ----

fn fixture() -> crate::deep2d::Deep2dDisplayList {
    crate::deep2d::decode_display_list(include_bytes!("../../fixtures/deep2d_tessellated_v1.json"))
        .unwrap()
}
fn cached(
    list: &crate::deep2d::Deep2dDisplayList,
    cache: &mut Deep2dPathCache,
) -> crate::deep2d::PreparedDeep2d {
    crate::deep2d::prepare_display_list_cached(list, cache).expect("prepare")
}

/// 宿主显式相机声明必须同时决定「见证」与「细分缩放」:两者同源是硬约束。
/// 若见证用显式值而细分仍用 display_list.scaleFactor,就会产生
/// 「见证记 2.0 而几何按 1.0 细分」的条目,后续帧将永久命中错误几何。
#[test]
fn explicit_camera_declaration_drives_both_witness_and_tessellation() {
    let list = fixture();
    let mut explicit = Deep2dPathCache::default();
    explicit.set_camera_scale(2.0);
    let by_explicit = cached(&list, &mut explicit);

    let mut plain = list.clone();
    plain.scale_factor = 2.0;
    let by_static = crate::deep2d::prepare_display_list(&plain).unwrap();
    assert_eq!(
        by_explicit, by_static,
        "显式相机缩放与等价 scaleFactor 的单帧产物必须逐值一致"
    );

    // 静态字段仍为 1.0 的这一帧,几何不得退化成 1.0 的结果。
    let mut at_one = Deep2dPathCache::default();
    let one = cached(&list, &mut at_one);
    assert_ne!(
        by_explicit, one,
        "2.0 相机下的几何必须与 1.0 不同(否则本条断言不成立)"
    );
}

#[test]
fn camera_scale_dependency_invalidates_once_and_rebuilds_exact_geometry() {
    let list = fixture();
    let mut cache = Deep2dPathCache::default();
    let at_one = cached(&list, &mut cache);
    assert_eq!(cache.stats().misses, 3, "冷启动 3 条路径首次细分");

    cache.set_camera_scale(2.0);
    let at_two = cached(&list, &mut cache);
    let reasons = cache.stats().miss_reasons;
    assert_eq!(reasons.camera_changed, 3, "整批条目按相机维度失效");
    assert_eq!(cache.stats().misses, 6);
    assert_eq!(reasons.total(), 6, "total() 恒等于 misses");
    // 相机见证优先于显示列表自带 scaleFactor:这就是「宿主声明取代静态字段」的语义。
    let mut plain = list.clone();
    plain.scale_factor = 2.0;
    assert_eq!(
        at_two,
        crate::deep2d::prepare_display_list(&plain).unwrap(),
        "显式相机见证与等价 scaleFactor 的静态帧必须产出同一几何"
    );
    assert_ne!(
        at_one, at_two,
        "不同物理缩放的细分产物必须不同(否则本条断言无意义)"
    );

    // 同一相机见证重复准备:全部命中,不得重复计失效。
    let again = cached(&list, &mut cache);
    assert_eq!(again, at_two);
    assert_eq!(cache.stats().hits, 3);
    assert_eq!(
        cache.stats().miss_reasons.camera_changed,
        3,
        "幂等帧不新增相机失效"
    );

    // 相机往返:回到 1.0 再次失效一次,且产物与首次逐值一致——依赖换代不累积漂移。
    cache.set_camera_scale(1.0);
    let back = cached(&list, &mut cache);
    assert_eq!(back, at_one, "相机往返后几何与首次一致");
    assert_eq!(cache.stats().miss_reasons.camera_changed, 6);
}

/// epoch 维度:换包换代按 epoch_changed 记账,同代重复声明是空操作。
#[test]
fn resource_epoch_dependency_is_recorded_and_idempotent() {
    let list = fixture();
    let mut cache = Deep2dPathCache::default();
    cache.set_resource_epoch(1);
    cached(&list, &mut cache);
    assert_eq!(cache.stats().misses, 3);
    assert_eq!(
        cache.stats().miss_reasons.epoch_changed,
        0,
        "首次出现属结构维度,不是换代"
    );

    cached(&list, &mut cache);
    assert_eq!(cache.stats().miss_reasons.epoch_changed, 0, "同代不失效");
    assert_eq!(cache.stats().hits, 3, "同代重复准备全命中");

    cache.set_resource_epoch(2);
    cached(&list, &mut cache);
    assert_eq!(
        cache.stats().miss_reasons.epoch_changed,
        3,
        "整批条目按 epoch 维度失效"
    );
    assert_eq!(
        cache.stats().miss_reasons.camera_changed,
        0,
        "相机未变不抢占归因"
    );
    assert_eq!(cache.stats().misses, 6);

    cached(&list, &mut cache);
    assert_eq!(cache.stats().hits, 6, "换代后恢复命中");
    assert_eq!(cache.stats().misses, 6, "换代只收一次失效账");
    assert_eq!(cache.stats().miss_reasons.total(), cache.stats().misses);
}

/// 依赖图的边界:数据 revision 与 z 序/命中 id 刻意不进图——它们不改细分几何,
/// 进图只会制造假失效。这与 P1-01「data_revision 不参与几何缓存」的口径一致。
#[test]
fn data_revision_and_presentation_metadata_stay_out_of_the_dependency_graph() {
    let mut list = fixture();
    let mut cache = Deep2dPathCache::default();
    cached(&list, &mut cache);
    let before = cache.stats();

    list.revision += 7;
    list.commands.reverse();
    for command in &mut list.commands {
        if let crate::deep2d::Deep2dCommand::Path(path) = command {
            path.z_order += 5;
            path.hit_id = Some("late:rename".into());
        }
    }
    let after = cached(&list, &mut cache);
    assert_eq!(
        cache.stats().misses,
        before.misses,
        "改数据/呈现元数据不得触发重细分"
    );
    assert_eq!(cache.stats().hits, before.hits + 3);
    assert_eq!(
        after,
        crate::deep2d::prepare_display_list(&list).unwrap(),
        "命中路径仍产出正确字节"
    );
}

/// 归因优先级:相机与 epoch 同时变化时只记相机(第一个命中的维度),不双计。
#[test]
fn frame_level_dimensions_attribute_only_the_first_change() {
    let list = fixture();
    let mut cache = Deep2dPathCache::default();
    cache.set_resource_epoch(1);
    cached(&list, &mut cache);

    cache.set_resource_epoch(2);
    cache.set_camera_scale(3.0);
    cached(&list, &mut cache);
    let reasons = cache.stats().miss_reasons;
    assert_eq!(reasons.camera_changed, 3, "相机先判定");
    assert_eq!(reasons.epoch_changed, 0, "一次 miss 只归入首个维度");
    assert_eq!(reasons.total(), cache.stats().misses);
}

/// 布线边界:未声明相机时退回显示列表 scale_factor,行为与第一批逐字节一致。
#[test]
fn unset_camera_witness_falls_back_to_display_list_scale() {
    let mut list = fixture();
    let mut cache = Deep2dPathCache::default();
    cached(&list, &mut cache);
    list.scale_factor = 1.5;
    cached(&list, &mut cache);
    assert_eq!(
        cache.stats().miss_reasons.camera_changed,
        3,
        "回退见证仍能辨识缩放变化"
    );

    // 非有限缩放不得写入见证,退化为「无相机判定」而非伪造失效。
    list.scale_factor = 1.0;
    let mut cache = Deep2dPathCache::default();
    cache.set_camera_scale(f64::NAN);
    cached(&list, &mut cache);
    cached(&list, &mut cache);
    assert_eq!(cache.stats().hits, 3, "NaN 相机见证不制造失效");
    assert_eq!(cache.stats().miss_reasons.camera_changed, 0);
}

/// 换代与结构变化叠加时:joins 结构判定优先于 epoch(条目已不存在,只能按结构/逐出归因)。
#[test]
fn structural_change_outranks_epoch_for_absent_entries() {
    let mut list = fixture();
    list.commands.truncate(2);
    let mut cache = Deep2dPathCache::default();
    cache.set_resource_epoch(1);
    cached(&list, &mut cache);
    assert_eq!(cache.stats().misses, 2, "两条路径首次出现");

    let fresh = fixture();
    cache.set_resource_epoch(2);
    cached(&fresh, &mut cache);
    let reasons = cache.stats().miss_reasons;
    // 计数是累积的:第 1 帧的两次「首次出现」也计入 structure_changed,
    // 第 2 帧只新增一条(draw:curve 在本帧首次出现)。
    assert_eq!(
        reasons.structure_changed, 3,
        "首帧 2 次首次出现 + 本帧新增 1 条"
    );
    assert_eq!(reasons.epoch_changed, 2, "既有两条按 epoch 换代");
    assert_eq!(cache.stats().misses, 5);
    assert_eq!(cache.stats().hits, 0, "本帧无一条命中");
    assert_eq!(cache.stats().miss_reasons.total(), cache.stats().misses);

    // 第 3 帧:同代同结构,必须全命中——证明换代的失效是一次性的。
    cached(&fresh, &mut cache);
    assert_eq!(cache.stats().hits, 3, "换代后再无失效");
    assert_eq!(cache.stats().misses, 5);
}
