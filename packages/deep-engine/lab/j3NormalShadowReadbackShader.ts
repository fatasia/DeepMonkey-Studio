import { CASCADED_SHADOW_WGSL } from "../src/shadows/cascadedShadowShader.js";

/** Samples actual production attachments and the existing production shadow helper. */
export const j3NormalShadowReadbackShader = /* wgsl */`
${CASCADED_SHADOW_WGSL}
struct Point { world: vec4f, normal: vec4f, pixel: vec4u };
@group(0) @binding(0) var actualNormal: texture_2d<f32>;
@group(0) @binding(1) var actualDepth: texture_2d<f32>;
@group(0) @binding(2) var actualHdr: texture_2d<f32>;
@group(0) @binding(3) var<storage, read> points: array<Point>;
@group(0) @binding(4) var<storage, read_write> observed: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x == 0u) {
    for (var m = 0u; m < 8u; m++) {
      for (var c = 0u; c < 4u; c++) { observed[m * 4u + c] = deepCascade.matrices[m][c]; }
    }
    observed[32] = deepCascade.splitDepths0; observed[33] = deepCascade.splitDepths1;
    observed[34] = deepCascade.blendStarts0; observed[35] = deepCascade.blendStarts1;
    observed[36] = deepCascade.texelWorld0; observed[37] = deepCascade.texelWorld1;
    observed[38] = deepCascade.params;
  }
  if (id.x >= arrayLength(&points)) { return; }
  let point = points[id.x]; let pixel = vec2i(point.pixel.xy);
  let normal = textureLoad(actualNormal, pixel, 0);
  let depth = textureLoad(actualDepth, pixel, 0).r;
  let visibility = deepCascadedShadow(depth, point.world.xyz, point.normal.xyz, point.normal.w);
  observed[39u + id.x * 3u] = normal;
  observed[40u + id.x * 3u] = vec4f(textureLoad(actualHdr, pixel, 0).rgb, visibility);
  observed[41u + id.x * 3u] = vec4f(depth, 0.0, 0.0, 0.0);
}
`;
