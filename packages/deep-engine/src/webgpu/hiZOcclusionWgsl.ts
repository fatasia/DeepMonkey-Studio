/// <reference types="@webgpu/types" />
export const HI_Z_OCCLUSION_WGSL = /* wgsl */ `
struct InstanceRow {
  model0: vec4<f32>, model1: vec4<f32>, model2: vec4<f32>,
  normal0: vec4<f32>, normal1: vec4<f32>, normal2: vec4<f32>,
  material0: vec4<f32>, material1: vec4<f32>, material2: vec4<f32>,
};
struct View {
  viewProjection: mat4x4<f32>, cameraPosition: vec4<f32>, viewport: vec4<f32>,
  params: vec4<u32>, tuning: vec4<f32>,
};
struct Counter { value: atomic<u32> };
@group(0) @binding(0) var<storage, read> instances: array<InstanceRow>;
@group(0) @binding(1) var<storage, read> bounds: array<vec4<f32>>;
@group(0) @binding(2) var hiz: texture_2d<f32>;
@group(0) @binding(3) var<storage, read_write> visibleIndices: array<u32>;
@group(0) @binding(4) var<storage, read_write> counter: Counter;
@group(0) @binding(5) var<storage, read_write> indirect: array<u32>;
@group(0) @binding(6) var<storage, read_write> visibilityHistory: array<u32>;
@group(0) @binding(7) var<uniform> view: View;

fn finite4(value: vec4<f32>) -> bool {
  return all((bitcast<vec4<u32>>(value) & vec4<u32>(0x7f800000u)) != vec4<u32>(0x7f800000u));
}

fn worldSphere(instance: InstanceRow, bound: vec4<f32>) -> vec4<f32> {
  let local = vec4<f32>(bound.xyz, 1.0);
  let center = vec3<f32>(dot(instance.model0, local), dot(instance.model1, local), dot(instance.model2, local));
  let largest = max(max(abs(instance.model0.xyz), abs(instance.model1.xyz)), abs(instance.model2.xyz));
  let magnitude = max(max(largest.x, largest.y), largest.z);
  var stretch = 0.0;
  if (magnitude > 0.0) {
    // Normalize first so AᵀA cannot overflow/underflow for finite nonzero bases.
    let a = instance.model0.xyz / magnitude; let b = instance.model1.xyz / magnitude;
    let c = instance.model2.xyz / magnitude;
    let x = vec3<f32>(a.x, b.x, c.x); let y = vec3<f32>(a.y, b.y, c.y); let z = vec3<f32>(a.z, b.z, c.z);
    let xy = abs(dot(x, y)); let xz = abs(dot(x, z)); let yz = abs(dot(y, z));
    let gramBound = max(max(dot(x, x) + xy + xz, dot(y, y) + xy + yz), dot(z, z) + xz + yz);
    let r0 = abs(a); let r1 = abs(b); let r2 = abs(c);
    let normInf = max(max(r0.x + r0.y + r0.z, r1.x + r1.y + r1.z), r2.x + r2.y + r2.z);
    let normOne = max(max(r0.x + r1.x + r2.x, r0.y + r1.y + r2.y), r0.z + r1.z + r2.z);
    // Both bound σ²; Gershgorin removes rotation-only inflation. Allow f32 sum/division/sqrt error.
    stretch = magnitude * sqrt(max(min(normInf * normOne, gramBound), 0.0)) * 1.000002;
  }
  let centerError = length(vec3<f32>(dot(abs(instance.model0), abs(local)),
    dot(abs(instance.model1), abs(local)), dot(abs(instance.model2), abs(local)))) * 0.000002;
  return vec4<f32>(center, bound.w * stretch + centerError);
}

fn sampleVisible(objectNear: f32, coord: vec2<u32>, mip: u32, reversedZ: bool, bias: f32) -> bool {
  let depth = textureLoad(hiz, vec2<i32>(coord), i32(mip)).x;
  if (depth != depth || depth < 0.0 || depth > 1.0) { return true; }
  return select(objectNear <= depth + bias, objectNear >= depth - bias, reversedZ);
}

fn testOcclusion(instance: InstanceRow, bound: vec4<f32>) -> bool {
  if (!finite4(bound) || bound.w < 0.0 || !finite4(instance.model0)
    || !finite4(instance.model1) || !finite4(instance.model2)) { return true; }
  let sphere = worldSphere(instance, bound);
  if (!finite4(sphere) || any(abs(sphere) > vec4<f32>(1e30)) || (bound.w > 0.0 && sphere.w <= 0.0)) { return true; }
  let boxMin = sphere.xyz - vec3<f32>(sphere.w);
  let boxMax = sphere.xyz + vec3<f32>(sphere.w);
  if (all(view.cameraPosition.xyz >= boxMin) && all(view.cameraPosition.xyz <= boxMax)) { return true; }
  var ndcMin = vec3<f32>(1e30);
  var ndcMax = vec3<f32>(-1e30);
  let reversedZ = (view.params.w & 1u) != 0u;
  var objectNear = select(1.0, 0.0, reversedZ);
  for (var corner = 0u; corner < 8u; corner++) {
    let world = vec3<f32>(select(boxMin.x, boxMax.x, (corner & 1u) != 0u),
      select(boxMin.y, boxMax.y, (corner & 2u) != 0u), select(boxMin.z, boxMax.z, (corner & 4u) != 0u));
    let clip = view.viewProjection * vec4<f32>(world, 1.0);
    if (!finite4(clip) || any(abs(clip) > vec4<f32>(1e30)) || clip.w <= view.tuning.y) { return true; }
    let ndc = clip.xyz / clip.w;
    if (ndc.z <= 0.0 || ndc.z >= 1.0) { return true; }
    ndcMin = min(ndcMin, ndc); ndcMax = max(ndcMax, ndc);
    objectNear = select(min(objectNear, ndc.z), max(objectNear, ndc.z), reversedZ);
  }
  // Every corner has a valid positive w above, so perspective projection keeps the
  // AABB convex. A rectangle wholly outside one clip edge is safely invisible.
  if (ndcMax.x <= -1.0 || ndcMin.x >= 1.0 || ndcMax.y <= -1.0 || ndcMin.y >= 1.0) { return false; }
  let uvA = clamp(vec2<f32>(ndcMin.x * 0.5 + 0.5, 0.5 - ndcMax.y * 0.5), vec2<f32>(0.0), vec2<f32>(1.0));
  let uvB = clamp(vec2<f32>(ndcMax.x * 0.5 + 0.5, 0.5 - ndcMin.y * 0.5), vec2<f32>(0.0), vec2<f32>(1.0));
  let extent = max((uvB - uvA) * view.viewport.xy, vec2<f32>(1.0));
  let mip = min(u32(ceil(log2(max(extent.x, extent.y)))), view.params.z - 1u);
  let mipSize = textureDimensions(hiz, i32(mip));
  let last = mipSize - vec2<u32>(1u);
  let texelA = min(vec2<u32>(floor(uvA * vec2<f32>(mipSize))), last);
  let texelB = min(vec2<u32>(floor(uvB * vec2<f32>(mipSize))), last);
  let bias = view.tuning.x;
  if (sampleVisible(objectNear, vec2<u32>(texelA.x, texelA.y), mip, reversedZ, bias)) { return true; }
  if (sampleVisible(objectNear, vec2<u32>(texelB.x, texelA.y), mip, reversedZ, bias)) { return true; }
  if (sampleVisible(objectNear, vec2<u32>(texelA.x, texelB.y), mip, reversedZ, bias)) { return true; }
  if (sampleVisible(objectNear, vec2<u32>(texelB.x, texelB.y), mip, reversedZ, bias)) { return true; }
  return false;
}

@compute @workgroup_size(64)
fn cull(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= view.params.x || id.x >= view.params.y) { return; }
  let visibleNow = testOcclusion(instances[id.x], bounds[id.x]);
  let keepForHistory = (view.params.w & 2u) != 0u && visibilityHistory[id.x] != 0u;
  visibilityHistory[id.x] = select(0u, 1u, visibleNow);
  if (visibleNow || keepForHistory) {
    let destination = atomicAdd(&counter.value, 1u);
    if (destination < view.params.y) { visibleIndices[destination] = id.x; }
  }
}

@compute @workgroup_size(1)
fn writeIndirect(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x == 0u) { indirect[1] = min(atomicLoad(&counter.value), view.params.y); }
}
`;
