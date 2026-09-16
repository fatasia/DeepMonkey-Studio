use super::fixture::{SWAPPED_TILES, base_list, content, rect_verbs};
use super::{Deep2dPathCache, cell, prepare_runtime_content_cached};
use deep_engine_native::deep2d::{Deep2dCommand, Deep2dResource, PathCommand, PathResource};

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
    type NamedPathMutation = (&'static str, Box<dyn Fn(&mut PathCommand)>);
    let changes: Vec<NamedPathMutation> = vec![
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
            frame.z_order = i;
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
