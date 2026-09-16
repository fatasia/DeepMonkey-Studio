//! P1-11 CPU rows of the cache-failure/clip matrix. Every cell name
//! (r{row}_c{col}) points at exactly one invalidation/clip combination: each
//! test drives `prepare_runtime_content_cached` against the uncached
//! reference on the shared mixed-content carrier, so a red run names both
//! the cell and the diverging input. GPU row r3 lives in
//! `deep2d_mixed_content_gpu_matrix.rs`.

use deep_engine_native::deep2d::{
    BakedGlyphPlacement, Deep2dAtlas, Deep2dAtlasFormat, Deep2dAtlasKind, Deep2dCommand,
    Deep2dDisplayList, Deep2dPathCache, Deep2dPathVerb, Deep2dRect, Deep2dResource,
    Deep2dRuntimeContent, FontResource, FontStyle, ImageColorSpace, ImageCommand, ImageResource,
    ImageSampling, LineCap, PathCommand, PathResource, TextCommand, prepare_runtime_content,
    prepare_runtime_content_cached,
};

/// Mixed-content carrier: white nonuniform-scaled scissor-clipped path (z0),
/// red|blue image-atlas quad (z1), green glyph-atlas quad (z2).
const ORIGINAL_TILES: &str = "/wAA/wAA//8="; // pixel0 red, pixel1 blue
const SWAPPED_TILES: &str = "AAD///8AAP8="; // pixel0 blue, pixel1 red

fn rect_verbs(x: f64, y: f64, w: f64, h: f64) -> Vec<Deep2dPathVerb> {
    vec![
        Deep2dPathVerb::Move { x, y },
        Deep2dPathVerb::Line { x: x + w, y },
        Deep2dPathVerb::Line { x: x + w, y: y + h },
        Deep2dPathVerb::Line { x, y: y + h },
        Deep2dPathVerb::Close,
    ]
}

fn tiles_atlas(data: &str, revision: u64) -> Deep2dAtlas {
    Deep2dAtlas {
        id: "tiles".into(),
        revision,
        kind: Deep2dAtlasKind::Image,
        format: Deep2dAtlasFormat::Rgba8UnormSrgb,
        width: 2,
        height: 1,
        sampling: ImageSampling::Nearest,
        data_base64: data.into(),
    }
}

fn glyph_atlas() -> Deep2dAtlas {
    Deep2dAtlas {
        id: "glyphs".into(),
        revision: 1,
        kind: Deep2dAtlasKind::Glyph,
        format: Deep2dAtlasFormat::R8Unorm,
        width: 1,
        height: 1,
        sampling: ImageSampling::Nearest,
        data_base64: "/w==".into(),
    }
}

