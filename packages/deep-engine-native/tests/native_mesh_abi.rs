use deep_engine_native::fog::FogSettings;
use deep_engine_native::mesh_abi::{
    FORWARD_COLOR_FORMAT, FORWARD_DEPTH_FORMAT, FORWARD_RESOLVE_REQUIRED, FORWARD_SAMPLE_COUNT,
    FRAME_MEMBER_BYTE_OFFSETS, FRAME_UNIFORM_BYTES, FRAME_UNIFORM_FLOATS,
    GEOMETRY_VERTEX_ATTRIBUTES, GEOMETRY_VERTEX_BYTES, INSTANCE_VERTEX_ATTRIBUTES,
    MATERIAL_UNIFORM_BYTES, MATERIAL_UNIFORM_FLOATS, MESH_ABI_ID, PACKED_INSTANCE_BYTES,
    TANGENT_VERTEX_ATTRIBUTES, TANGENT_VERTEX_BYTES, frame_uniform, frame_uniform_with_fog,
};

const _: () = assert!(FORWARD_RESOLVE_REQUIRED);

#[test]
fn native_mesh_abi1_matches_the_browser_geometry_instance_and_material_golden() {
    assert_eq!(MESH_ABI_ID, "deep.pbr.mesh.v1");
    assert_eq!((GEOMETRY_VERTEX_BYTES, TANGENT_VERTEX_BYTES), (40, 16));
    assert_eq!(PACKED_INSTANCE_BYTES, 144);
    assert_eq!((MATERIAL_UNIFORM_FLOATS, MATERIAL_UNIFORM_BYTES), (40, 160));

    let geometry = GEOMETRY_VERTEX_ATTRIBUTES.map(|attribute| {
        (
            attribute.shader_location,
            attribute.offset,
            attribute.format,
        )
    });
    assert_eq!(
        geometry,
        [
            (0, 0, wgpu::VertexFormat::Float32x3),
            (1, 12, wgpu::VertexFormat::Float32x3),
            (10, 24, wgpu::VertexFormat::Float32x2),
            (13, 32, wgpu::VertexFormat::Float32x2),
        ]
    );
    assert_eq!(
        INSTANCE_VERTEX_ATTRIBUTES.map(|attribute| (attribute.shader_location, attribute.offset)),
        [
            (2, 0),
            (3, 16),
            (4, 32),
            (5, 48),
            (6, 64),
            (7, 80),
            (8, 96),
            (9, 112),
            (12, 128),
        ]
    );
    assert_eq!(
        TANGENT_VERTEX_ATTRIBUTES.map(|attribute| {
            (
                attribute.shader_location,
                attribute.offset,
                attribute.format,
            )
        }),
        [(11, 0, wgpu::VertexFormat::Float32x4)]
    );
}

#[test]
fn native_forward_attachment_profile_matches_the_browser_golden() {
    assert_eq!(FORWARD_COLOR_FORMAT, wgpu::TextureFormat::Rgba16Float);
    assert_eq!(FORWARD_DEPTH_FORMAT, wgpu::TextureFormat::Depth24Plus);
    assert_eq!(FORWARD_SAMPLE_COUNT, 4);
    let mesh = include_str!("../assets/shaders/native_mesh_v1.wgsl");
    let output = include_str!("../assets/shaders/native_output_v1.wgsl");
    let mesh_pass = include_str!("../src/mesh_pass.rs");
    assert!(!mesh.contains("fn aces("));
    assert!(output.contains("fn aces("));
    assert!(output.contains("fragment_srgb_target"));
    assert!(output.contains("fragment_unorm_target"));
    assert!(output.contains("linear_to_srgb"));
    assert_eq!(
        mesh_pass
            .matches("resolve_target: Some(&targets.hdr_view)")
            .count(),
        3,
        "opaque, transparent, and overlay forward passes resolve into HDR"
    );
}

