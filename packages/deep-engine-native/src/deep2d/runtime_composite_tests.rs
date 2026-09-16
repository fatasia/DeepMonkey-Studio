use super::*;
use std::sync::Arc;
fn package() -> Deep2dRuntimeContent {
    decode_runtime_content(include_bytes!(
        "../../fixtures/deep2d_runtime_atlas_v1.json"
    ))
    .unwrap()
}
fn layer(id: &str, content: Deep2dRuntimeContent, translation: [f64; 2]) -> Deep2dLayer {
    Deep2dLayer {
        id: id.into(),
        content: Arc::new(content),
        translation,
        clip: Deep2dRect {
            x: 30.0,
            y: 40.0,
            width: 160.0,
            height: 120.0,
        },
    }
}
#[test]
fn composite_retains_package_tint_quad_order_and_translated_clip_with_cache() {
    for z_ordered in [false, true] {
        let mut source = package();
        if let Deep2dRuntimeContent::Package(p) = &mut source {
            if z_ordered {
                p.schema_version = 2;
                p.composition = Deep2dComposition::ZOrdered;
                p.quads[0].z_order = -3;
            }
            if let Deep2dCommand::Path(path) = &mut p.display_list.commands[0] {
                path.clip_rect = Some(Deep2dRect {
                    x: 20.0,
                    y: 30.0,
                    width: 100.0,
                    height: 100.0,
                });
            }
            p.quads[2].color = [0.2, 0.4, 0.6, 0.8];
            p.quads[2].opacity = 0.5;
        }
        let original = prepare_runtime_content(&source).unwrap();
        let offset = [10.0, 20.0];
        let composite = Deep2dRuntimeContent::Composite(
            Deep2dComposite::new(
                "page-composite".into(),
                1,
                [640.0, 480.0],
                vec![
                    layer("node.a", source.clone(), offset),
                    layer("node.b", source, offset),
                ],
            )
            .unwrap(),
        );
        let actual = prepare_runtime_content(&composite).unwrap();
        assert_eq!(actual.summary.glyph_quads, original.summary.glyph_quads * 2);
        assert_eq!(actual.summary.image_quads, original.summary.image_quads * 2);
        assert_eq!(actual.summary.atlas_bytes, original.summary.atlas_bytes * 2);
        for (vertex, old) in actual
            .atlas_vertices
            .iter()
            .zip(original.atlas_vertices.iter().cycle())
        {
            assert_eq!(vertex[0], old[0] + 10.0);
            assert_eq!(vertex[1], old[1] + 20.0);
            assert_eq!(
                &vertex[2..],
                &old[2..],
                "UV, tint and opacity must not change"
            );
        }
        for (vertex, old) in actual
            .path
            .vertices
            .iter()
            .zip(original.path.vertices.iter().cycle())
        {
            assert_eq!(vertex[0], old[0] + 10.0);
            assert_eq!(vertex[1], old[1] + 20.0);
            assert_eq!(&vertex[2..], &old[2..]);
        }
        for (i, chunk) in actual.chunks.iter().enumerate() {
            let old = &original.chunks[i % original.chunks.len()];
            assert_eq!(
                std::mem::discriminant(&chunk.kind),
                std::mem::discriminant(&old.kind)
            );
            let clip = chunk.clip_rect.unwrap();
            assert!(
                clip.x >= 30.0
                    && clip.y >= 40.0
                    && clip.x + clip.width <= 190.0
                    && clip.y + clip.height <= 160.0
            );
            if matches!(chunk.kind, PreparedDeep2dChunkKind::Path) {
                assert_eq!(
                    clip,
                    Deep2dRect {
                        x: 30.0,
                        y: 50.0,
                        width: 100.0,
                        height: 100.0
                    }
                );
            }
        }
        assert_ne!(
            actual.atlases[0].id,
            actual.atlases[original.atlases.len()].id
        );
        let mut cache = Deep2dPathCache::default();
        assert_eq!(
            prepare_runtime_content_cached(&composite, &mut cache).unwrap(),
            actual
        );
        assert_eq!(
            prepare_runtime_content_cached(&composite, &mut cache).unwrap(),
            actual
        );
        assert!(cache.stats().hits > 0);
    }
}
#[test]
fn composite_rejects_duplicate_identity_nested_layers_and_bad_clip() {
    let first = layer("node", package(), [0.0, 0.0]);
    assert!(
        Deep2dComposite::new(
            "page".into(),
            1,
            [640.0, 480.0],
            vec![first.clone(), first.clone()]
        )
        .is_err()
    );
    let nested =
        Deep2dComposite::new("page".into(), 1, [640.0, 480.0], vec![first.clone()]).unwrap();
    assert!(
        Deep2dComposite::new(
            "page".into(),
            1,
            [640.0, 480.0],
            vec![layer(
                "outer",
                Deep2dRuntimeContent::Composite(nested),
                [0.0, 0.0]
            )]
        )
        .is_err()
    );
    let mut invalid = first;
    invalid.clip.width = f64::NAN;
    assert!(Deep2dComposite::new("page".into(), 1, [640.0, 480.0], vec![invalid]).is_err());
}

