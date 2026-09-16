use super::*;

#[test]
fn atlas_book_places_real_rasters_idempotently_and_counts_revision() {
    let mut cache = GlyphRasterCache::new();
    let mut rasterizer = rasterizer();
    let raster = cache
        .rasterize(&mut rasterizer, request("轴温 72.5°C"))
        .unwrap();
    let mut book = GlyphAtlasBook::new(
        AtlasSpec {
            width: 256,
            height: 256,
        },
        32,
    );
    assert_eq!(book.resource_revision(), 0);
    book.place_text(7, &raster)
        .expect("real raster fits the shelf");
    let cell = book.cell(7).expect("cell stored");
    assert_eq!(
        cell.source,
        [0, 0, raster.width, raster.height],
        "source rect = real raster size"
    );
    assert_eq!(
        cell.destination,
        [0.0, 0.0, f64::from(raster.width), f64::from(raster.height)]
    );
    assert_eq!(
        book.pending_region_updates().len(),
        1,
        "one region for the GPU upload lane"
    );
    assert_eq!(book.resource_revision(), 1);

    // Cache hit path: same key re-placed with identical pixels is a no-op.
    let hit = cache
        .rasterize(&mut rasterizer, request("轴温 72.5°C"))
        .unwrap();
    book.place_text(7, &hit).expect("idempotent");
    assert_eq!(
        book.pending_region_updates().len(),
        1,
        "no duplicate upload for identical pixels"
    );
    assert_eq!(book.resource_revision(), 1);

    let other = cache
        .rasterize(&mut rasterizer, request("转速 rpm"))
        .unwrap();
    book.place_text(8, &other).expect("second text");
    assert_eq!(book.pending_region_updates().len(), 2);
    assert_eq!(book.resource_revision(), 2);
    assert_eq!(book.drain_pending().len(), 2);
    assert!(book.pending_region_updates().is_empty());
    let stats = cache.stats();
    assert_eq!(
        (stats.misses, stats.hits),
        (2, 1),
        "cache served the repeat request"
    );
    eprintln!(
        "book stats: cache={stats:?} book_evicted={} revision={}",
        book.evicted_count(),
        book.resource_revision()
    );
}
