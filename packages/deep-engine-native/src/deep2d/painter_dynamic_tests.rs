//! 刀 3 动态路径分路的 CPU 测试族:滑窗判定(阈值/冷启动/自动退静态)、
//! fence 几何、路由正确性(静态缓存 vs stencil)、资格回落(剪刀)、
//! fill-rule 语义、fill+stroke 拆分、composite 层偏移,以及与 CPU oracle
//! (`rasterize_prepared` 的 dynamic 分支)的逐像素对拍——GPU 侧共享同一
//! oracle,静态帧回归由 `deep2d_paint_gpu_tests` 既有族覆盖。
use super::*;
use crate::deep2d::{
    Deep2dCommand, Deep2dDisplayList, Deep2dPaint, Deep2dPathCache, Deep2dPathVerb, Deep2dRect,
    Deep2dResource, Deep2dRuntimeContent, FillRule, PathCommand, PathResource,
    prepare_display_list_cached, prepare_runtime_content_cached, rasterize_prepared,
};

// ---- fixtures ----

fn ring_resource(id: &str, min: [f64; 2], size: f64) -> PathResource {
    PathResource {
        id: id.into(),
        revision: 1,
        verbs: vec![
            Deep2dPathVerb::Move {
                x: min[0],
                y: min[1],
            },
            Deep2dPathVerb::Line {
                x: min[0] + size,
                y: min[1],
            },
            Deep2dPathVerb::Line {
                x: min[0] + size,
                y: min[1] + size,
            },
            Deep2dPathVerb::Line {
                x: min[0],
                y: min[1] + size,
            },
            Deep2dPathVerb::Close,
        ],
    }
}

/// 单资源双子环(外环 + 内环,同向),供 donut 的 nonzero/evenodd 语义对比
/// 与静态冷启动的 bridged-ring 路径。
fn donut_resource() -> PathResource {
    let mut verbs = vec![
        Deep2dPathVerb::Move { x: 2.0, y: 2.0 },
        Deep2dPathVerb::Line { x: 10.0, y: 2.0 },
        Deep2dPathVerb::Line { x: 10.0, y: 10.0 },
        Deep2dPathVerb::Line { x: 2.0, y: 10.0 },
        Deep2dPathVerb::Close,
        Deep2dPathVerb::Move { x: 4.0, y: 4.0 },
        Deep2dPathVerb::Line { x: 8.0, y: 4.0 },
        Deep2dPathVerb::Line { x: 8.0, y: 8.0 },
        Deep2dPathVerb::Line { x: 4.0, y: 8.0 },
        Deep2dPathVerb::Close,
    ];
    verbs.shrink_to_fit();
    PathResource {
        id: "ring".into(),
        revision: 1,
        verbs,
    }
}

fn fill_command(
    id: &str,
    z_order: i32,
    path_id: &str,
    fill_rule: Option<FillRule>,
) -> Deep2dCommand {
    Deep2dCommand::Path(PathCommand {
        id: id.into(),
        z_order,
        transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        opacity: None,
        clip_path_ids: None,
        clip_rect: None,
        hit_id: None,
        path_id: path_id.into(),
        fill: Some(Deep2dPaint::Solid([1.0, 0.0, 0.0, 1.0])),
        fill_rule,
        stroke: None,
        stroke_width: None,
        line_cap: None,
        line_join: None,
        miter_limit: None,
        dash: None,
        dash_offset: None,
        corner_radius: None,
        shadow: None,
        blend: None,
        backdrop_blur: None,
    })
}

fn display_list(resources: Vec<PathResource>, commands: Vec<Deep2dCommand>) -> Deep2dDisplayList {
    Deep2dDisplayList {
        schema_version: 1,
        id: "deep2d-dynamic-cpu".into(),
        revision: 1,
        logical_width: 16.0,
        logical_height: 16.0,
        scale_factor: 1.0,
        resources: resources.into_iter().map(Deep2dResource::Path).collect(),
        atlases: Vec::new(),
        commands,
    }
}

