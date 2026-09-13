/// <reference types="@webgpu/types" />

export const HI_Z_INSTANCE_COMPACTION_WORKGROUP_SIZE = 64;

export const HI_Z_INSTANCE_COMPACTION_WGSL = /* wgsl */ `
struct InstanceRow {
  model0: vec4<f32>, model1: vec4<f32>, model2: vec4<f32>,
  normal0: vec4<f32>, normal1: vec4<f32>, normal2: vec4<f32>,
  material0: vec4<f32>, material1: vec4<f32>, material2: vec4<f32>,
};

struct PreviousTransform {
  model0: vec4<f32>, model1: vec4<f32>, model2: vec4<f32>,
};

@group(0) @binding(0) var<storage, read> sourceInstances: array<InstanceRow>;
@group(0) @binding(1) var<storage, read> sourcePrevious: array<PreviousTransform>;
@group(0) @binding(2) var<storage, read> visibleIndices: array<u32>;
@group(0) @binding(3) var<storage, read> visibleCount: array<u32>;
@group(0) @binding(4) var<storage, read_write> compactedInstances: array<InstanceRow>;
@group(0) @binding(5) var<storage, read_write> compactedPrevious: array<PreviousTransform>;

@compute @workgroup_size(64)
fn compact(@builtin(global_invocation_id) id: vec3<u32>) {
  let destination = id.x;
  let count = min(visibleCount[0], arrayLength(&visibleIndices));
  if (destination >= count || destination >= arrayLength(&compactedInstances)
      || destination >= arrayLength(&compactedPrevious)) { return; }
  let source = visibleIndices[destination];
  if (source >= arrayLength(&sourceInstances) || source >= arrayLength(&sourcePrevious)) { return; }
  compactedInstances[destination] = sourceInstances[source];
  compactedPrevious[destination] = sourcePrevious[source];
}
`;
