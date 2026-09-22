use super::bvh_tests::grid_mesh;
use super::*;

#[test]
fn trace_matches_brute_force_across_a_ray_fan() {
    let (vertices, indices) = grid_mesh(8);
    let built = build_bvh(&vertices, &indices).expect("build succeeds");
    for step in 0..40u32 {
        let angle = step as f32 / 40.0 * std::f32::consts::TAU;
        for (ox, oy) in [(4.0f32, 4.0f32), (0.5, 0.5)] {
            let query = TraceQuery {
                ox,
                oy,
                oz: 6.0,
                dx: angle.cos(),
                dy: angle.sin(),
                dz: -1.0,
                t_max: 64.0,
            };
            let traced = trace_closest(&vertices, &indices, &built, &query);
            let mut brute: Option<TraceHit> = None;
            for triangle in 0..(indices.len() / 3) as u32 {
                if let Some(t) = intersect_triangle(
                    [query.ox, query.oy, query.oz],
                    [query.dx, query.dy, query.dz],
                    &vertices,
                    indices[triangle as usize * 3],
                    indices[triangle as usize * 3 + 1],
                    indices[triangle as usize * 3 + 2],
                ) && t <= query.t_max
                    && brute.as_ref().is_none_or(|hit| t < hit.t)
                {
                    brute = Some(TraceHit {
                        t,
                        primitive_index: triangle,
                    });
                }
            }
            assert_eq!(traced, brute, "mismatch at step {step} origin ({ox},{oy})");
        }
    }
}

#[test]
fn tlas_picks_nearest_instance_with_translation_and_mask() {
    let unit = |ox: f32, oy: f32| {
        vec![
            -1.0 + ox,
            -1.0 + oy,
            0.0,
            1.0 + ox,
            -1.0 + oy,
            0.0,
            1.0 + ox,
            1.0 + oy,
            0.0,
            -1.0 + ox,
            1.0 + oy,
            0.0,
        ]
    };
    let near = BvhBuildResult {
        nodes: Vec::new(),
        order: Vec::new(),
    };
    let _ = &near;
    let near_built = build_bvh(&unit(0.0, 0.0), &[0, 1, 2, 0, 2, 3]).expect("near");
    let far_built = build_bvh(&unit(0.0, 0.0), &[0, 1, 2, 0, 2, 3]).expect("far");
    let instances = vec![
        TlasInstance {
            id: 0,
            blas_vertices: std::rc::Rc::new(unit(0.0, 0.0)),
            blas_indices: std::rc::Rc::new(vec![0, 1, 2, 0, 2, 3]),
            blas: near_built,
            world_to_local: [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            mask: 1,
        },
        TlasInstance {
            id: 1,
            blas_vertices: std::rc::Rc::new(unit(0.0, 0.0)),
            blas_indices: std::rc::Rc::new(vec![0, 1, 2, 0, 2, 3]),
            blas: far_built,
            // world→local 平移 +5：实例位于世界 z=-5（更远）。
            world_to_local: [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 5.0],
            mask: 1,
        },
    ];
    let hit = trace_tlas_closest(
        &instances,
        &TraceQuery {
            ox: 0.0,
            oy: 0.0,
            oz: 5.0,
            dx: 0.0,
            dy: 0.0,
            dz: -1.0,
            t_max: 64.0,
        },
        1,
    )
    .expect("must hit");
    assert_eq!(hit.instance_id, 0);
    assert!((hit.t - 5.0).abs() < 1e-5);
}

#[test]
fn occlusion_and_miss_semantics_match_contract() {
    let (vertices, indices) = grid_mesh(4);
    let built = build_bvh(&vertices, &indices).expect("build succeeds");
    assert!(trace_occluded(
        &vertices,
        &indices,
        &built,
        &TraceQuery {
            ox: 2.0,
            oy: 2.0,
            oz: 4.0,
            dx: 0.0,
            dy: 0.0,
            dz: -1.0,
            t_max: 32.0
        }
    ));
    assert!(!trace_occluded(
        &vertices,
        &indices,
        &built,
        &TraceQuery {
            ox: 2.0,
            oy: 2.0,
            oz: 4.0,
            dx: 0.0,
            dy: 0.0,
            dz: 1.0,
            t_max: 32.0
        }
    ));
    assert!(
        trace_closest(
            &vertices,
            &indices,
            &built,
            &TraceQuery {
                ox: 2.0,
                oy: 2.0,
                oz: 4.0,
                dx: 0.0,
                dy: 0.0,
                dz: -1.0,
                t_max: 0.5
            }
        )
        .is_none()
    );
}

#[test]
fn moeller_trumbore_matches_expected_hit_and_parallel_rejection() {
    let vertices = vec![
        -1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 1.0, 1.0, 0.0, -1.0, 1.0, 0.0,
    ];
    assert_eq!(
        intersect_triangle([0.0, 0.0, 5.0], [0.0, 0.0, -1.0], &vertices, 0, 1, 2),
        Some(5.0)
    );
    assert_eq!(
        intersect_triangle([0.0, 0.0, 5.0], [1.0, 0.0, 0.0], &vertices, 0, 1, 2),
        None
    );
}
