export const AMBIENT_OCCLUSION_COMPOSITE_WORKGROUP_SIZE = 8;

export const AMBIENT_OCCLUSION_COMPOSITE_WGSL = /* wgsl */ `
struct CompositeParams {
  sourceSize: vec2<u32>,
  aoSize: vec2<u32>,
  tuning: vec4<f32>,
};
@group(0) @binding(0) var sourceColor: texture_2d<f32>;
@group(0) @binding(1) var sourceDepth: texture_2d<f32>;
@group(0) @binding(2) var sourceAo: texture_2d<f32>;
@group(0) @binding(3) var<storage, read> compositeParams: CompositeParams;
@group(0) @binding(4) var targetColor: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var sourceNormal: texture_2d<f32>;

fn representativeSourceCoordinate(halfCoordinate: vec2<u32>) -> vec2<u32> {
  return min(halfCoordinate * 2u + vec2<u32>(1u), compositeParams.sourceSize - vec2<u32>(1u));
}

fn bilateralVisibility(coordinate: vec2<u32>, centerDepth: f32) -> f32 {
  if (!(centerDepth > 0.0)) { return 1.0; }
  let aoPosition = (vec2<f32>(coordinate) - vec2<f32>(1.0)) * 0.5;
  let base = vec2<i32>(floor(aoPosition));
  let fraction = fract(aoPosition);
  var weighted = 0.0;
  var totalWeight = 0.0;
  for (var y = 0; y <= 1; y++) {
    for (var x = 0; x <= 1; x++) {
      let sampleHalfSigned = clamp(base + vec2<i32>(x, y), vec2<i32>(0), vec2<i32>(compositeParams.aoSize) - vec2<i32>(1));
      let sampleHalf = vec2<u32>(sampleHalfSigned);
      let sampleDepth = textureLoad(sourceDepth, vec2<i32>(representativeSourceCoordinate(sampleHalf)), 0).x;
      if (sampleDepth > 0.0) {
        let spatialX = select(1.0 - fraction.x, fraction.x, x == 1);
        let spatialY = select(1.0 - fraction.y, fraction.y, y == 1);
        let depthWeight = exp(-abs(sampleDepth - centerDepth) / compositeParams.tuning.x);
        let weight = spatialX * spatialY * depthWeight;
        weighted += clamp(textureLoad(sourceAo, sampleHalfSigned, 0).x, 0.0, 1.0) * weight;
        totalWeight += weight;
      }
    }
  }
  let fallbackHalf = min((coordinate + vec2<u32>(1u)) / 2u, compositeParams.aoSize - vec2<u32>(1u));
  let fallback = clamp(textureLoad(sourceAo, vec2<i32>(fallbackHalf), 0).x, 0.0, 1.0);
  return select(fallback, weighted / max(totalWeight, 0.000001), totalWeight > 0.000001);
}

@compute @workgroup_size(8, 8)
fn compositeAmbientOcclusion(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= compositeParams.sourceSize.x || id.y >= compositeParams.sourceSize.y) { return; }
  let coordinate = id.xy;
  let color = textureLoad(sourceColor, vec2<i32>(coordinate), 0);
  if (compositeParams.tuning.z > 0.5 && textureLoad(sourceNormal, vec2<i32>(coordinate), 0).a > 0.5) {
    textureStore(targetColor, vec2<i32>(coordinate), color); return;
  }
  let centerDepth = textureLoad(sourceDepth, vec2<i32>(coordinate), 0).x;
  var visibility = 1.0;
  if (compositeParams.tuning.y > 0.0) {
    visibility = pow(bilateralVisibility(coordinate, centerDepth), compositeParams.tuning.y);
  }
  textureStore(targetColor, vec2<i32>(coordinate), vec4<f32>(color.rgb * visibility, color.a));
}
`;
