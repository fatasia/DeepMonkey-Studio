use super::fixture::{base_list, rect_verbs};
use super::{Deep2dDisplayList, Deep2dPathCache, cell};
use deep_engine_native::deep2d::{Deep2dCommand, Deep2dResource, LineCap, PathResource};

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
