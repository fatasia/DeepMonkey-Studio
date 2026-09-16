use super::*;
use std::sync::Arc;
fn source() -> Deep2dRuntimeContent {
    decode_runtime_content(include_bytes!(
        "../../fixtures/deep2d_runtime_atlas_v1.json"
    ))
    .unwrap()
}
fn frame(parts: Vec<(&str, Deep2dRuntimeContent)>) -> Deep2dRuntimeContent {
    let layers = parts
        .into_iter()
        .map(|(id, content)| Deep2dLayer {
            id: id.into(),
            content: Arc::new(content),
            translation: [0.0, 0.0],
            clip: Deep2dRect {
                x: 0.0,
                y: 0.0,
                width: 640.0,
                height: 480.0,
            },
        })
        .collect();
    Deep2dRuntimeContent::Composite(
        Deep2dComposite::new("page-cache".into(), 1, [640.0, 480.0], layers).unwrap(),
    )
}
#[test]
fn layer_removal_prunes_only_removed_paths_after_a_successful_frame() {
    let mut cache = Deep2dPathCache::default();
    let full = frame(vec![("a", source()), ("b", source())]);
    prepare_runtime_content_cached(&full, &mut cache).unwrap();
    assert_eq!(cache.stats().entries, 2);
    let before = cache.stats();
    assert_eq!(
        prepare_runtime_content_cached(&full, &mut cache).unwrap(),
        prepare_runtime_content(&full).unwrap()
    );
    assert_eq!(cache.stats().hits - before.hits, 2);
    assert_eq!(cache.stats().deletions, before.deletions);
    let retained = frame(vec![("a", source())]);
    let before = cache.stats();
    assert_eq!(
        prepare_runtime_content_cached(&retained, &mut cache).unwrap(),
        prepare_runtime_content(&retained).unwrap()
    );
    assert_eq!(cache.stats().hits - before.hits, 1);
    assert_eq!(cache.stats().entries, 1);
    assert_eq!(cache.stats().deletions - before.deletions, 1);
    prepare_runtime_content_cached(&frame(vec![]), &mut cache).unwrap();
    assert_eq!(cache.stats().entries, 0);
}
#[test]
fn changing_one_layer_invalidates_its_geometry_and_keeps_other_layer_hot() {
    let mut cache = Deep2dPathCache::default();
    prepare_runtime_content_cached(&frame(vec![("a", source()), ("b", source())]), &mut cache)
        .unwrap();
    let mut changed = source();
    let Deep2dRuntimeContent::Package(package) = &mut changed else {
        panic!("fixture must contain an atlas package");
    };
    let Deep2dResource::Path(path) = &mut package.display_list.resources[0] else {
        panic!("fixture resource must be a path");
    };
    path.revision += 1;
    let Deep2dPathVerb::Move { x, .. } = &mut path.verbs[0] else {
        panic!("fixture path must start with Move");
    };
    *x += 1.0;
    let changed = frame(vec![("a", changed), ("b", source())]);
    let before = cache.stats();
    assert_eq!(
        prepare_runtime_content_cached(&changed, &mut cache).unwrap(),
        prepare_runtime_content(&changed).unwrap()
    );
    assert_eq!(cache.stats().hits - before.hits, 1);
    assert_eq!(cache.stats().misses - before.misses, 1);
    assert_eq!(cache.stats().deletions, before.deletions);
    assert_eq!(cache.stats().entries, 2);
}
#[test]
fn failed_second_layer_does_not_prune_any_committed_layer() {
    let mut cache = Deep2dPathCache::default();
    let good = frame(vec![("a", source()), ("b", source())]);
    prepare_runtime_content_cached(&good, &mut cache).unwrap();
    let before = cache.stats();
    let mut bad = source();
    if let Deep2dRuntimeContent::Package(package) = &mut bad {
        package.quads[0].atlas_id = "missing".into();
    }
    let bad = frame(vec![("a", source()), ("bad", bad)]);
    assert!(prepare_runtime_content_cached(&bad, &mut cache).is_err());
    assert_eq!(cache.stats().deletions, before.deletions);
    assert_eq!(cache.stats().entries, 2);
    let hits = cache.stats().hits;
    prepare_runtime_content_cached(&good, &mut cache).unwrap();
    assert_eq!(cache.stats().hits - hits, 2);
}
