//! Independent source/provider contracts; existing GPU vectors retain numerical coverage.
use crate::probe_gi_wgsl::{
    PROBE_CLIPMAP_SAMPLING_WGSL, native_probe_sampling_wgsl, native_probe_sampling_wgsl_from_source,
};

fn function<'a>(source: &'a str, name: &str) -> &'a str {
    let start = source.find(&format!("fn {name}(")).expect(name);
    let open = start + source[start..].find('{').unwrap();
    let mut depth = 0;
    for (offset, byte) in source.as_bytes()[open..].iter().enumerate() {
        match byte {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return &source[start..=open + offset];
                }
            }
            _ => {}
        }
    }
    panic!("unterminated function {name}");
}

#[test]
fn native_provider_retains_canonical_helpers_and_sample_semantics() {
    let native = native_probe_sampling_wgsl();
    for name in [
        "deepGiFinite3",
        "deepGiLevelUsable",
        "deepGiContains",
        "deepGiVisibility",
        "deepGiNormalWeight",
    ] {
        assert_eq!(
            function(&native, name),
            function(PROBE_CLIPMAP_SAMPLING_WGSL, name)
        );
    }
    let sample = function(&native, "deepGiSampleLevelData");
    assert!(sample.contains("level: DeepGiLevel"));
    for invariant in [
        "let coordinate = (worldPosition - level.originSpacing.xyz) / level.originSpacing.w;",
        "let receiver = worldPosition + normal * level.originSpacing.w * 0.2;",
        "for (var corner = 0u; corner < 8u; corner++)",
        "linear >= level.probeCount || level.baseProbe >= recordCount || linear >= recordCount - level.baseProbe",
        "let probePosition = level.originSpacing.xyz + vec3f(cell) * level.originSpacing.w + record.relocation.xyz;",
        "* deepGiVisibility(record, receiver, probePosition, level.originSpacing.w)",
        "* deepGiNormalWeight(probePosition, worldPosition, normal);",
        "if (!(totalWeight >= 0.001))",
        "irradiance / totalWeight",
    ] {
        assert!(
            sample.contains(invariant),
            "canonical semantic missing: {invariant}"
        );
    }
    assert_eq!(sample.matches("nativeGiRecordCount()").count(), 1);
    assert_eq!(
        sample
            .matches("nativeGiLoadRecord(level.baseProbe + linear)")
            .count(),
        1
    );
    for forbidden in [
        "@group(3)",
        "deepGiProbeRecords",
        "deepGiLevels",
        "fn deepGiSample(",
        "fn deepGiBoundaryCells(",
    ] {
        assert!(
            !native.contains(forbidden),
            "Native provider retained {forbidden}"
        );
    }
}

#[test]
fn source_adapter_rejects_each_missing_or_duplicate_conversion_seam() {
    let seams = [
        "fn deepGiBoundaryCells(",
        "@group(3) @binding(9)\nvar<storage, read> deepGiProbeRecords: array<DeepGiProbeRecord>;",
        "@group(3) @binding(10)\nvar<storage, read> deepGiLevels: array<DeepGiLevel>;",
        "fn deepGiSampleLevel(levelIndex: u32, worldPosition: vec3f, worldNormal: vec3f) -> DeepGiLevelSample {",
        "  let level = deepGiLevels[levelIndex];",
        "arrayLength(&deepGiProbeRecords)",
        "deepGiProbeRecords[level.baseProbe + linear]",
    ];
    for seam in seams {
        assert_eq!(
            PROBE_CLIPMAP_SAMPLING_WGSL.matches(seam).count(),
            1,
            "bad test seam {seam}"
        );
        for changed in [
            PROBE_CLIPMAP_SAMPLING_WGSL.replacen(seam, "/* missing conversion seam */", 1),
            PROBE_CLIPMAP_SAMPLING_WGSL.replacen(seam, &format!("{seam}\n{seam}"), 1),
        ] {
            assert!(
                std::panic::catch_unwind(|| native_probe_sampling_wgsl_from_source(&changed))
                    .is_err(),
                "source drift silently accepted: {seam}"
            );
        }
    }
}

