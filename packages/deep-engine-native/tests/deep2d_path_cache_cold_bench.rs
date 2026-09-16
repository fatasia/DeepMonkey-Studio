//! P1-07 冷启动拆解:无缓存/冷缓存/热缓存中位耗时之外,再对"缓存写入"的组成
//! (顶点拷贝、style 克隆、resource 克隆、store 记账)分别计时,把冷构建相对
//! 无缓存的增量分解到组件,而不是只报告一个总差值。
//! 仅 Release 显式运行:
//! cargo test --release --locked --manifest-path packages/deep-engine-native/Cargo.toml --test deep2d_path_cache_cold_bench -- --ignored --nocapture
use deep_engine_native::deep2d::*;
use std::{hint::black_box, time::Instant};

fn fixture() -> Deep2dDisplayList {
    decode_display_list(include_bytes!("../fixtures/deep2d_tessellated_v1.json")).unwrap()
}
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

fn median(samples: &mut [f64]) -> f64 {
    samples.sort_by(f64::total_cmp);
    samples[samples.len() / 2]
}

fn time_ms<F: FnMut()>(reps: usize, mut run: F) -> f64 {
    let mut samples = Vec::new();
    for _ in 0..reps {
        let start = Instant::now();
        run();
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    median(&mut samples)
}

#[test]
#[ignore = "explicit Release CPU benchmark"]
fn cold_start_overhead_breakdown() {
    let list = curve_fixture();
    let uncached_frame = prepare_display_list(&list).unwrap();
    let mut cache = Deep2dPathCache::default();
    assert_eq!(
        prepare_display_list_cached(&list, &mut cache).unwrap(),
        uncached_frame
    );
    let stats = cache.stats();

    // 与既有 benchmark_path_cache_partial_change 同一方法学:25 轮 × 3 模式交错,
    // 预热 5 轮、每模式采样 20 组取中位。
    let mut samples = [Vec::new(), Vec::new(), Vec::new()];
    for round in 0..25 {
        for offset in 0..3 {
            let mode = (round + offset) % 3;
            let start = Instant::now();
            let result = match mode {
                0 => prepare_display_list(&list).unwrap(),
                1 => prepare_display_list_cached(&list, &mut Deep2dPathCache::default()).unwrap(),
                _ => prepare_display_list_cached(&list, &mut cache).unwrap(),
            };
            black_box(result);
            if round >= 5 {
                samples[mode].push(start.elapsed().as_secs_f64() * 1000.0);
            }
        }
    }
    let [uncached_ms, cold_ms, warm_ms] = samples.map(|mut s| median(&mut s));

    // 组件 1:顶点拷贝 —— 与缓存插入逐路径一致:每个 chunk 独立 to_vec(独立分配+memcpy)。
    // black_box 引用让内容逃逸,防止 LLVM 消除 memcpy 只留 len。
    let vertices_ms = time_ms(40, || {
        let mut total = 0usize;
        for chunk in &uncached_frame.chunks {
            let range = chunk.first_vertex as usize
                ..chunk.first_vertex as usize + chunk.vertex_count as usize;
            let copy = uncached_frame.vertices[range].to_vec();
            total += black_box(&copy).len();
        }
        black_box(total);
    });
    // 组件 2:style 克隆(含命中键清洗:清空 id/z_order/hit_id/clip_rect)。
    let styles: Vec<PathCommand> = list
        .commands
        .iter()
        .filter_map(|command| match command {
            Deep2dCommand::Path(path) => Some(path.clone()),
            _ => None,
        })
        .collect();
    let style_ms = time_ms(40, || {
        let mut total = 0usize;
        for command in &styles {
            let mut style = command.clone();
            style.id = String::new();
            style.z_order = 0;
            style.hit_id = None;
            style.clip_rect = None;
            total += std::mem::size_of_val(&style);
        }
        black_box(total);
    });
    // 组件 3:resource 克隆(128 条命令共享同一路径资源,缓存每条各存一份含 verbs 的完整克隆)。
    let resource = match list.resources[2] {
        Deep2dResource::Path(ref path) => path.clone(),
        _ => unreachable!(),
    };
    let resource_ms = time_ms(40, || {
        let mut total = 0usize;
        for _ in 0..styles.len() {
            let clone = resource.clone();
            total += clone.verbs.len();
        }
        black_box(total);
    });
    // 组件 4:store 记账 —— HashMap 插入 + 有序 LRU 索引插入(与 store 相同的两次容器写入和 id 克隆)。
    let store_ms = time_ms(40, || {
        let mut entries = std::collections::HashMap::new();
        let mut order = std::collections::BTreeSet::new();
        for tick in 0..styles.len() as u64 {
            let id = format!("curve-{tick}");
            entries.insert(id.clone(), tick as usize);
            order.insert((tick, id));
        }
        black_box((entries.len(), order.len()));
    });

    let cold_extra = cold_ms - uncached_ms;
    let components = vertices_ms + style_ms + resource_ms + store_ms;
    // 噪声底:同一无缓存路径再测一批,两次中位之差即为计时噪声的量级下界。
    let uncached_repeat_ms = time_ms(20, || {
        black_box(prepare_display_list(&list).unwrap());
    });
    let noise_floor = (uncached_repeat_ms - uncached_ms).abs();
    println!(
        "cold start breakdown: {}",
        serde_json::json!({
            "build": if cfg!(debug_assertions) { "debug" } else { "release" },
            "commands": list.commands.len(), "warmup": 5, "samples": 20,
            "uncachedMedianMs": uncached_ms, "coldCacheMedianMs": cold_ms, "warmCacheMedianMs": warm_ms,
            "uncachedRepeatMedianMs": uncached_repeat_ms, "noiseFloorMs": noise_floor,
            "coldExtraMs": cold_extra,
            "verticesCopyMs": vertices_ms, "styleCloneMs": style_ms,
            "resourceCloneMs": resource_ms, "storeBookkeepingMs": store_ms,
            "componentsSumMs": components, "closureGapMs": cold_extra - components,
            "cacheEntries": stats.entries, "cachePayloadBytes": stats.payload_bytes,
            "scope": "CPU only: display-list validation and path tessellation plus cache insertion; vertex shadow capture is the GPU lane and is not in these numbers",
        })
    );
    assert_eq!(cache.stats().entries, 128);
}
