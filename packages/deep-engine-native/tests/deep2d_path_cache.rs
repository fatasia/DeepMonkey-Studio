use deep_engine_native::deep2d::*;

fn fixture() -> Deep2dDisplayList {
    decode_display_list(include_bytes!("../fixtures/deep2d_tessellated_v1.json")).unwrap()
}
fn command(list: &mut Deep2dDisplayList, i: usize) -> &mut PathCommand {
    let Deep2dCommand::Path(path) = &mut list.commands[i] else {
        unreachable!()
    };
    path
}
fn resource(list: &mut Deep2dDisplayList, i: usize) -> &mut PathResource {
    let Deep2dResource::Path(path) = &mut list.resources[i] else {
        unreachable!()
    };
    path
}
fn equal(list: &Deep2dDisplayList, cache: &mut Deep2dPathCache) {
    assert_eq!(
        prepare_display_list_cached(list, cache),
        prepare_display_list(list)
    );
}

#[test]
fn warm_paths_reuse_tessellation_and_metadata_remains_current() {
    let mut list = fixture();
    let mut cache = Deep2dPathCache::default();
    equal(&list, &mut cache);
    assert_eq!(cache.stats().misses, 3);
    list.revision += 1;
    for i in 0..3 {
        resource(&mut list, i).revision += 10;
        command(&mut list, i).z_order = 3 - i as i32;
        command(&mut list, i).hit_id = Some(format!("new-hit-{i}"));
    }
    command(&mut list, 0).clip_rect = Some(Deep2dRect {
        x: 50.0,
        y: 50.0,
        width: 100.0,
        height: 100.0,
    });
    list.commands.reverse();
    list.resources.swap(0, 1);
    equal(&list, &mut cache);
    assert_eq!(cache.stats().hits, 3);
    assert_eq!(cache.stats().misses, 3);
}

#[test]
fn changed_geometry_with_unchanged_revision_invalidates_the_entry() {
    let mut list = fixture();
    let mut cache = Deep2dPathCache::default();
    equal(&list, &mut cache);
    resource(&mut list, 0).verbs[1] = Deep2dPathVerb::Line { x: 390.0, y: 40.0 };
    equal(&list, &mut cache);
    assert_eq!((cache.stats().misses, cache.stats().hits), (4, 2));
}

#[test]
fn clip_resource_changes_invalidate_every_dependent_command() {
    let mut list = fixture();
    command(&mut list, 0).clip_path_ids = Some(vec!["overlay:status".into()]);
    let mut cache = Deep2dPathCache::default();
    equal(&list, &mut cache);
    resource(&mut list, 1).verbs[1] = Deep2dPathVerb::Line { x: 86.0, y: 62.0 };
    equal(&list, &mut cache);
    assert_eq!((cache.stats().misses, cache.stats().hits), (5, 1));
}

#[test]
fn scale_transform_and_every_stroke_input_match_uncached_results() {
    type DisplayListMutation = Box<dyn Fn(&mut Deep2dDisplayList)>;
    let changes: Vec<DisplayListMutation> = vec![
        Box::new(|list| list.scale_factor = 2.0),
        Box::new(|list| command(list, 2).transform = [-1.5, 0.0, 0.0, 0.5, 800.0, 10.0]),
        Box::new(|list| command(list, 2).stroke_width = Some(8.0)),
        Box::new(|list| command(list, 2).stroke = Some([0.8, 0.2, 0.1, 1.0])),
        Box::new(|list| command(list, 2).opacity = Some(0.5)),
        Box::new(|list| {
            command(list, 2).dash = Some(vec![4.0, 2.0]);
            command(list, 2).dash_offset = Some(1.0);
        }),
        Box::new(|list| command(list, 2).line_cap = Some(LineCap::Round)),
        Box::new(|list| command(list, 2).line_join = Some(LineJoin::Round)),
        Box::new(|list| command(list, 2).miter_limit = Some(3.0)),
        Box::new(|list| command(list, 0).fill = Some([0.5, 0.3, 0.2, 1.0])),
        Box::new(|list| command(list, 0).fill_rule = Some(FillRule::Evenodd)),
    ];
    for change in changes {
        let mut list = fixture();
        let mut cache = Deep2dPathCache::default();
        equal(&list, &mut cache);
        change(&mut list);
        equal(&list, &mut cache);
        assert!(cache.stats().misses > 3);
    }
}

