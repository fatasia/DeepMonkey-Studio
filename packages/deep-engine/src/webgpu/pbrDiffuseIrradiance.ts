export const PBR_DIFFUSE_IRRADIANCE_WGSL = /* wgsl */ `
struct DeepDiffuseIrradiance { constant: vec4f, x: vec4f, y: vec4f, z: vec4f };
@group(0) @binding(7) var<uniform> deepDiffuse: DeepDiffuseIrradiance;
fn deepAuthoredDiffuse(normal: vec3f, base: vec3f, metallic: f32, occlusion: f32) -> vec3f {
  let irradiance = max(vec3f(0.0), deepDiffuse.constant.rgb + deepDiffuse.x.rgb * normal.x
    + deepDiffuse.y.rgb * normal.y + deepDiffuse.z.rgb * normal.z);
  return irradiance * base * (1.0 - metallic) * clamp(occlusion, 0.0, 1.0) / 3.141592653589793;
}
`;