#[test]
fn composite_accumulation_checks_exact_limits_before_appending() {
    use super::runtime_composite_prepare::combined_summary;
    let empty = PreparedDeep2dRuntimeSummary {
        path: PreparedDeep2dSummary {
            commands: 0,
            path_segments: 0,
            fill_triangles: 0,
            stroke_triangles: 0,
            vertices: 0,
        },
        atlases: 0,
        atlas_bytes: 0,
        glyph_quads: 0,
        image_quads: 0,
        atlas_batches: 0,
        atlas_vertices: 0,
        render_chunks: 0,
    };
    let mut limit = empty;
    limit.path.commands = DEEP_2D_DISPLAY_LIST_BUDGETS.commands;
    limit.path.vertices = u32::MAX as usize;
    limit.atlases = 512;
    limit.atlas_bytes = 64 * 1024 * 1024;
    limit.glyph_quads = 262_143;
    limit.image_quads = 1;
    limit.atlas_vertices = u32::MAX as usize;
    assert_eq!(combined_summary(limit, empty).unwrap(), limit);
    let additions = [
        PreparedDeep2dRuntimeSummary {
            path: PreparedDeep2dSummary {
                commands: 1,
                ..empty.path
            },
            ..empty
        },
        PreparedDeep2dRuntimeSummary {
            path: PreparedDeep2dSummary {
                vertices: 1,
                ..empty.path
            },
            ..empty
        },
        PreparedDeep2dRuntimeSummary {
            atlases: 1,
            ..empty
        },
        PreparedDeep2dRuntimeSummary {
            atlas_bytes: 1,
            ..empty
        },
        PreparedDeep2dRuntimeSummary {
            glyph_quads: 1,
            ..empty
        },
        PreparedDeep2dRuntimeSummary {
            image_quads: 1,
            ..empty
        },
        PreparedDeep2dRuntimeSummary {
            atlas_vertices: 1,
            ..empty
        },
    ];
    for incoming in additions {
        assert!(combined_summary(limit, incoming).is_err());
    }
    let huge = PreparedDeep2dRuntimeSummary {
        path: PreparedDeep2dSummary {
            path_segments: usize::MAX,
            ..empty.path
        },
        ..empty
    };
    let one = PreparedDeep2dRuntimeSummary {
        path: PreparedDeep2dSummary {
            path_segments: 1,
            ..empty.path
        },
        ..empty
    };
    assert!(combined_summary(huge, one).is_err());
    let huge = PreparedDeep2dRuntimeSummary {
        glyph_quads: usize::MAX,
        image_quads: 1,
        ..empty
    };
    assert!(combined_summary(huge, empty).is_err());
}
