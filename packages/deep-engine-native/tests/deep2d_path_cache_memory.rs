//! P1-07 内存实测:用 GlobalAlloc 计数 wrapper 测量缓存条目的真实堆驻留与峰值,
//! 对照 `payload_bytes` 记账给出偏差;并量化细分顶点在 LRU 条目与 vertex shadow
//! (deep2d_vertex_transfer 的 CPU shadow)之间的重复持有。
//! 本文件只有一个 #[test]:测量期内不允许其他测试线程的分配污染计数差分。
use deep_engine_native::deep2d::*;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering::Relaxed};

static ALLOC_BYTES: AtomicU64 = AtomicU64::new(0);
static DEALLOC_BYTES: AtomicU64 = AtomicU64::new(0);
static ALLOCS: AtomicU64 = AtomicU64::new(0);
static PEAK: AtomicI64 = AtomicI64::new(0);

struct Counting;
#[global_allocator]
static HEAP: Counting = Counting;
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            charge(layout.size());
        }
        ptr
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        DEALLOC_BYTES.fetch_add(layout.size() as u64, Relaxed);
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let out = unsafe { System.realloc(ptr, layout, new_size) };
        if !out.is_null() {
            DEALLOC_BYTES.fetch_add(layout.size() as u64, Relaxed);
            charge(new_size);
        }
        out
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc_zeroed(layout) };
        if !ptr.is_null() {
            charge(layout.size());
        }
        ptr
    }
}
/// fetch_add 返回旧值,加上本次大小才是分配后的 current,直接喂给峰值监视。
fn charge(size: usize) {
    let added = ALLOC_BYTES.fetch_add(size as u64, Relaxed) as i64 + size as i64;
    let current = added - DEALLOC_BYTES.load(Relaxed) as i64;
    PEAK.fetch_max(current, Relaxed);
    ALLOCS.fetch_add(1, Relaxed);
}

fn current() -> i64 {
    ALLOC_BYTES.load(Relaxed) as i64 - DEALLOC_BYTES.load(Relaxed) as i64
}

#[derive(Debug)]
struct Sample {
    retained: i64,
    peak: i64,
    allocs: u64,
}

/// 把峰值基线重置到当前水位,返回测量起点。
fn mark() -> i64 {
    PEAK.store(current(), Relaxed);
    current()
}
fn sample(base: i64) -> Sample {
    Sample {
        retained: current() - base,
        peak: PEAK.load(Relaxed) - base,
        allocs: ALLOCS.load(Relaxed),
    }
}

fn fixture() -> Deep2dDisplayList {
    decode_display_list(include_bytes!("../fixtures/deep2d_tessellated_v1.json")).unwrap()
}
/// 与 spec 基准同构的 128 条曲线夹具:128 命令共享同一路径资源。
fn curve_fixture() -> Deep2dDisplayList {
    let mut list = fixture();
    let curve = match list.commands[2].clone() {
        Deep2dCommand::Path(path) => path,
        _ => unreachable!(),
    };
    list.commands = (0..128)
        .map(|i| {
            let mut command = curve.clone();
            command.id = format!("curve-{i}");
            command.z_order = i;
            command.transform[4] = i as f64;
            Deep2dCommand::Path(command)
        })
        .collect();
    list
}

