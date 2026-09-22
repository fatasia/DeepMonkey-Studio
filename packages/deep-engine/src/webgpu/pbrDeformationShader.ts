import { sceneShader } from "./pbrShader.js";

/** 48-byte current/previous streams share material group 1 without adding vertex attributes. */
export const PBR_DEFORMATION_VERTEX_WGSL = /* wgsl */ `
struct DeepDeformedVertex { position: vec4f, normal: vec4f, tangent: vec4f };
@group(1) @binding(11) var<storage, read> deepCurrentPose: array<DeepDeformedVertex>;
@group(1) @binding(12) var<storage, read> deepPreviousPose: array<DeepDeformedVertex>;

fn deepPoseVertex(v: Input, previous: PreviousInstanceInput, index: u32, normalMapped: bool) -> Vertex {
  var out: Vertex;
  let pose = deepCurrentPose[index];
  let p = vec4f(pose.position.xyz, 1.0);
  let oldP = vec4f(deepPreviousPose[index].position.xyz, 1.0);
  out.world = vec3f(dot(v.row0, p), dot(v.row1, p), dot(v.row2, p));
  out.clip = frame.currentViewProjection * vec4f(out.world, 1.0);
  out.currentClip = out.clip;
  let previousWorld = vec3f(dot(previous.row0, oldP), dot(previous.row1, oldP), dot(previous.row2, oldP));
  out.previousClip = frame.previousViewProjection * vec4f(previousWorld, 1.0);
  out.viewDepth = max(-(frame.worldToView * vec4f(out.world, 1.0)).z, 0.0);
  let n = safeNormalize(mat3x3f(v.normal0.xyz, v.normal1.xyz, v.normal2.xyz) * pose.normal.xyz, vec3f(0.0, 1.0, 0.0));
  out.normal = n;
  out.tangent = vec4f(1.0, 0.0, 0.0, v.material.z);
  if (normalMapped) {
    let t = vec3f(dot(v.row0.xyz, pose.tangent.xyz), dot(v.row1.xyz, pose.tangent.xyz), dot(v.row2.xyz, pose.tangent.xyz));
    out.tangent = vec4f(safeNormalize(t - n * dot(n, t), tangentFallback(n)), pose.tangent.w * v.material.z);
  }
  out.colorMetal = v.colorMetal; out.material = v.material;
  out.uv0 = v.uvSets.xy; out.uv1 = v.uvSets.zw; out.emissiveAlpha = v.emissiveAlpha;
  out.dielectric = deepDielectricF0(v.normal0.w);
  out.authorShadow = deepAuthorShadowCoordinate(out.world, out.normal);
  return out;
}
@vertex fn vertexDeformed(v: Input, previous: PreviousInstanceInput, @builtin(vertex_index) index: u32) -> Vertex {
  return deepPoseVertex(v, previous, index, false);
}
@vertex fn vertexDeformedNormalMapped(v: Input, previous: PreviousInstanceInput, @builtin(vertex_index) index: u32) -> Vertex {
  return deepPoseVertex(v, previous, index, true);
}
@vertex fn shadowDeformed(v: ShadowInput, @builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let p = vec4f(deepCurrentPose[index].position.xyz, 1.0);
  return frame.light * vec4f(dot(v.row0, p), dot(v.row1, p), dot(v.row2, p), 1.0);
}
@vertex fn shadowMaskDeformed(v: ShadowMaskInput, @builtin(vertex_index) index: u32) -> ShadowVertex {
  var out: ShadowVertex;
  let p = vec4f(deepCurrentPose[index].position.xyz, 1.0);
  out.clip = frame.light * vec4f(dot(v.row0, p), dot(v.row1, p), dot(v.row2, p), 1.0);
  out.uv0 = v.uvSets.xy; out.uv1 = v.uvSets.zw;
  out.alphaCutoff = vec2f(v.emissiveAlpha.w, v.material.y);
  return out;
}
`;

/** Consumers must supply bindings 11/12 and preserve indexed vertex ordering for each pose. */
export const deformedSceneShader = `${sceneShader}\n${PBR_DEFORMATION_VERTEX_WGSL}`;
