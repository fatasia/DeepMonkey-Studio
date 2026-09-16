//! P1-02 宿主接线行为锁定:证明宿主声明的 epoch 与真实物理缩放**真的**改变了
//! 缓存失效判定与细分几何,而不是只调用了一次 API。
//!
//! 这一层刻意用 CPU 级断言(统计 + 几何字节),不需要真实 GPU:依赖图的产出
//! 是细分顶点与统计计数,GPU 只是消费它们。真实窗口复核单独在 GPU 车道跑。

use deep_engine_native::deep2d::{
    Deep2dDisplayList, Deep2dPathCache, Deep2dRuntimeContent, LetterboxMapping,
    prepare_display_list, prepare_display_list_cached,
};

use crate::deep2d_gpu::deep2d_frame_context;

fn fixture() -> Deep2dDisplayList {
    deep_engine_native::deep2d::decode_display_list(include_bytes!(
        "../fixtures/deep2d_tessellated_v1.json"
    ))
    .unwrap()
}

fn scaled(list: &Deep2dDisplayList, scale: f64) -> deep_engine_native::deep2d::PreparedDeep2d {
    let mut cache = Deep2dPathCache::default();
    cache.set_camera_scale(scale);
    prepare_display_list_cached(list, &mut cache).expect("prepare")
}

/// 宿主上下文必须能改变细分几何:同一静态内容在 1x 与 2x 下产出不同顶点,
/// 且 2x 产物等于把 scaleFactor 直接设成 2.0 的静态帧——证明「见证与几何同源」。
#[test]
fn host_declared_scale_changes_tessellation_and_matches_static_equivalent() {
    let list = fixture();
    let one = scaled(&list, 1.0);
    let two = scaled(&list, 2.0);

    let mut static_two = list.clone();
    static_two.scale_factor = 2.0;
    let expected = prepare_display_list(&static_two).unwrap();

    assert_eq!(
        two, expected,
        "宿主声明的 2x 必须与等价静态 scaleFactor 逐值一致"
    );
    assert_ne!(
        one.vertices.len(),
        two.vertices.len(),
        "物理缩放必须真正改变细分密度,否则接线是空转"
    );
}

/// 换代必须整批失效一次并按 epoch 归因,而不是被误判命中。
#[test]
fn host_epoch_bump_invalidates_once_and_then_hits_again() {
    let list = fixture();
    let mut cache = Deep2dPathCache::default();
    prepare_display_list_cached(&list, &mut cache).unwrap();
    assert_eq!(cache.stats().misses, 3);
    assert_eq!(cache.stats().hits, 0);

    // 第 2 帧:同代同几何,全命中。
    prepare_display_list_cached(&list, &mut cache).unwrap();
    assert_eq!(cache.stats().hits, 3, "同代重复准备必须全命中");

    // 第 3 帧:宿主声明换代(换包/换页),整批按 epoch 失效。
    cache.set_resource_epoch(9);
    prepare_display_list_cached(&list, &mut cache).unwrap();
    assert_eq!(
        cache.stats().miss_reasons.epoch_changed,
        3,
        "换代整批失效且归因 epoch"
    );
    assert_eq!(cache.stats().miss_reasons.camera_changed, 0);
    assert_eq!(cache.stats().miss_reasons.total(), cache.stats().misses);

    // 第 4 帧:同代恢复命中,证明换代失效是一次性的。
    prepare_display_list_cached(&list, &mut cache).unwrap();
    assert_eq!(cache.stats().hits, 6);
}

/// 上下文装配必须用 letterbox 实际比值,并在退化窗口下给出确定性 1:1。
#[test]
fn context_uses_letterbox_ratio() {
    let list = fixture();
    let content = Deep2dRuntimeContent::DisplayList(list.clone());
    let context = deep2d_frame_context(&content, [1280, 720], 3);
    assert_eq!(context.resource_epoch, 3);
    let expected = LetterboxMapping::new(
        [list.logical_width, list.logical_height],
        [1280.0, 720.0],
    )
    .scale;
    assert!((context.camera_scale - expected).abs() < 1e-12);
}

/// 真实窗口尺寸下(逻辑 480x320 内容 + 960x640 物理像素)上下文必须给出 2.0。
/// 这条锁定「DPI 真的进了依赖图」:若有人把 camera_scale 写死 1.0,这里立刻失败。
#[test]
fn real_dpi_reaches_the_dependency_graph() {
    let mut list = fixture();
    list.logical_width = 480.0;
    list.logical_height = 320.0;
    let context = deep2d_frame_context(&Deep2dRuntimeContent::DisplayList(list.clone()), [960, 640], 0);
    assert!((context.camera_scale - 2.0).abs() < 1e-12);

    // 该上下文喂进缓存后,必须真的按 2.0 细分:与 1.0 的产物不同。
    let one = scaled(&list, 1.0);
    let two = scaled(&list, context.camera_scale);
    assert_ne!(
        one.vertices.len(),
        two.vertices.len(),
        "落进真实 DPI 的上下文必须改变细分产物"
    );
}

/// 非等比窗口:实际缩放取 letterbox 的最小比值,而不是任一方向的标称 DPI。
#[test]
fn non_uniform_window_uses_the_letterbox_minimum() {
    let mut list = fixture();
    list.logical_width = 640.0;
    list.logical_height = 360.0;
    let content = Deep2dRuntimeContent::DisplayList(list);
    // 宽高比 2.0 对 1.0:物理 1280x1080 时最小比值是 2.0(而不是 3.0)。
    let context = deep2d_frame_context(&content, [1280, 1080], 0);
    assert!((context.camera_scale - 2.0).abs() < 1e-12);
    // 物理 640x1080 时最小比值是 1.0。
    let squeezed = deep2d_frame_context(&content, [640, 1080], 0);
    assert!((squeezed.camera_scale - 1.0).abs() < 1e-12);
}