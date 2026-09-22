export const VOLUMETRIC_FOG_COMPOSITE_WORKGROUP_SIZE = 8;

/** Linear-HDR Beer-Lambert composition: scene * transmittance + in-scatter. */
export const VOLUMETRIC_FOG_COMPOSITE_WGSL = /* wgsl */ `
struct FogCompositeParams {
  sourceSize: vec2<u32>,
  scatterSize: vec2<u32>,
};

@group(0) @binding(0) var sourceColor: texture_2d<f32>;
@group(0) @binding(1) var fogScatter: texture_2d<f32>;
@group(0) @binding(2) var fogSampler: sampler;
@group(0) @binding(3) var<storage, read> params: FogCompositeParams;
@group(0) @binding(4) var outputColor: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(${VOLUMETRIC_FOG_COMPOSITE_WORKGROUP_SIZE}, ${VOLUMETRIC_FOG_COMPOSITE_WORKGROUP_SIZE}, 1)
fn compositeVolumetricFog(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.sourceSize.x || id.y >= params.sourceSize.y) { return; }
  let source = textureLoad(sourceColor, vec2u(id.xy), 0);
  let uv = (vec2f(id.xy) + vec2f(0.5)) / vec2f(params.sourceSize);
  let fog = textureSampleLevel(fogScatter, fogSampler, uv, 0.0);
  let transmittance = clamp(fog.a, 0.0, 1.0);
  textureStore(outputColor, vec2u(id.xy), vec4f(source.rgb * transmittance + max(fog.rgb, vec3f(0.0)), source.a));
}
`;