#[test]
fn native_frame_v7_retains_the_v1_through_v6_prefixes() {
    assert_eq!(
        deep_engine_native::mesh_abi::FRAME_ABI_ID,
        "deep.native.frame.v7"
    );
    assert_eq!(deep_engine_native::mesh_abi::FRAME_V1_BYTES, 208);
    assert_eq!((FRAME_UNIFORM_FLOATS, FRAME_UNIFORM_BYTES), (496, 1984));
    assert_eq!(FRAME_MEMBER_BYTE_OFFSETS, [0, 64, 128, 144, 160, 176, 192]);

    let frame = frame_uniform(2.0, 0.0);
    let flat = frame.as_flattened();
    assert_eq!(flat.len(), FRAME_UNIFORM_FLOATS);
    assert_slice_close(&flat[0..4], &[1.025, 0.0, 0.0, 0.0]);
    assert_slice_close(&flat[12..16], &[0.0, 0.0, 3.9039037, 4.0]);
    assert!(flat[16..32].iter().all(|value| value.is_finite()));
    assert_ne!(&flat[16..32], &[0.0; 16]);
    assert_slice_close(&flat[32..36], &[0.0, 0.0, 4.0, 1.0]);
    assert_slice_close(&flat[36..40], &[0.012, 0.020, 0.035, 1.0]);
    assert_slice_close(&flat[40..44], &[0.0, 0.0, 0.0, 1.0]);
    assert_slice_close(&flat[44..48], &[0.55, 0.8, 0.35, 0.0]);
    assert_slice_close(&flat[48..52], &[0.0; 4]);
    assert_slice_close(&flat[52..56], &[0.0; 4]);
    assert_slice_close(&flat[56..60], &[1.0, 1.0, 0.0, 0.0]);
    assert!(flat[60..476].iter().all(|value| *value == 0.0));
    assert_slice_close(&flat[476..480], &[0.1, 100.0, 0.0, 0.0]);
    assert!(flat[480..].iter().all(|value| *value == 0.0));
    assert!(flat.iter().all(|value| value.is_finite()));

    let fog = FogSettings::exponential(0.125, [0.2, 0.3, 0.4]).unwrap();
    let fog_frame = frame_uniform_with_fog(2.0, 0.0, fog);
    assert_slice_close(&fog_frame.as_flattened()[48..52], &[0.2, 0.3, 0.4, 0.125]);
}

#[test]
fn wgsl_consumes_compact_rows_uv_sets_and_instance_emissive_alpha() {
    let shader = include_str!("../assets/shaders/native_mesh_v1.wgsl");
    assert!(!shader.contains("model_3"));
    assert!(!shader.contains("emissive_factor"));
    assert!(
        shader.contains("@location(6) @interpolate(flat) material: vec4f"),
        "packed flags must never interpolate before integer bit tests"
    );
    for declaration in [
        "@location(10) uv0: vec2f",
        "@location(11) tangent: vec4f",
        "@location(12) emissive_alpha: vec4f",
        "@location(13) uv1: vec2f",
    ] {
        assert!(
            shader.contains(declaration),
            "missing ABI declaration {declaration}"
        );
    }
    assert!(shader.contains("select(uv0, uv1, row_0.w > 1.5)"));
    assert!(shader.contains("view: mat4x4f"));
    assert!(shader.contains("light: mat4x4f"));
    assert!(shader.contains("eye: vec4f"));
    assert!(shader.contains("background: vec4f"));
    assert!(shader.contains("floor: vec4f"));
    assert!(shader.contains("lightDirection: vec4f"));
    assert!(shader.contains("tuning: vec4f"));
    for declaration in [
        "@group(0) @binding(3) var specular_environment: texture_cube<f32>",
        "@group(0) @binding(4) var diffuse_environment: texture_cube<f32>",
        "@group(0) @binding(5) var brdf_lut: texture_2d<f32>",
        "@group(0) @binding(6) var environment_sampler: sampler",
    ] {
        assert!(
            shader.contains(declaration),
            "missing IBL ABI {declaration}"
        );
    }
    assert!(shader.contains("textureNumLevels(specular_environment) - 1u"));
    assert!(shader.contains("energy_compensation * ambient_occlusion"));
    assert!(shader.contains("global_illumination"));
    assert!(!shader.contains("vec3f(0.13, 0.16, 0.22)"));
}

fn assert_slice_close(actual: &[f32], expected: &[f32]) {
    assert_eq!(actual.len(), expected.len());
    for (index, (&actual, &expected)) in actual.iter().zip(expected).enumerate() {
        assert!(
            (actual - expected).abs() < 1e-6,
            "component {index}: expected {expected}, got {actual}"
        );
    }
}
