use deep_engine_native::deep2d::{
    Deep2dAtlasFormat, Deep2dComposition, Deep2dIssueCode, Deep2dRuntimeContent,
    PreparedDeep2dChunkKind, decode_runtime_content, prepare_runtime_content,
    validate_runtime_package,
};

fn package() -> deep_engine_native::deep2d::Deep2dRuntimePackage {
    let content =
        decode_runtime_content(include_bytes!("../fixtures/deep2d_runtime_atlas_v1.json"))
            .expect("runtime fixture");
    let Deep2dRuntimeContent::Package(package) = content else {
        panic!("runtime package")
    };
    package
}

#[test]
fn v2_interleaves_path_image_path_and_glyph_by_editor_z_order() {
    let content = decode_runtime_content(include_bytes!(
        "../fixtures/deep2d_runtime_interleaved_v2.json"
    ))
    .expect("interleaved runtime fixture");
    let Deep2dRuntimeContent::Package(package) = &content else {
        panic!("runtime package")
    };
    assert_eq!(package.schema_version, 2);
    assert_eq!(package.composition, Deep2dComposition::ZOrdered);
    let prepared = prepare_runtime_content(&content).unwrap();
    assert_eq!(prepared.summary.render_chunks, 4);
    assert_eq!(prepared.summary.atlas_batches, 2);
    assert_eq!(prepared.chunks[0].kind, PreparedDeep2dChunkKind::Path);
    assert_eq!(
        prepared.chunks[1].kind,
        PreparedDeep2dChunkKind::Atlas { atlas_index: 0 }
    );
    assert_eq!(prepared.chunks[2].kind, PreparedDeep2dChunkKind::Path);
    assert_eq!(
        prepared.chunks[3].kind,
        PreparedDeep2dChunkKind::Atlas { atlas_index: 1 }
    );
}

#[test]
fn prepares_versioned_glyph_and_image_atlases_in_stable_batches() {
    let package = package();
    assert!(validate_runtime_package(&package).valid);
    let prepared = prepare_runtime_content(&Deep2dRuntimeContent::Package(package)).unwrap();
    assert_eq!(prepared.summary.path.fill_triangles, 2);
    assert_eq!(prepared.summary.atlases, 2);
    assert_eq!(prepared.summary.atlas_bytes, 32);
    assert_eq!(prepared.summary.glyph_quads, 2);
    assert_eq!(prepared.summary.image_quads, 1);
    assert_eq!(prepared.summary.atlas_batches, 2);
    assert_eq!(prepared.summary.atlas_vertices, 18);
    assert_eq!(prepared.chunks.len(), 3);
    assert_eq!(prepared.chunks[0].kind, PreparedDeep2dChunkKind::Path);
    assert_eq!(
        prepared.chunks[1].kind,
        PreparedDeep2dChunkKind::Atlas { atlas_index: 0 }
    );
    assert_eq!(prepared.chunks[1].vertex_count, 12);
    assert_eq!(
        prepared.chunks[2].kind,
        PreparedDeep2dChunkKind::Atlas { atlas_index: 1 }
    );
    assert_eq!(prepared.atlases[0].format, Deep2dAtlasFormat::R8Unorm);
    assert_eq!(prepared.atlases[0].data.len(), 16);
    assert_eq!(prepared.atlas_vertices[0][0..4], [44.0, 48.0, 0.0, 0.0]);
    assert_eq!(prepared.atlas_vertices[0][9..11], [0.125, 0.125]);
    assert_eq!(prepared.atlas_vertices[0][8], 1.0);
    assert_eq!(prepared.atlas_vertices[12][8], 0.0);
}

#[test]
fn old_display_lists_keep_the_existing_path_runtime() {
    let content = decode_runtime_content(include_bytes!("../fixtures/deep2d_path_only_v1.json"))
        .expect("legacy display list");
    assert!(matches!(content, Deep2dRuntimeContent::DisplayList(_)));
    let prepared = prepare_runtime_content(&content).unwrap();
    assert_eq!(prepared.summary.path.vertices, 18);
    assert_eq!(prepared.summary.atlases, 0);
}

#[test]
fn rejects_bad_atlas_data_and_source_before_any_gpu_allocation() {
    let mut bad_data = package();
    bad_data.atlases[0].data_base64 = "AA==".into();
    let result = validate_runtime_package(&bad_data);
    assert_eq!(result.issues[0].code, Deep2dIssueCode::InvalidStructure);
    assert_eq!(result.issues[0].path, "atlases[0].dataBase64");

    let mut bad_source = package();
    bad_source.quads[0].source = [3, 0, 2, 4];
    let result = validate_runtime_package(&bad_source);
    assert_eq!(result.issues[0].code, Deep2dIssueCode::InvalidNumber);
    assert_eq!(result.issues[0].path, "quads[0].source");
}

#[test]
fn rejects_missing_atlas_and_native_text_shaping_fallback() {
    let mut missing = package();
    missing.quads[0].atlas_id = "atlas:missing".into();
    let result = validate_runtime_package(&missing);
    assert!(result.issues.iter().any(|issue| {
        issue.code == Deep2dIssueCode::MissingResource && issue.path == "quads[0].atlasId"
    }));

    let mut raw_text = package();
    let full: deep_engine_native::deep2d::Deep2dDisplayList =
        serde_json::from_str(include_str!("../fixtures/deep2d_display_list_v1.json")).unwrap();
    raw_text.display_list = full;
    let result = validate_runtime_package(&raw_text);
    assert!(result.issues.iter().any(|issue| {
        issue.code == Deep2dIssueCode::InvalidStructure && issue.path == "displayList.commands[1]"
    }));
}

#[test]
fn rejects_unknown_contract_fields_and_unreferenced_gpu_resources() {
    let mut value: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/deep2d_runtime_atlas_v1.json")).unwrap();
    value["futureField"] = serde_json::json!(true);
    let bytes = serde_json::to_vec(&value).unwrap();
    let error = decode_runtime_content(&bytes).expect_err("strict package contract");
    assert!(error.contains("unknown field `futureField`"));

    let mut unreferenced = package();
    unreferenced.quads.pop();
    let result = validate_runtime_package(&unreferenced);
    assert!(result.issues.iter().any(|issue| {
        issue.code == Deep2dIssueCode::InvalidStructure && issue.path == "atlases[1]"
    }));
}

#[test]
fn composition_semantics_are_frozen_per_runtime_schema_version() {
    let mut v1 = package();
    v1.composition = Deep2dComposition::ZOrdered;
    let result = validate_runtime_package(&v1);
    assert!(
        result
            .issues
            .iter()
            .any(|issue| issue.path == "composition")
    );

    v1.schema_version = 2;
    v1.composition = Deep2dComposition::PathThenAtlas;
    let result = validate_runtime_package(&v1);
    assert!(
        result
            .issues
            .iter()
            .any(|issue| issue.path == "composition")
    );
}
