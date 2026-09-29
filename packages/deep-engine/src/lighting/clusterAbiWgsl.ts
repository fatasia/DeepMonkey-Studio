export const FORWARD_PLUS_CLUSTER_PARAMETER_ABI_VERSION = 2;
export const FORWARD_PLUS_CLUSTER_PARAMETER_BYTES = 80;
export const FORWARD_PLUS_LIGHTING_BIND_GROUP = 3;

/** Shared by cluster assignment compute and group-3 fragment lighting.
 * v2:追加 `area`(面积光 count + 保留,C3);既有字段偏移不变(仅尾部追加)。 */
export const FORWARD_PLUS_CLUSTER_ABI_WGSL = /* wgsl */ `
struct ClusterParamsAbi {
  grid0: vec4<u32>,
  grid1: vec4<u32>,
  limits: vec4<u32>,
  projection: vec4<f32>,
  area: vec4<u32>,
};
struct ClusterHeaderAbi { offset: u32, count: u32 };
`;