#[test]
fn invalid_candidates_do_not_poison_previous_geometry() {
    let list = fixture();
    let mut cache = Deep2dPathCache::default();
    equal(&list, &mut cache);
    let before = cache.stats();
    let mut invalid = list.clone();
    invalid.scale_factor = 0.0;
    assert!(prepare_display_list_cached(&invalid, &mut cache).is_err());
    assert_eq!(cache.stats(), before);
    resource(&mut invalid, 0).verbs = vec![Deep2dPathVerb::Move { x: 0.0, y: 0.0 }];
    invalid.scale_factor = 1.0;
    equal(&invalid, &mut cache);
    equal(&list, &mut cache);
    assert_eq!(
        prepare_display_list_cached(&list, &mut cache).unwrap(),
        prepare_display_list(&list).unwrap()
    );
}

#[test]
fn runtime_atlas_and_interleaving_preserve_complete_prepared_payload() {
    for bytes in [
        include_bytes!("../fixtures/deep2d_runtime_atlas_v1.json").as_slice(),
        include_bytes!("../fixtures/deep2d_runtime_interleaved_v2.json").as_slice(),
    ] {
        let content = decode_runtime_content(bytes).unwrap();
        let mut cache = Deep2dPathCache::default();
        let reference = prepare_runtime_content(&content).unwrap();
        assert_eq!(
            prepare_runtime_content_cached(&content, &mut cache).unwrap(),
            reference
        );
        assert_eq!(
            prepare_runtime_content_cached(&content, &mut cache).unwrap(),
            reference
        );
        assert!(cache.stats().hits > 0);
    }
}

#[test]
#[ignore = "explicit Release CPU benchmark"]
fn benchmark_path_cache_partial_change() {
    use std::{hint::black_box, time::Instant};
    let mut list = fixture();
    let curve = command(&mut list, 2).clone();
    list.commands = (0..128)
        .map(|i| {
            let mut command = curve.clone();
            command.id = format!("curve-{i}");
            command.z_order = i;
            command.transform[4] = i as f64;
            Deep2dCommand::Path(command)
        })
        .collect();
    let mut cache = Deep2dPathCache::default();
    prepare_display_list_cached(&list, &mut cache).unwrap();
    let mut samples = [Vec::new(), Vec::new(), Vec::new()];
    for round in 0..25 {
        command(&mut list, 127).transform[5] = (round % 2) as f64;
        for offset in 0..3 {
            let mode = (round + offset) % 3;
            let start = Instant::now();
            let result = match mode {
                0 => prepare_display_list(&list).unwrap(),
                1 => prepare_display_list_cached(&list, &mut Deep2dPathCache::default()).unwrap(),
                _ => prepare_display_list_cached(&list, &mut cache).unwrap(),
            };
            let elapsed = start.elapsed().as_secs_f64() * 1000.0;
            black_box(result);
            if round >= 5 {
                samples[mode].push(elapsed);
            }
        }
    }
    for sample in &mut samples {
        sample.sort_by(f64::total_cmp);
    }
    println!(
        "path cache CPU benchmark: {}",
        serde_json::json!({"build": if cfg!(debug_assertions) {"debug"} else {"release"},
        "commands":128,"changedCommands":1,"warmup":5,"samples":20,"uncachedMedianMs":samples[0][10],
        "coldCacheMedianMs":samples[1][10],"partialMedianMs":samples[2][10],"uncachedP95Ms":samples[0][18],
        "coldCacheP95Ms":samples[1][18],"partialP95Ms":samples[2][18],"cacheEntries":cache.stats().entries,
        "cachePayloadBytes":cache.stats().payload_bytes,"scope":"display-list validation and path tessellation; excludes GPU, atlas and ChartIR"})
    );
    assert_eq!(cache.stats().entries, 128);
    equal(&list, &mut cache);
}
