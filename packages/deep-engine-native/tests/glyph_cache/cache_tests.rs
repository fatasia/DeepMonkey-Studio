use super::*;

#[test]
fn same_key_hits_without_rerasterizing() {
    let mut cache = GlyphRasterCache::new();
    let mut rasterizer = rasterizer();
    let first = cache
        .rasterize(&mut rasterizer, request("泵站 A-01 温度 25.6°C"))
        .unwrap();
    assert!(
        visible_pixels(&first) > 0,
        "real rasterization must produce visible pixels"
    );
    let stats = cache.stats();
    assert_eq!(
        (stats.hits, stats.misses, stats.evictions, stats.entries),
        (0, 1, 0, 1)
    );
    assert!(
        stats.payload_bytes >= first.rgba.len() && stats.payload_bytes <= GLYPH_CACHE_MAX_BYTES
    );
    for _ in 0..3 {
        let again = cache
            .rasterize(&mut rasterizer, request("泵站 A-01 温度 25.6°C"))
            .unwrap();
        assert_same_raster(&again, &first);
    }
    let stats = cache.stats();
    assert_eq!(
        (stats.hits, stats.misses, stats.evictions),
        (3, 1, 0),
        "3 hits, no re-raster"
    );
    assert_eq!(
        cache.resource_revision(),
        1,
        "hits never advance the revision"
    );
    eprintln!("same_key stats: {stats:?}");
}

#[test]
fn font_size_change_rebuilds_as_a_distinct_key() {
    let mut cache = GlyphRasterCache::new();
    let mut rasterizer = rasterizer();
    let small = cache
        .rasterize(
            &mut rasterizer,
            CachedTextRequest {
                font_size: 12.0,
                line_height: 20.0,
                ..request("负荷 MW")
            },
        )
        .unwrap();
    let large = cache
        .rasterize(
            &mut rasterizer,
            CachedTextRequest {
                font_size: 16.0,
                line_height: 24.0,
                ..request("负荷 MW")
            },
        )
        .unwrap();
    assert_eq!(
        (small.height, large.height),
        (20, 24),
        "different size = different raster, never shared"
    );
    let stats = cache.stats();
    assert_eq!((stats.misses, stats.entries), (2, 2));
    assert_eq!(cache.resource_revision(), 2, "one insert per distinct key");
    eprintln!("size_change stats: {stats:?}");
}

#[test]
fn entry_budget_evicts_and_rerasterizes_correctly() {
    let mut cache = GlyphRasterCache::with_budgets(1, GLYPH_CACHE_MAX_BYTES);
    let mut rasterizer = rasterizer();
    let first_a = cache.rasterize(&mut rasterizer, request("电流 A")).unwrap();
    let first_a_pixels = first_a.rgba.clone();
    drop(first_a);
    cache.rasterize(&mut rasterizer, request("电压 V")).unwrap();
    let after = cache.stats();
    assert_eq!(
        (after.evictions, after.entries),
        (1, 1),
        "cap=1: inserting B evicts A"
    );
    assert_eq!(
        cache.resource_revision(),
        3,
        "insert A (+1), evict A (+1), insert B (+1)"
    );
    let second_a = cache.rasterize(&mut rasterizer, request("电流 A")).unwrap();
    let stats = cache.stats();
    assert_eq!(
        (stats.misses, stats.evictions),
        (3, 2),
        "evicted entry re-rasterizes"
    );
    assert_eq!(
        second_a.rgba, first_a_pixels,
        "re-rasterized pixels are identical (deterministic)"
    );
    eprintln!("eviction stats: {stats:?}");
}

#[test]
fn byte_budget_keeps_correctness_when_entry_exceeds_it() {
    let mut cache = GlyphRasterCache::with_budgets(16, 1);
    let mut rasterizer = rasterizer();
    let raster = cache
        .rasterize(&mut rasterizer, request("功率 kW"))
        .unwrap();
    assert!(
        visible_pixels(&raster) > 0,
        "value is returned even when uncachable"
    );
    let stats = cache.stats();
    assert_eq!(
        (stats.entries, stats.payload_bytes, stats.evictions),
        (0, 0, 0),
        "oversized entry is not stored"
    );
    let again = cache
        .rasterize(&mut rasterizer, request("功率 kW"))
        .unwrap();
    assert_same_raster(&again, &raster);
    assert_eq!(cache.stats().misses, 2);
}

#[test]
fn returned_arc_survives_clear_and_eviction_untouched() {
    let mut cache = GlyphRasterCache::new();
    let mut rasterizer = rasterizer();
    let held = cache
        .rasterize(&mut rasterizer, request("频率 Hz"))
        .unwrap();
    let held_pixels = held.rgba.clone();
    cache.clear();
    assert_eq!(
        Arc::strong_count(&held),
        1,
        "clear drops the cache's ref; the caller's copy stays valid"
    );
    assert_eq!(
        held.rgba, held_pixels,
        "clear must not mutate a handed-out Arc value"
    );
    assert!(visible_pixels(&held) > 0); // Eviction path: a cap-1 cache evicts the stored copy; the pinned Arc survives.
    let mut tiny = GlyphRasterCache::with_budgets(1, GLYPH_CACHE_MAX_BYTES);
    let pinned = tiny.rasterize(&mut rasterizer, request("相位 °")).unwrap();
    let pinned_pixels = pinned.rgba.clone();
    tiny.rasterize(&mut rasterizer, request("其它")).unwrap();
    assert_eq!(Arc::strong_count(&pinned), 1);
    assert_eq!(
        pinned.rgba, pinned_pixels,
        "eviction must not mutate a handed-out Arc value"
    );
    assert!(visible_pixels(&pinned) > 0);

    // After clear the same key re-rasterizes and matches the original bytes.
    let rebuilt = cache
        .rasterize(&mut rasterizer, request("频率 Hz"))
        .unwrap();
    assert_eq!(
        rebuilt.rgba, held_pixels,
        "re-rasterization after clear is identical"
    );
    let stats = cache.stats();
    assert_eq!(stats.misses, 2, "clear forces a real re-raster");
    eprintln!("arc_survival stats: {stats:?}");
}

#[test]
fn cache_revision_tracks_content_changes_only() {
    let mut cache = GlyphRasterCache::with_budgets(1, GLYPH_CACHE_MAX_BYTES);
    let mut rasterizer = rasterizer();
    assert_eq!(cache.resource_revision(), 0);
    cache.rasterize(&mut rasterizer, request("状态 1")).unwrap();
    let after_insert = cache.resource_revision();
    assert_eq!(after_insert, 1);
    cache.rasterize(&mut rasterizer, request("状态 1")).unwrap();
    assert_eq!(
        cache.resource_revision(),
        after_insert,
        "hit is not a content change"
    );
    cache.rasterize(&mut rasterizer, request("状态 2")).unwrap();
    assert_eq!(
        cache.resource_revision(),
        after_insert + 2,
        "evict + insert = +2"
    );
    cache.clear();
    assert_eq!(
        cache.resource_revision(),
        after_insert + 3,
        "clear of non-empty cache = +1"
    );
    cache.clear();
    assert_eq!(
        cache.resource_revision(),
        after_insert + 3,
        "clear of empty cache is a no-op"
    );
}
