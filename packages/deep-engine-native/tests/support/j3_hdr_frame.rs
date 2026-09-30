use deep_engine_native::{
    half_decode::half_to_f32, mesh_abi::FrameUniform, scene_lighting::DirectionalLighting,
};
use serde_json::{Value, json};

pub fn configure(manifest: &Value, frame: &mut FrameUniform) {
    let lighting: DirectionalLighting = serde_json::from_value(json!({
        "direction": manifest["sun"]["surfaceToLightWorld"], "radiance": manifest["sun"]["radiance"],
        "exposure":manifest["sun"]["exposure"],"shadows":false
    })).unwrap();
    lighting.validate().unwrap().apply(frame);
    frame[9][3] = 0.0; // Existing production IBL enable lane, test profile only.
}

pub fn lighting(frame: &FrameUniform) -> Value {
    json!({"direction": &frame[11][..3], "radiance": &frame[13][..3], "authoredMode":frame[13][3],
        "environment":frame[9][3], "shadows":frame[14][1], "exposure":frame[14][0], "localLights":frame[14][2]})
}

pub fn rgb(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(8)
        .flat_map(|pixel| {
            pixel[..6]
                .chunks_exact(2)
                .map(|v| half_to_f32(u16::from_le_bytes([v[0], v[1]])))
        })
        .collect()
}

/// Identity of the exact current inputs/order used by production frame_bindings factory.
/// No test shader or drawing pipeline is constructed here.
pub fn shader_source() -> String {
    deep_engine_native::native_mesh_wgsl::native_mesh_shader_source()
}