#[test]
fn source_adapter_rejects_binding_and_record_index_drift() {
    for (original, changed) in [
        ("@binding(9)", "@binding(8)"),
        ("@binding(10)", "@binding(11)"),
        (
            "deepGiProbeRecords[level.baseProbe + linear]",
            "deepGiProbeRecords[linear]",
        ),
        (
            "arrayLength(&deepGiProbeRecords)",
            "arrayLength(&deepGiLevels)",
        ),
        (
            "  let level = deepGiLevels[levelIndex];",
            "  let level = deepGiLevels[0u];",
        ),
    ] {
        let drift = PROBE_CLIPMAP_SAMPLING_WGSL.replacen(original, changed, 1);
        assert!(
            std::panic::catch_unwind(|| native_probe_sampling_wgsl_from_source(&drift)).is_err(),
            "binding/absolute-index drift accepted: {changed}"
        );
    }
}

#[test]
fn native_record_provider_uses_absolute_six_vec4_rows() {
    assert_eq!(
        std::mem::size_of::<crate::probe_gi_abi::IrradianceProbeRecord>(),
        96
    );
    let native = native_probe_sampling_wgsl();
    let count = function(&native, "nativeGiRecordCount");
    assert!(count.contains("arrayLength(&probe_gi) / PROBE_GI_RECORD_FLOATS"));
    let load = function(&native, "nativeGiLoadRecord");
    assert!(load.contains("index * PROBE_GI_RECORD_FLOATS"));
    let compact: String = load.chars().filter(|c| !c.is_whitespace()).collect();
    assert!(compact.contains("DeepGiProbeRecord(probe_gi[row],probe_gi[row+1u],probe_gi[row+2u],probe_gi[row+3u],probe_gi[row+4u],probe_gi[row+5u])"),
        "record provider must preserve irradiance/visibility/relocation/reserved row order");
}

#[test]
fn production_ordinary_and_rt_sources_share_one_native_provider() {
    let ordinary = crate::native_mesh_wgsl::native_mesh_shader_source();
    let rt = crate::native_mesh_wgsl::native_mesh_rt_shader_source();
    assert!(rt.starts_with("enable wgpu_ray_query;\n"));
    assert!(
        rt.contains(&ordinary),
        "RT must consume exact ordinary source rather than repack libraries"
    );
    assert!(rt.contains("fn fragment_main_rt("));
    for source in [&ordinary, &rt] {
        for symbol in [
            "struct DeepGiProbeRecord {",
            "struct DeepGiLevel {",
            "fn deepGiSampleLevelData(",
            "fn nativeGiRecordCount(",
            "fn nativeGiLoadRecord(",
        ] {
            assert_eq!(
                source.matches(symbol).count(),
                1,
                "duplicate/missing {symbol}"
            );
        }
        assert!(
            source.contains("@group(0) @binding(11) var<storage, read> probe_gi: array<vec4f>;")
        );
        assert_eq!(
            source
                .matches("nativeGiLoadRecord(level.baseProbe + linear)")
                .count(),
            1
        );
    }
    let module =
        wgpu::naga::front::wgsl::parse_str(&ordinary).expect("actual ordinary factory must parse");
    wgpu::naga::valid::Validator::new(
        wgpu::naga::valid::ValidationFlags::all(),
        wgpu::naga::valid::Capabilities::all(),
    )
    .validate(&module)
    .expect("actual ordinary factory must validate without a device");
}

#[test]
fn actual_frame_receipts_use_production_source_builder() {
    let helper = include_str!("../tests/support/j3_hdr_frame.rs");
    let source = function(helper, "shader_source");
    assert!(source.contains("native_mesh_shader_source()"));
    assert!(!source.contains("concat!("));
    assert!(!source.contains("include_str!("));
    let factory = include_str!("frame_bindings.rs");
    for (name, builder) in [
        ("create_native_mesh_shader", "native_mesh_shader_source()"),
        (
            "create_native_mesh_rt_shader",
            "native_mesh_rt_shader_source()",
        ),
    ] {
        let source = function(factory, name);
        assert!(source.contains(builder));
        assert!(!source.contains("concat!("));
        assert!(!source.contains("include_str!("));
    }
}
