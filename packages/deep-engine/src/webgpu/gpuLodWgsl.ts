import { GPU_LOD_MAX_LEVELS, GPU_LOD_WORKGROUP_SIZE } from "./gpuLodTypes.js";

export const GPU_LOD_WGSL = /* wgsl */ `
struct ObjectInput { sphere: vec4f, metadata: vec4u }
struct LevelInput {
  threshold: f32,
  geometricError: f32,
  triangles: u32,
  meshletOffset: u32,
  meshletCount: u32,
}
struct SelectionRecord { selection: vec4u, meshlets: vec4u, metrics: vec4f }
struct Params {
  cameraPosition: vec4f,
  cameraForward: vec4f,
  projection: vec4f,
  dispatch: vec4u,
}

@group(0) @binding(0) var<storage, read> objects: array<ObjectInput>;
@group(0) @binding(1) var<storage, read> levels: array<LevelInput>;
@group(0) @binding(2) var<storage, read_write> previousLevels: array<u32>;
@group(0) @binding(3) var<storage, read_write> output: array<SelectionRecord>;
@group(0) @binding(4) var<uniform> params: Params;

fn finite(value: f32) -> bool { return value == value && abs(value) <= 3.402823466e+38; }

fn invalidRecord(objectIndex: u32, instanceIndex: u32) -> SelectionRecord {
  return SelectionRecord(vec4u(0xffffffffu, 0xffffffffu, 0xffffffffu, 8u),
    vec4u(0u, 0u, 0u, instanceIndex), vec4f(0.0));
}

@compute @workgroup_size(${GPU_LOD_WORKGROUP_SIZE})
fn selectLod(@builtin(global_invocation_id) gid: vec3u) {
  let objectIndex = gid.x;
  if (objectIndex >= params.dispatch.x) { return; }
  let object = objects[objectIndex];
  let levelCount = object.metadata.x;
  let validSphere = all(vec4<bool>(finite(object.sphere.x), finite(object.sphere.y), finite(object.sphere.z), finite(object.sphere.w))) && object.sphere.w >= 0.0;
  let validMeta = levelCount > 0u && levelCount <= ${GPU_LOD_MAX_LEVELS}u && finite(bitcast<f32>(object.metadata.w))
    && bitcast<f32>(object.metadata.w) >= 0.0 && bitcast<f32>(object.metadata.w) <= 0.49
    && (object.metadata.y >> levelCount) == 0u;
  var valid = validSphere && validMeta;
  var previousThreshold = 3.402823466e+38;
  var previousError = 0.0;
  var previousTriangles = 0xffffffffu;
  for (var index = 0u; index < levelCount && index < ${GPU_LOD_MAX_LEVELS}u; index += 1u) {
    let level = levels[objectIndex * ${GPU_LOD_MAX_LEVELS}u + index];
    valid = valid && finite(level.threshold) && level.threshold >= 0.0 && finite(level.geometricError) && level.geometricError >= 0.0;
    if (index > 0u) { valid = valid && level.threshold < previousThreshold && level.geometricError >= previousError && level.triangles < previousTriangles; }
    valid = valid && level.triangles > 0u && level.meshletCount > 0u && level.meshletOffset <= 0xffffffffu - level.meshletCount;
    previousThreshold = level.threshold; previousError = level.geometricError; previousTriangles = level.triangles;
  }
  if (valid && levels[objectIndex * ${GPU_LOD_MAX_LEVELS}u + levelCount - 1u].threshold != 0.0) { valid = false; }
  if (!valid) { previousLevels[objectIndex] = 0u; output[objectIndex] = invalidRecord(objectIndex, object.metadata.z); return; }

  let delta = object.sphere.xyz - params.cameraPosition.xyz;
  let depth = dot(delta, params.cameraForward.xyz);
  let visible = depth + object.sphere.w >= params.projection.y && depth - object.sphere.w <= params.projection.z;
  var pixelsPerWorldUnit = 0.0;
  if (visible) {
    pixelsPerWorldUnit = select(params.projection.x / max(depth, params.projection.y), params.projection.x, params.projection.w > 0.5);
  }
  let diameter = 2.0 * object.sphere.w * pixelsPerWorldUnit;
  var baseLevel = levelCount - 1u;
  for (var index = 0u; index < levelCount; index += 1u) {
    if (diameter >= levels[objectIndex * ${GPU_LOD_MAX_LEVELS}u + index].threshold) { baseLevel = index; break; }
  }

  var desiredLevel = baseLevel;
  if (params.dispatch.z == 0u && previousLevels[objectIndex] < levelCount) {
    desiredLevel = previousLevels[objectIndex];
    let hysteresis = bitcast<f32>(object.metadata.w);
    while (desiredLevel > baseLevel) {
      let threshold = levels[objectIndex * ${GPU_LOD_MAX_LEVELS}u + desiredLevel - 1u].threshold;
      if (diameter < threshold * (1.0 + hysteresis)) { break; }
      desiredLevel -= 1u;
    }
    while (desiredLevel < baseLevel) {
      let threshold = levels[objectIndex * ${GPU_LOD_MAX_LEVELS}u + desiredLevel].threshold;
      if (diameter >= threshold * (1.0 - hysteresis)) { break; }
      desiredLevel += 1u;
    }
  }
  previousLevels[objectIndex] = desiredLevel;

  var selectedLevel = 0xffffffffu;
  if (visible) {
    for (var index = desiredLevel; index < levelCount; index += 1u) {
      if ((object.metadata.y & (1u << index)) != 0u) { selectedLevel = index; break; }
    }
  }
  var flags = select(0u, 1u, visible) | select(0u, 4u, params.dispatch.z != 0u);
  var meshlets = vec4u(0u, 0u, 0u, object.metadata.z);
  var projectedError = 0.0;
  if (selectedLevel != 0xffffffffu) {
    let selected = levels[objectIndex * ${GPU_LOD_MAX_LEVELS}u + selectedLevel];
    flags |= 2u; meshlets = vec4u(selected.triangles, selected.meshletOffset, selected.meshletCount, object.metadata.z);
    projectedError = selected.geometricError * pixelsPerWorldUnit;
  }
  output[objectIndex] = SelectionRecord(vec4u(baseLevel, desiredLevel, selectedLevel, flags), meshlets,
    vec4f(diameter, projectedError, pixelsPerWorldUnit, depth));
}
`;
