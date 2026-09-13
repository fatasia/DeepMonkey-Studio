export const MESHLET_CULL_WORKGROUP_SIZE = 256;

export const MESHLET_CULL_WGSL = /* wgsl */ `
struct Descriptor { vertexOffset: u32, vertexCount: u32, triangleOffset: u32, triangleCount: u32 };
struct MeshletBounds { sphere: vec4<f32>, boxMin: vec4<f32>, boxMax: vec4<f32>, cone: vec4<f32> };
struct PlannerRecord { header: vec4<u32>, draw: vec4<u32> };
struct View {
  viewProjection: mat4x4<f32>, worldFromObject: mat4x4<f32>,
  coneCamera: vec4<f32>, camera: vec4<f32>,
  frustum: array<vec4<f32>, 6>, viewport: vec4<f32>, params: vec4<u32>, tuning: vec4<f32>,
};
@group(0) @binding(0) var<storage, read> descriptors: array<Descriptor>;
@group(0) @binding(1) var<storage, read> bounds: array<MeshletBounds>;
@group(0) @binding(2) var hiz: texture_2d<f32>;
@group(0) @binding(3) var<storage, read_write> flags: array<u32>;
@group(0) @binding(4) var<storage, read_write> localPrefix: array<u32>;
@group(0) @binding(5) var<storage, read_write> blockOffsets: array<u32>;
@group(0) @binding(6) var<storage, read_write> visibleIndices: array<u32>;
@group(0) @binding(7) var<storage, read_write> visibleRecords: array<PlannerRecord>;
@group(0) @binding(8) var<storage, read_write> visibleCount: array<u32>;
@group(0) @binding(9) var<uniform> view: View;

fn invalid4(value: vec4<f32>) -> bool { return any(value != value) || any(abs(value) > vec4<f32>(1e30)); }

fn worldPoint(point: vec3<f32>) -> vec3<f32> {
  let value = view.worldFromObject * vec4<f32>(point, 1.0);
  return value.xyz;
}

fn worldSphere(value: vec4<f32>) -> vec4<f32> {
  let center = worldPoint(value.xyz);
  let r0 = abs(view.worldFromObject[0].xyz);
  let r1 = abs(view.worldFromObject[1].xyz);
  let r2 = abs(view.worldFromObject[2].xyz);
  let normOne = max(max(r0.x + r0.y + r0.z, r1.x + r1.y + r1.z), r2.x + r2.y + r2.z);
  let normInf = max(max(r0.x + r1.x + r2.x, r0.y + r1.y + r2.y), r0.z + r1.z + r2.z);
  return vec4<f32>(center, max(value.w, 0.0) * sqrt(max(normOne * normInf, 0.0)));
}

fn inFrustum(sphere: vec4<f32>) -> bool {
  for (var plane = 0u; plane < 6u; plane++) {
    if (dot(view.frustum[plane].xyz, sphere.xyz) + view.frustum[plane].w < -sphere.w) { return false; }
  }
  return true;
}

fn coneCulled(bound: MeshletBounds) -> bool {
  if ((view.params.w & 4u) == 0u || bound.cone.w < 0.0) { return false; }
  if (bound.cone.w > 1.0 || invalid4(bound.cone)) { return false; }
  let toCamera = view.coneCamera.xyz - bound.sphere.xyz;
  let distance = length(toCamera);
  let radius = (bound.sphere.w + view.tuning.w) * 1.0000004;
  if (distance <= radius || distance <= 1e-8 || invalid4(vec4<f32>(toCamera, distance))) { return false; }
  let axisLength = length(bound.cone.xyz);
  if (axisLength <= 1e-8 || axisLength != axisLength) { return false; }
  let axis = bound.cone.xyz * view.coneCamera.w / axisLength;
  let spatialSin = clamp(radius / distance, 0.0, 1.0);
  if (bound.cone.w <= spatialSin) { return false; }
  let spatialCos = sqrt(max(1.0 - spatialSin * spatialSin, 0.0));
  let coneSin = sqrt(max(1.0 - bound.cone.w * bound.cone.w, 0.0));
  let totalSin = coneSin * spatialCos + bound.cone.w * spatialSin;
  if (totalSin >= 1.0) { return false; }
  return dot(axis, toCamera / distance) <= -totalSin - view.tuning.z;
}

fn sampleVisible(objectNear: f32, coord: vec2<u32>, mip: u32, reversedZ: bool) -> bool {
  let depth = textureLoad(hiz, vec2<i32>(coord), i32(mip)).x;
  if (depth != depth || depth < 0.0 || depth > 1.0) { return true; }
  return select(objectNear <= depth + view.tuning.x, objectNear >= depth - view.tuning.x, reversedZ);
}

fn hizVisible(bound: MeshletBounds) -> bool {
  if ((view.params.w & 2u) == 0u) { return true; }
  var ndcMin = vec3<f32>(1e30); var ndcMax = vec3<f32>(-1e30);
  var worldMin = vec3<f32>(1e30); var worldMax = vec3<f32>(-1e30);
  let reversedZ = (view.params.w & 1u) != 0u;
  var objectNear = select(1.0, 0.0, reversedZ);
  for (var corner = 0u; corner < 8u; corner++) {
    let local = vec3<f32>(select(bound.boxMin.x, bound.boxMax.x, (corner & 1u) != 0u),
      select(bound.boxMin.y, bound.boxMax.y, (corner & 2u) != 0u),
      select(bound.boxMin.z, bound.boxMax.z, (corner & 4u) != 0u));
    let world = worldPoint(local); worldMin = min(worldMin, world); worldMax = max(worldMax, world);
    let clip = view.viewProjection * vec4<f32>(world, 1.0);
    if (invalid4(clip) || clip.w <= view.tuning.y) { return true; }
    let ndc = clip.xyz / clip.w;
    if (ndc.z <= 0.0 || ndc.z >= 1.0) { return true; }
    ndcMin = min(ndcMin, ndc); ndcMax = max(ndcMax, ndc);
    objectNear = select(min(objectNear, ndc.z), max(objectNear, ndc.z), reversedZ);
  }
  if (all(view.camera.xyz >= worldMin) && all(view.camera.xyz <= worldMax)) { return true; }
  if (ndcMax.x <= -1.0 || ndcMin.x >= 1.0 || ndcMax.y <= -1.0 || ndcMin.y >= 1.0) { return true; }
  let uvA = clamp(vec2<f32>(ndcMin.x * 0.5 + 0.5, 0.5 - ndcMax.y * 0.5), vec2<f32>(0.0), vec2<f32>(1.0));
  let uvB = clamp(vec2<f32>(ndcMax.x * 0.5 + 0.5, 0.5 - ndcMin.y * 0.5), vec2<f32>(0.0), vec2<f32>(1.0));
  let extent = max((uvB - uvA) * view.viewport.xy, vec2<f32>(1.0));
  let mip = min(u32(ceil(log2(max(extent.x, extent.y)))), view.params.z - 1u);
  let size = textureDimensions(hiz, i32(mip)); let last = size - vec2<u32>(1u);
  let a = min(vec2<u32>(floor(uvA * vec2<f32>(size))), last);
  let b = min(vec2<u32>(floor(uvB * vec2<f32>(size))), last);
  return sampleVisible(objectNear, vec2<u32>(a.x, a.y), mip, reversedZ)
    || sampleVisible(objectNear, vec2<u32>(b.x, a.y), mip, reversedZ)
    || sampleVisible(objectNear, vec2<u32>(a.x, b.y), mip, reversedZ)
    || sampleVisible(objectNear, vec2<u32>(b.x, b.y), mip, reversedZ);
}

@compute @workgroup_size(256)
fn classify(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= view.params.x || id.x >= view.params.y) { return; }
  let bound = bounds[id.x];
  if (invalid4(bound.sphere) || invalid4(bound.boxMin) || invalid4(bound.boxMax)
    || bound.sphere.w < 0.0 || any(bound.boxMin.xyz > bound.boxMax.xyz)) { flags[id.x] = 1u; return; }
  let sphere = worldSphere(bound.sphere);
  if (invalid4(sphere)) { flags[id.x] = 1u; return; }
  if (distance(view.camera.xyz, sphere.xyz) <= sphere.w) { flags[id.x] = 1u; return; }
  if (!inFrustum(sphere)) { flags[id.x] = 0u; return; }
  if (coneCulled(bound)) { flags[id.x] = 0u; return; }
  flags[id.x] = select(0u, 1u, hizVisible(bound));
}

var<workgroup> scanValues: array<u32, 256>;
@compute @workgroup_size(256)
fn scanLocal(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_id) local: vec3<u32>,
  @builtin(workgroup_id) group: vec3<u32>) {
  var present = 0u;
  if (id.x < view.params.x && id.x < view.params.y) { present = flags[id.x]; }
  scanValues[local.x] = present; workgroupBarrier();
  var step = 1u;
  while (step < 256u) {
    var add = 0u; if (local.x >= step) { add = scanValues[local.x - step]; }
    workgroupBarrier(); scanValues[local.x] = scanValues[local.x] + add; workgroupBarrier(); step = step * 2u;
  }
  if (id.x < view.params.x && id.x < view.params.y) { localPrefix[id.x] = scanValues[local.x] - present; }
  if (local.x == 255u) { blockOffsets[group.x] = scanValues[255u]; }
}

@compute @workgroup_size(1)
fn scanBlocks() {
  let blocks = (view.params.x + 255u) / 256u; var running = 0u;
  for (var block = 0u; block < blocks; block++) {
    let count = blockOffsets[block]; blockOffsets[block] = running; running = running + count;
  }
  visibleCount[0] = min(running, view.params.y);
}

@compute @workgroup_size(256)
fn compact(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= view.params.x || id.x >= view.params.y || flags[id.x] == 0u) { return; }
  let destination = blockOffsets[id.x / 256u] + localPrefix[id.x];
  if (destination >= view.params.y) { return; }
  let descriptor = descriptors[id.x];
  visibleIndices[destination] = id.x;
  visibleRecords[destination].header = vec4<u32>(id.x, descriptor.vertexOffset, descriptor.vertexCount, descriptor.triangleOffset);
  visibleRecords[destination].draw = vec4<u32>(descriptor.triangleCount,
    descriptor.triangleCount * 3u, descriptor.triangleOffset * 3u, 0u);
}
`;