/// 把资源列表的全部动词 x 平移 `delta`(模拟逐帧动画)。
fn shift_x(list: &mut Deep2dDisplayList, delta: f64) {
    for resource in &mut list.resources {
        let Deep2dResource::Path(path) = resource else {
            panic!("path resource");
        };
        for verb in &mut path.verbs {
            if let Deep2dPathVerb::Line { x, .. } | Deep2dPathVerb::Move { x, .. } = verb {
                *x += delta;
            }
        }
    }
    list.revision += 1;
}

/// 推进到动态路由:冷启动后连续变更直到滑窗达到阈值,返回动态帧产物。
fn prepare_dynamic_donut(fill_rule: Option<FillRule>) -> crate::deep2d::PreparedDeep2d {
    let mut list = display_list(
        vec![donut_resource()],
        vec![fill_command("draw", 0, "ring", fill_rule)],
    );
    let mut cache = Deep2dPathCache::default();
    let _ = prepare_display_list_cached(&list, &mut cache).expect("cold");
    for _ in 0..DYNAMIC_CHANGES_THRESHOLD {
        shift_x(&mut list, 0.5);
        let _ = prepare_display_list_cached(&list, &mut cache).expect("warm");
    }
    let prepared = prepare_display_list_cached(&list, &mut cache).expect("dynamic");
    assert_eq!(
        prepared.summary.dynamic_commands, 1,
        "precondition: this frame must be on the stencil route"
    );
    prepared
}

fn prepared_cached(
    list: &Deep2dDisplayList,
    cache: &mut Deep2dPathCache,
) -> crate::deep2d::PreparedDeep2d {
    prepare_display_list_cached(list, cache).expect("prepare")
}

// ---- 判定器 ----

#[test]
fn tracker_needs_threshold_changes_and_cold_start_is_not_a_change() {
    let mut tracker = DynamicPathTracker::default();
    // 冷启动 + 2 次变更:不判动态(阈值 3)。
    assert!(
        !tracker.observe("p", 1),
        "cold start must not count as a change"
    );
    assert!(!tracker.observe("p", 2));
    assert!(
        !tracker.observe("p", 2),
        "identical content is not a change"
    );
    assert!(!tracker.observe("p", 3), "2 changes stay static");
    assert!(
        tracker.observe("p", 4),
        "3 changes in window become dynamic"
    );
    assert!(tracker.is_dynamic("p"));
    // 滑窗无迟滞:旧变更滑出 8 帧窗口、计数跌破阈值即退回静态。
    // 窗口未满时稳定帧只稀释不淘汰,需要数个稳定帧才跌破阈值。
    let mut demoted_at = None;
    for frame in 0..DYNAMIC_WINDOW_FRAMES {
        if !tracker.observe("p", 4) {
            demoted_at = Some(frame);
            break;
        }
    }
    assert_eq!(
        demoted_at.map(|frame| frame < DYNAMIC_WINDOW_FRAMES),
        Some(true),
        "stable frames flush the window and demote within its bound"
    );
    // 新变更再次越过阈值:窗口内重新动态。
    assert!(tracker.observe("p", 5), "window re-crosses the threshold");
}

#[test]
fn tracker_windows_are_per_command() {
    let mut tracker = DynamicPathTracker::default();
    for frame in 0..4 {
        tracker.observe("a", frame);
    }
    assert!(tracker.is_dynamic("a"));
    assert!(!tracker.is_dynamic("b"), "ids are independent");
}

// ---- fence 几何 ----