fn base_list() -> Deep2dDisplayList {
    Deep2dDisplayList {
        schema_version: 1,
        id: "p1-11-matrix".into(),
        revision: 1,
        logical_width: 10.0,
        logical_height: 10.0,
        scale_factor: 1.0,
        resources: vec![
            Deep2dResource::Path(PathResource {
                id: "frame".into(),
                revision: 1,
                verbs: rect_verbs(0.0, 0.0, 5.0, 8.0),
            }),
            Deep2dResource::Font(FontResource {
                id: "font:probe".into(),
                revision: 1,
                asset_id: "embedded:probe".into(),
                family: "Probe".into(),
                weight: 400,
                style: FontStyle::Normal,
            }),
            Deep2dResource::Image(ImageResource {
                id: "img".into(),
                revision: 1,
                asset_id: "asset:img".into(),
                width: 2,
                height: 1,
                color_space: ImageColorSpace::Srgb,
            }),
        ],
        commands: vec![
            Deep2dCommand::Path(PathCommand {
                id: "draw:frame".into(),
                z_order: 0,
                transform: [2.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                opacity: None,
                clip_path_ids: None,
                clip_rect: Some(Deep2dRect {
                    x: 0.0,
                    y: 0.0,
                    width: 8.0,
                    height: 10.0,
                }),
                hit_id: None,
                path_id: "frame".into(),
                fill: Some([1.0, 1.0, 1.0, 1.0]),
                fill_rule: None,
                stroke: None,
                stroke_width: None,
                line_cap: None,
                line_join: None,
                miter_limit: None,
                dash: None,
                dash_offset: None,
            }),
            Deep2dCommand::Image(ImageCommand {
                id: "draw:tile".into(),
                z_order: 1,
                transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                opacity: None,
                clip_path_ids: None,
                clip_rect: None,
                hit_id: None,
                image_id: "img".into(),
                x: 2.0,
                y: 0.0,
                width: 2.0,
                height: 8.0,
                atlas_id: Some("tiles".into()),
                source: Some([0, 0, 2, 1]),
                sampling: None,
            }),
            Deep2dCommand::Text(TextCommand {
                id: "draw:glyph".into(),
                z_order: 2,
                transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                opacity: None,
                clip_path_ids: None,
                clip_rect: None,
                hit_id: None,
                text: "A".into(),
                x: 8.0,
                y: 0.0,
                font_id: "font:probe".into(),
                font_size: 1.0,
                color: [0.0, 1.0, 0.0, 1.0],
                max_width: None,
                align: None,
                baseline: None,
                direction: None,
                atlas_id: Some("glyphs".into()),
                baked_glyphs: Some(vec![BakedGlyphPlacement {
                    cluster: 0,
                    source: [0, 0, 1, 1],
                    destination: [0.0, 0.0, 1.0, 8.0],
                }]),
            }),
        ],
        atlases: vec![glyph_atlas(), tiles_atlas(ORIGINAL_TILES, 1)],
    }
}

fn content(list: &Deep2dDisplayList) -> Deep2dRuntimeContent {
    Deep2dRuntimeContent::DisplayList(list.clone())
}

/// One matrix cell: cached prepare must equal the uncached reference, or the
/// cell name names the divergence.
fn cell(
    label: &str,
    list: &Deep2dDisplayList,
    cache: &mut Deep2dPathCache,
) -> deep_engine_native::deep2d::PreparedDeep2dRuntime {
    let reference = prepare_runtime_content(&content(list))
        .unwrap_or_else(|e| panic!("{label}: reference prepare failed: {e}"));
    let cached = prepare_runtime_content_cached(&content(list), cache)
        .unwrap_or_else(|e| panic!("{label}: cached prepare failed: {e}"));
    assert_eq!(
        cached, reference,
        "{label}: cached output diverged from uncached"
    );
    reference
}

// ---- R1: cache-failure matrix ----------------------------------------------

#[test]
fn r1_c1_atlas_pixel_change_rebuilds_data_without_evicting_paths() {
    let mut list = base_list();
    let mut cache = Deep2dPathCache::default();
    cell("r1_c1 cold", &list, &mut cache);
    list.atlases[1].revision += 1;
    list.atlases[1].data_base64 = SWAPPED_TILES.into();
    let prepared = cell("r1_c1 reload", &list, &mut cache);
    assert_eq!(
        prepared.atlases[1].data,
        vec![0, 0, 255, 255, 255, 0, 0, 255],
        "r1_c1: stale atlas bytes"
    );
    let misses = cache.stats().misses;
    cell("r1_c1 warm", &list, &mut cache);
    assert_eq!(
        cache.stats().misses,
        misses,
        "r1_c1: atlas change must not evict path entries"
    );
}

#[test]
fn r1_c2_revision_bump_with_same_geometry_still_hits() {
    let mut list = base_list();
    let mut cache = Deep2dPathCache::default();
    cell("r1_c2 cold", &list, &mut cache);
    list.revision += 1;
    if let Deep2dCommand::Path(path) = &mut list.commands[0] {
        path.transform = [2.0, 0.0, 0.0, 1.0, 0.0, 0.0];
    }
    let (misses, hits) = {
        let s = cache.stats();
        (s.misses, s.hits)
    };
    cell("r1_c2 warm", &list, &mut cache);
    let stats = cache.stats();
    assert_eq!(
        (stats.misses, stats.hits),
        (misses, hits + 1),
        "r1_c2: pure revision bump must hit"
    );
}

#[test]
fn r1_c3_geometry_change_with_any_revision_misses() {
    let mut list = base_list();
    let mut cache = Deep2dPathCache::default();
    cell("r1_c3 cold", &list, &mut cache);
    list.resources[0] = Deep2dResource::Path(PathResource {
        id: "frame".into(),
        revision: 1,
        verbs: rect_verbs(0.0, 0.0, 4.0, 8.0),
    });
    cell("r1_c3 verbs-only", &list, &mut cache);
    assert_eq!(
        cache.stats().misses,
        2,
        "r1_c3: changed verbs with stale revision must miss"
    );
    list.resources[0] = Deep2dResource::Path(PathResource {
        id: "frame".into(),
        revision: 99,
        verbs: rect_verbs(0.0, 0.0, 3.0, 8.0),
    });
    cell("r1_c3 verbs+revision", &list, &mut cache);
    assert_eq!(
        cache.stats().misses,
        3,
        "r1_c3: changed verbs with bumped revision must miss"
    );
}

#[test]
fn r1_c4_same_id_style_change_misses_exactly_that_cell() {
    let changes: Vec<(&str, Box<dyn Fn(&mut PathCommand)>)> = vec![
        (
            "fill",
            Box::new(|c: &mut PathCommand| c.fill = Some([0.0, 0.0, 0.0, 1.0])),
        ),
        (
            "dash",
            Box::new(|c: &mut PathCommand| {
                c.stroke = Some([0.0, 0.0, 1.0, 1.0]);
                c.stroke_width = Some(0.25);
                c.dash = Some(vec![2.0, 1.0]);
                c.dash_offset = Some(0.5);
            }),
        ),
        (
            "stroke",
            Box::new(|c: &mut PathCommand| {
                c.stroke = Some([1.0, 0.0, 0.0, 1.0]);
                c.stroke_width = Some(0.25);
            }),
        ),
        (
            "transform",
            Box::new(|c: &mut PathCommand| c.transform = [2.0, 0.0, 0.0, 0.5, 0.0, 0.0]),
        ),
    ];
    for (name, change) in changes {
        let label = format!("r1_c4[{name}]");
        let mut list = base_list();
        let mut cache = Deep2dPathCache::default();
        cell(&label, &list, &mut cache);
        let Deep2dCommand::Path(path) = &mut list.commands[0] else {
            unreachable!()
        };
        change(path);
        cell(&label, &list, &mut cache);
        assert_eq!(
            cache.stats().misses,
            2,
            "{label}: exactly the restyled command must re-prepare"
        );
    }
}

#[test]
fn r1_c5_budget_eviction_recomputes_every_cell_when_over_budget() {
    let mut list = base_list();
    let Deep2dCommand::Path(mut frame) = list.commands[0].clone() else {
        unreachable!()
    };
    list.commands = (0..4097)
        .map(|i| {
            frame.id = format!("draw:frame-{i}");
            frame.z_order = i as i32;
            Deep2dCommand::Path(frame.clone())
        })
        .collect();
    let mut cache = Deep2dPathCache::default();
    cell("r1_c5 cold", &list, &mut cache);
    assert_eq!(
        (
            cache.stats().misses,
            cache.stats().evictions,
            cache.stats().entries
        ),
        (4097, 1, 4096),
        "r1_c5: budget insert evicts exactly the oldest"
    );
    // Sequential scans over a working set one entry over budget thrash the
    // LRU: every command misses and re-inserts, evicting the next victim.
    // The cell proves thrashing stays safe (identical geometry via `cell`)
    // and that recompute actually happens; single-victim order is pinned by
    // the painter_cache unit tests, which can shrink the budget directly.
    let before = cache.stats();
    cell("r1_c5 reload", &list, &mut cache);
    let after = cache.stats();
    assert_eq!(
        (after.hits - before.hits, after.misses - before.misses),
        (0, 4097),
        "r1_c5: over-budget working set must thrash, not poison"
    );
    assert_eq!(
        after.evictions - before.evictions,
        4097,
        "r1_c5: every recompute evicts the next LRU victim"
    );
}

#[test]
fn r1_c6_reload_same_list_is_full_hit_and_identical() {
    let list = base_list();
    let mut cache = Deep2dPathCache::default();
    let first = cell("r1_c6 cold", &list, &mut cache);
    for round in 1..=3 {
        let again = cell("r1_c6 reload", &list, &mut cache);
        assert_eq!(again, first, "r1_c6 round {round}: reload output drifted");
    }
    let stats = cache.stats();
    assert_eq!(
        (stats.hits, stats.misses),
        (3, 1),
        "r1_c6: reloads must all hit"
    );
}

#[test]
fn r1_c7_rejected_candidate_leaves_cache_untouched() {
    let list = base_list();
    let mut cache = Deep2dPathCache::default();
    cell("r1_c7 cold", &list, &mut cache);
    let before = cache.stats();
    let mut bad = base_list();
    bad.atlases[1].data_base64 = "AAAA".into();
    let error = prepare_runtime_content_cached(&content(&bad), &mut cache)
        .expect_err("r1_c7: short atlas payload must fail closed");
    assert!(error.contains("pixel data is"), "r1_c7: {error}");
    // Path preparation runs before atlas decode, so warm hits may advance;
    // misses/evictions/entries must not move — no poisoned entries.
    let after = cache.stats();
    assert_eq!(
        (
            after.misses,
            after.evictions,
            after.entries,
            after.payload_bytes
        ),
        (
            before.misses,
            before.evictions,
            before.entries,
            before.payload_bytes
        ),
        "r1_c7: failed candidate must not touch the cache"
    );
    cell("r1_c7 recover", &list, &mut cache);
    let after = cache.stats();
    assert_eq!(
        (
            after.misses,
            after.evictions,
            after.entries,
            after.payload_bytes
        ),
        (
            before.misses,
            before.evictions,
            before.entries,
            before.payload_bytes
        ),
        "r1_c7: post-failure reload must stay on cache"
    );
}

// ---- R2: deep clip matrix ---------------------------------------------------

fn nested_clips(list: &mut Deep2dDisplayList) {
    let names = ["a", "b", "c"];
    for (i, size) in [8.0, 6.0, 4.0].into_iter().enumerate() {
        list.resources.push(Deep2dResource::Path(PathResource {
            id: format!("clip-{}", names[i]),
            revision: 1,
            verbs: rect_verbs(0.0, 0.0, size, size),
        }));
    }
    if let Deep2dCommand::Path(path) = &mut list.commands[0] {
        // Geometric clip paths replace the scissor rect (contract: mutually
        // exclusive), so the scissor guard from the base carrier is dropped.
        path.clip_rect = None;
        path.clip_path_ids = Some(vec!["clip-a".into(), "clip-b".into(), "clip-c".into()]);
    }
}

#[test]
fn r2_c1_nested_clip_triple_bounds_vertices_to_innermost() {
    let mut list = base_list();
    nested_clips(&mut list);
    let mut cache = Deep2dPathCache::default();
    let prepared = cell("r2_c1", &list, &mut cache);
    assert!(
        prepared.summary.path.fill_triangles > 0,
        "r2_c1: fill vanished"
    );
    for vertex in &prepared.path.vertices {
        let (x, y) = (vertex[0], vertex[1]);
        assert!(
            x.abs() <= 8.0 + 1e-3 && y.abs() <= 4.0 + 1e-3,
            "r2_c1: vertex ({x},{y}) escaped innermost clip"
        );
    }
    cell("r2_c1 warm", &list, &mut cache);
    assert_eq!(
        cache.stats().hits,
        1,
        "r2_c1: clipped entry must be cacheable"
    );
}

#[test]
fn r2_c2_clip_times_rotation_mirror_nonuniform_cells_prepare_and_hit() {
    let cells: Vec<(&str, [f64; 6])> = vec![
        ("rot90", [0.0, 1.0, -1.0, 0.0, 10.0, 0.0]),
        ("mirror-x", [-1.0, 0.0, 0.0, 1.0, 10.0, 0.0]),
        ("mirror-both", [-1.0, 0.0, 0.0, -1.0, 0.0, 0.0]),
        ("nonuniform", [2.0, 0.0, 0.0, 0.5, 0.0, 2.0]),
    ];
    for (name, matrix) in cells {
        let label = format!("r2_c2[{name}]");
        let mut list = base_list();
        nested_clips(&mut list);
        if let Deep2dCommand::Path(path) = &mut list.commands[0] {
            path.transform = matrix;
        }
        let mut cache = Deep2dPathCache::default();
        let prepared = cell(&label, &list, &mut cache);
        assert!(
            prepared.summary.path.fill_triangles > 0,
            "{label}: fill vanished"
        );
        assert!(
            prepared
                .path
                .vertices
                .iter()
                .flatten()
                .all(|v| v.is_finite()),
            "{label}: non-finite vertex"
        );
        cell(&label, &list, &mut cache);
        assert_eq!(
            cache.stats().hits,
            1,
            "{label}: transformed clip entry must hit"
        );
    }
}

#[test]
fn r2_c3_clip_with_dash_and_stroke_keeps_both_kinds_of_geometry() {
    let mut list = base_list();
    if let Deep2dCommand::Path(path) = &mut list.commands[0] {
        path.clip_rect = None; // geometric clip replaces the scissor (contract)
        path.clip_path_ids = Some(vec!["clip-x".into()]);
        path.stroke = Some([0.0, 0.0, 0.0, 1.0]);
        path.stroke_width = Some(0.5);
        path.dash = Some(vec![3.0, 2.0]);
        path.line_cap = Some(LineCap::Round);
    }
    list.resources.push(Deep2dResource::Path(PathResource {
        id: "clip-x".into(),
        revision: 1,
        verbs: rect_verbs(0.0, 0.0, 7.0, 7.0),
    }));
    let mut cache = Deep2dPathCache::default();
    let prepared = cell("r2_c3", &list, &mut cache);
    assert!(
        prepared.summary.path.fill_triangles > 0 && prepared.summary.path.stroke_triangles > 0,
        "r2_c3: dash/stroke geometry lost under clip"
    );
    cell("r2_c3 warm", &list, &mut cache);
    assert_eq!(
        cache.stats().hits,
        1,
        "r2_c3: dashed+clipped stroke entry must hit"
    );
}

#[test]
fn r2_c4_inner_clip_resource_change_misses_only_dependent_command() {
    for (name, slot) in [("outer-a", 0), ("inner-c", 2)] {
        let label = format!("r2_c4[{name}]");
        let mut list = base_list();
        nested_clips(&mut list);
        let mut cache = Deep2dPathCache::default();
        cell(&label, &list, &mut cache);
        let Deep2dResource::Path(clip) = &mut list.resources[3 + slot] else {
            unreachable!()
        };
        clip.verbs = rect_verbs(0.5, 0.5, 3.0, 3.0);
        cell(&label, &list, &mut cache);
        assert_eq!(
            cache.stats().misses,
            2,
            "{label}: exactly the clip-dependent command must re-prepare"
        );
    }
}