#[test]
fn cache_heap_residency_peak_and_duplicate_vertices_are_measured() {
    let list = curve_fixture();
    let stride = std::mem::size_of::<[f32; 6]>();

    // 正确性护栏:缓存路径与无缓存路径逐字段一致;首次全 miss,再次全 hit。
    let reference = prepare_display_list(&list).unwrap();
    let mut warm = Deep2dPathCache::default();
    assert_eq!(
        prepare_display_list_cached(&list, &mut warm).unwrap(),
        reference
    );
    assert_eq!(warm.stats().misses, 128);
    assert_eq!(
        prepare_display_list_cached(&list, &mut warm).unwrap(),
        reference
    );
    assert_eq!(warm.stats().hits, 128);
    drop(warm);

    let frame_vertices = reference.vertices.len();
    let frame_vertex_bytes = frame_vertices * stride;
    let frame_vertex_capacity_bytes = reference.vertices.capacity() * stride;
    drop(reference);

    // 阶段 U:无缓存细分,只留输出。
    let base_u = mark();
    let uncached = prepare_display_list(&list).unwrap();
    let phase_u = sample(base_u);
    drop(uncached);
    let after_output_drop = current();

    // 阶段 C:冷缓存构建;输出释放后剩下的就是缓存条目的真实堆驻留。
    let mut cache = Deep2dPathCache::default();
    let base_c = mark();
    let cached = prepare_display_list_cached(&list, &mut cache).unwrap();
    let phase_c = sample(base_c);
    let stats = cache.stats();
    drop(cached);
    let cache_retained = current() - after_output_drop;
    let cache_peak_of_phase = phase_c.peak;
    drop(cache);
    assert_eq!(
        current(),
        after_output_drop,
        "缓存整体释放后堆水位应回到只持输出的基线"
    );

    // 确定性复核:同输入再跑一次冷构建,驻留字节数必须逐字节一致。
    // (分配"次数"受 HashMap 随机种子影响不保证一致,只作参考值纳入报告。)
    let mut cache = Deep2dPathCache::default();
    let base_r = mark();
    let again = prepare_display_list_cached(&list, &mut cache).unwrap();
    let phase_r = sample(base_r);
    drop(again);
    assert_eq!(
        current() - after_output_drop,
        cache_retained,
        "两次冷构建驻留不一致"
    );

    // 重复驻留:全部命令都是可驻留路径时,缓存顶点字节 == 帧顶点字节;
    // shadow 捕获持有的是整帧连续顶点(≤8MiB 时),因此这部分字节同时存在两份。
    assert_eq!(stats.entries, 128);
    let cached_vertex_bytes = frame_vertex_bytes;
    let payload = stats.payload_bytes;
    let resource = match list.resources[2] {
        Deep2dResource::Path(ref path) => path,
        _ => unreachable!(),
    };
    let verb_size = std::mem::size_of::<Deep2dPathVerb>();
    let shared_resource_bytes_one =
        std::mem::size_of::<PathResource>() + resource.id.len() + resource.verbs.len() * verb_size;
    let report = serde_json::json!({
        "build": if cfg!(debug_assertions) { "debug" } else { "release" },
        "entries": stats.entries,
        "payloadEstimateBytes": payload,
        "measuredRetainedBytes": cache_retained,
        "deviationBytes": cache_retained - payload as i64,
        "deviationPct": (cache_retained - payload as i64) as f64 * 100.0 / payload as i64 as f64,
        "coldPhaseAllocs": phase_c.allocs,
        "repeatPhaseAllocs": phase_r.allocs,
        "coldPhasePeakBytes": cache_peak_of_phase,
        "uncachedPhaseRetainedBytes": phase_u.retained,
        "uncachedPhasePeakBytes": phase_u.peak,
        "peakExtraBytes": cache_peak_of_phase - phase_u.peak,
        "frameVertexCount": frame_vertices,
        "frameVertexBytes": frame_vertex_bytes,
        "frameVertexCapacityBytes": frame_vertex_capacity_bytes,
        "cachedVertexBytes": cached_vertex_bytes,
        "duplicateCacheVsShadowBytes": cached_vertex_bytes,
        "shadowCapBytes": 8 * 1024 * 1024,
        "cacheCapBytes": 8 * 1024 * 1024,
        "sharedResourceBytesOne": shared_resource_bytes_one,
        "verbSize": verb_size,
        "sharedResourceClones": stats.entries,
        "sharedResourceDuplicationBytes": shared_resource_bytes_one * (stats.entries - 1),
        "scope": "CPU heap via counting GlobalAlloc; shadow residency is structural (frame bytes held by VertexSnapshot), capture cost belongs to the GPU lane",
    });
    println!("path cache heap measurement: {report}");
    let ratio = cache_retained as f64 / payload as i64 as f64;
    assert!(
        ratio > 0.8 && ratio < 3.0,
        "实测驻留/记账载荷 = {ratio:.3},超出合理容器开销区间,需排查"
    );
    assert!(cache_retained > 0);
}