#[test]
fn fence_covers_every_edge_with_bbox_and_vertical_extrusion() {
    let resource = ring_resource("p", [2.0, 3.0], 4.0);
    let linear = LinearPath::from_resource(
        &resource,
        "resources[0]",
        "commands[0]",
        [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        1.0,
    )
    .expect("linear");
    let fence = dynamic_fence(&linear, &[1.0, 0.0, 0.0, 1.0, 0.0, 0.0]).expect("fence");
    assert_eq!(fence.edge_count, 4, "closing edge included");
    assert_eq!(fence.edges.len(), fence.edge_count * VERTICES_PER_EDGE);
    assert_eq!(
        fence.bbox,
        [2.0, 3.0, 4.0, 4.0],
        "bbox from transformed points"
    );
    // 挤出点 = [x, +EXTRUDE_Y]:每个 6 顶点组是 (a, b, b_up) + (a, b_up, a_up)。
    let edge = &fence.edges[0..6];
    assert_eq!(edge[3][0], edge[0][0], "a_up shares a.x");
    assert_eq!(edge[4], edge[2], "shared diagonal vertex b_up");
    assert!(
        edge[2][1] > 1.0e6,
        "extrusion must reach far past any visible canvas"
    );
}

#[test]
fn dynamic_budget_gates_stay_consistent_with_static_limits() {
    // 单命令 fence 预算必须覆盖静态细分点上限(≤512 点的环回落静态总能成功),
    // 帧预算必须覆盖单命令预算。
    const {
        assert!(
            MAX_DYNAMIC_FILL_EDGES_PER_COMMAND
                >= super::super::painter_polygon::MAX_SIMPLE_POLYGON_POINTS
        )
    };
    const { assert!(MAX_DYNAMIC_FILL_EDGES_TOTAL >= MAX_DYNAMIC_FILL_EDGES_PER_COMMAND) };
    assert_eq!(VERTICES_PER_EDGE, 6);
}

#[test]
fn stencil_route_serves_rings_beyond_the_static_tessellation_budget() {
    // 501 点梳状(简单)多边形:接近静态细分点上限(512)的稠密环,
    // stencil 路只需边带,验证稠密几何也能走动态路由。
    let comb = |offset: f64| {
        let teeth = 250usize;
        let mut verbs = Vec::with_capacity(teeth * 2 + 4);
        verbs.push(Deep2dPathVerb::Move { x: offset, y: 2.0 });
        for index in 0..teeth {
            // 梳齿顶取半整数:避开 x=0 竖线与闭合边共线/重叠。
            verbs.push(Deep2dPathVerb::Line {
                x: offset + f64::from(index as u16) + 0.5,
                y: 6.0,
            });
            verbs.push(Deep2dPathVerb::Line {
                x: offset + f64::from(index as u16 + 1),
                y: 2.0,
            });
        }
        verbs.push(Deep2dPathVerb::Line {
            x: offset + f64::from(teeth as u16),
            y: 12.0,
        });
        verbs.push(Deep2dPathVerb::Line { x: offset, y: 12.0 });
        verbs.push(Deep2dPathVerb::Close);
        PathResource {
            id: "comb".into(),
            revision: 1,
            verbs,
        }
    };
    let mut list = display_list(vec![comb(0.0)], vec![fill_command("draw", 0, "comb", None)]);
    list.logical_width = 400.0;
    list.logical_height = 16.0;
    let mut cache = Deep2dPathCache::default();
    let _ = prepare_display_list_cached(&list, &mut cache).expect("cold static");
    for _ in 0..DYNAMIC_CHANGES_THRESHOLD {
        shift_x(&mut list, 0.5);
        let _ = prepare_display_list_cached(&list, &mut cache).expect("warm");
    }
    let prepared = prepare_display_list_cached(&list, &mut cache).expect("dynamic");
    assert_eq!(prepared.summary.dynamic_commands, 1);
    assert_eq!(
        prepared.summary.dynamic_edges, prepared.summary.path_segments,
        "fence edge count equals flattened segments (closing edges included)"
    );
    // 物理 512×32(logical 400×16 → scale 1.28):梳齿之间大量内部像素填红。
    let pixels = rasterize_prepared([400.0, 16.0], [512, 32], &prepared);
    let filled = pixels.iter().filter(|pixel| pixel[0] > 0).count();
    assert!(
        filled > 256,
        "comb interior fills on the stencil route: {filled}"
    );
}

// ---- 路由正确性 ----

#[test]
fn static_content_stays_on_the_cached_route() {
    let list = display_list(
        vec![ring_resource("p", [2.0, 2.0], 4.0)],
        vec![fill_command("draw", 0, "p", None)],
    );
    let mut cache = Deep2dPathCache::default();
    for frame in 0..DYNAMIC_WINDOW_FRAMES + 2 {
        let prepared = prepared_cached(&list, &mut cache);
        assert_eq!(
            prepared.summary.dynamic_commands, 0,
            "frame {frame}: identical content never routes dynamic"
        );
        assert!(prepared.dynamic_chunks.is_empty());
        assert_eq!(prepared.summary.dynamic_fallbacks, 0);
    }
    assert_eq!(
        cache.stats().hits,
        (DYNAMIC_WINDOW_FRAMES + 1) as u64,
        "warm cache"
    );
}

#[test]
fn changing_content_routes_to_stencil_after_threshold_frames() {
    let base = display_list(
        vec![ring_resource("p", [2.0, 2.0], 4.0)],
        vec![fill_command("draw", 0, "p", None)],
    );
    let mut cache = Deep2dPathCache::default();
    let _ = prepared_cached(&base, &mut cache);
    let mut list = base.clone();
    // 阈值之内的变更帧保持静态。
    for frame in 1..DYNAMIC_CHANGES_THRESHOLD {
        shift_x(&mut list, 0.25);
        let prepared = prepared_cached(&list, &mut cache);
        assert_eq!(
            prepared.summary.dynamic_commands, 0,
            "frame {frame}: below threshold stays static"
        );
    }
    // 第 3 次变更:本帧即走 stencil。
    shift_x(&mut list, 0.25);
    let prepared = prepared_cached(&list, &mut cache);
    assert_eq!(prepared.summary.dynamic_commands, 1);
    assert_eq!(prepared.summary.dynamic_edges, 4, "one square = 4 edges");
    assert_eq!(prepared.dynamic_chunks.len(), 1);
    assert!(
        prepared.chunks.is_empty(),
        "fill is no longer CPU tessellated"
    );
    // runtime chunk 合并保留 DynamicPath 类型。
    let runtime =
        prepare_runtime_content_cached(&Deep2dRuntimeContent::DisplayList(list), &mut cache)
            .expect("runtime");
    let dynamic = runtime
        .chunks
        .iter()
        .filter(|chunk| {
            matches!(
                chunk.kind,
                crate::deep2d::PreparedDeep2dChunkKind::DynamicPath { .. }
            )
        })
        .count();
    assert_eq!(dynamic, 1, "runtime chunks carry the dynamic block");
}

#[test]
fn demotion_returns_to_the_cached_route() {
    let list_at = |frame: f64| {
        display_list(
            vec![ring_resource("p", [2.0 + frame, 2.0], 4.0)],
            vec![fill_command("draw", 0, "p", None)],
        )
    };
    let mut cache = Deep2dPathCache::default();
    let _ = prepared_cached(&list_at(0.0), &mut cache);
    for frame in 1..=DYNAMIC_CHANGES_THRESHOLD {
        let _ = prepared_cached(&list_at(frame as f64), &mut cache);
    }
    // 内容定格:滑窗内旧变更滑出后自动退回静态(无迟滞)。
    let mut dynamic_frames = 0;
    let mut demoted = false;
    for _ in 0..DYNAMIC_WINDOW_FRAMES {
        let prepared = prepared_cached(&list_at(50.0), &mut cache);
        if prepared.summary.dynamic_commands == 1 {
            dynamic_frames += 1;
        } else {
            demoted = true;
            assert_eq!(
                prepared.summary.dynamic_fallbacks, 0,
                "demotion is not a fallback"
            );
            assert_eq!(prepared.chunks.len(), 1, "tessellated fill is back");
        }
    }
    assert!(dynamic_frames >= 1, "hot window keeps routing dynamic");
    assert!(demoted, "quiet window demotes back to static");
    let warm = prepared_cached(&list_at(50.0), &mut cache);
    assert_eq!(
        warm.summary.dynamic_commands, 0,
        "stays static once the window is quiet"
    );
}

#[test]
fn clip_path_candidates_fall_back_and_are_counted() {
    let mut list = display_list(
        vec![
            ring_resource("p", [2.0, 2.0], 4.0),
            ring_resource("clip", [0.0, 0.0], 8.0),
        ],
        vec![Deep2dCommand::Path({
            let mut command = match fill_command("draw", 0, "p", None) {
                Deep2dCommand::Path(command) => command,
                other => panic!("path command expected, got {other:?}"),
            };
            command.clip_path_ids = Some(vec!["clip".into()]);
            command
        })],
    );
    let mut cache = Deep2dPathCache::default();
    let _ = prepared_cached(&list, &mut cache);
    let mut fallback_frames = 0;
    for frame in 0..DYNAMIC_CHANGES_THRESHOLD + 2 {
        shift_x(&mut list, 0.25);
        let prepared = prepared_cached(&list, &mut cache);
        assert!(
            prepared.dynamic_chunks.is_empty(),
            "no stencil block under polygon scissors (frame {frame})"
        );
        assert!(
            !prepared.chunks.is_empty(),
            "static tessellation serves the frame"
        );
        fallback_frames += usize::from(prepared.summary.dynamic_fallbacks == 1);
    }
    assert_eq!(
        fallback_frames, DYNAMIC_CHANGES_THRESHOLD,
        "frames above the change threshold are counted fallbacks"
    );
}

// ---- fill-rule 语义与 oracle 对拍 ----

#[test]
fn oracle_matches_expected_pixels_for_dynamic_donut() {
    // 动态帧最后 x 全体 +0.5×3 + 冷启动后 +1.5:
    // 外环 [2,10)+1.5 → [3.5,11.5);内环 [4,8)+1.5 → [5.5,9.5)。
    // 物理 1:2 映射(32×32),像素中心 (x+0.5)/2。
    let prepared = prepare_dynamic_donut(Some(FillRule::Evenodd));
    let pixels = rasterize_prepared([16.0, 16.0], [32, 32], &prepared);
    let pixel = |x: usize, y: usize| pixels[y * 32 + x];
    // 环带内部:逻辑 (4.5, 6.5) —— 外环内、内环 x 区间外 → 红。
    assert_eq!(pixel(9, 13), [255, 0, 0, 255], "ring band filled");
    // 内环洞中心:逻辑 (7.5, 7.5) → 空。
    assert_eq!(
        pixel(15, 15),
        [0, 0, 0, 0],
        "hole stays empty under evenodd"
    );
    // 外环外:空;挤出带只写 stencil 不写色。
    assert_eq!(pixel(0, 0), [0, 0, 0, 0]);
    assert_eq!(pixel(30, 30), [0, 0, 0, 0]);
}

#[test]
fn nonzero_and_evenodd_disagree_on_same_facing_hole() {
    let raster = |prepared| rasterize_prepared([16.0, 16.0], [32, 32], &prepared);
    let nonzero = raster(prepare_dynamic_donut(Some(FillRule::Nonzero)));
    let evenodd = raster(prepare_dynamic_donut(Some(FillRule::Evenodd)));
    let hole = |pixels: &[[u8; 4]]| pixels[15 * 32 + 15];
    // 同向环:nonzero 把洞判为 winding 2 ≠ 0 → 填;evenodd 挖空。
    assert_eq!(
        hole(&nonzero),
        [255, 0, 0, 255],
        "same-facing hole fills under nonzero"
    );
    assert_eq!(
        hole(&evenodd),
        [0, 0, 0, 0],
        "same-facing hole empties under evenodd"
    );
}

#[test]
fn fill_and_stroke_split_routes_for_dynamic_commands() {
    let mut list = display_list(
        vec![ring_resource("p", [2.0, 2.0], 4.0)],
        vec![Deep2dCommand::Path({
            let mut command = match fill_command("draw", 0, "p", None) {
                Deep2dCommand::Path(command) => command,
                other => panic!("path command expected, got {other:?}"),
            };
            command.stroke = Some([0.0, 0.0, 1.0, 1.0]);
            command.stroke_width = Some(1.0);
            command
        })],
    );
    let mut cache = Deep2dPathCache::default();
    let _ = prepare_display_list_cached(&list, &mut cache).expect("cold");
    for _ in 0..DYNAMIC_CHANGES_THRESHOLD {
        shift_x(&mut list, 0.5);
        let _ = prepare_display_list_cached(&list, &mut cache).expect("warm");
    }
    shift_x(&mut list, 0.5);
    let prepared = prepare_display_list_cached(&list, &mut cache).expect("dynamic");
    assert_eq!(prepared.summary.dynamic_commands, 1, "fill goes stencil");
    assert!(
        prepared.summary.stroke_triangles > 0,
        "stroke stays on the CPU outline route (documented scope)"
    );
    // 动态块 + 描边静态块并存;描边块会被绘制(runtime chunks 两条)。
    let runtime =
        prepare_runtime_content_cached(&Deep2dRuntimeContent::DisplayList(list), &mut cache)
            .expect("runtime");
    let dynamic = runtime
        .chunks
        .iter()
        .filter(|chunk| {
            matches!(
                chunk.kind,
                crate::deep2d::PreparedDeep2dChunkKind::DynamicPath { .. }
            )
        })
        .count();
    let static_path = runtime
        .chunks
        .iter()
        .filter(|chunk| matches!(chunk.kind, crate::deep2d::PreparedDeep2dChunkKind::Path))
        .count();
    assert_eq!(dynamic, 1);
    assert!(static_path >= 1, "stroke chunk survives the split");
}

#[test]
fn composite_layers_offset_dynamic_edges_and_chunks() {
    let layer_at = |frame: f64| crate::deep2d::Deep2dLayer {
        id: "layer-a".into(),
        content: std::sync::Arc::new(Deep2dRuntimeContent::DisplayList(display_list(
            vec![ring_resource("p", [1.0 + frame, 1.0], 4.0)],
            vec![fill_command("draw", 0, "p", None)],
        ))),
        translation: [10.0, 4.0],
        clip: Deep2dRect {
            x: 0.0,
            y: 0.0,
            width: 32.0,
            height: 32.0,
        },
    };
    let composite_at = |frame: f64| {
        crate::deep2d::Deep2dComposite::new("comp".into(), 1, [32.0, 32.0], vec![layer_at(frame)])
            .expect("composite")
    };
    let mut cache = Deep2dPathCache::default();
    let _ = prepare_runtime_content_cached(
        &Deep2dRuntimeContent::Composite(composite_at(0.0)),
        &mut cache,
    )
    .expect("cold");
    let mut prepared = None;
    for frame in 1..=DYNAMIC_CHANGES_THRESHOLD {
        prepared = Some(
            prepare_runtime_content_cached(
                &Deep2dRuntimeContent::Composite(composite_at(frame as f64)),
                &mut cache,
            )
            .expect("frame"),
        );
    }
    let prepared = prepared.unwrap();
    assert_eq!(
        prepared.path.summary.dynamic_commands, 1,
        "composite layers route dynamic too"
    );
    let chunk = prepared
        .chunks
        .iter()
        .find(|chunk| {
            matches!(
                chunk.kind,
                crate::deep2d::PreparedDeep2dChunkKind::DynamicPath { .. }
            )
        })
        .expect("dynamic chunk in composite");
    // fence 顶点被层平移:所有边顶点 x >= 10(层 translation)。
    let min_x = prepared
        .path
        .dynamic_edges
        .iter()
        .fold(f32::INFINITY, |min, edge| min.min(edge[0]));
    assert!(
        min_x >= 10.0,
        "layer translation must shift fence vertices (min_x={min_x})"
    );
    let crate::deep2d::PreparedDeep2dChunkKind::DynamicPath {
        edge_first,
        edge_count,
        ..
    } = chunk.kind
    else {
        panic!("dynamic kind");
    };
    assert_eq!(
        edge_first as usize + edge_count as usize,
        prepared.path.dynamic_edges.len(),
        "composite edge range covers the whole fence"
    );
    // 层 clip scissor 已合入动态块。
    assert!(chunk.clip_rect.is_some());
}
