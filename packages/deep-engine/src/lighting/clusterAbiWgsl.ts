export const FORWARD_PLUS_CLUSTER_PARAMETER_ABI_VERSION = 1;
export const FORWARD_PLUS_CLUSTER_PARAMETER_BYTES = 64;
export const FORWARD_PLUS_LIGHTING_BIND_GROUP = 3;

/** Shared by cluster assignment compute and group-3 fragment lighting. */
export const FORWARD_PLUS_CLUSTER_ABI_WGSL = /* wgsl */ `
struct ClusterParamsAbi {
  grid0: vec4<u32>,
  grid1: vec4<u32>,
  limits: vec4<u32>,
  projection: vec4<f32>,
};
struct ClusterHeaderAbi { offset: u32, count: u32 };
`;
