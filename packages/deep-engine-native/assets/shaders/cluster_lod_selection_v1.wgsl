// Cluster LOD screen-error selection kernel (wave 3). Byte layout contract: clusterLodSelection.ts.
// Selection formula arbitrates against clusterLodSelection.clusterScreenError (CPU reference).
const REFINE_SENTINEL: u32 = 4294967295u;
const MIN_VIEW_DEPTH: f32 = 0.000001;
const DEFAULT_PIXEL_THRESHOLD: f32 = 1.0;

struct ClusterLodNode {
  boundsMin: vec4f,
  boundsMax: vec4f,
  errorScalar: f32,
  lodLevel: u32,
  clusterIndex: u32,
  firstTriangle: u32,
  triangleCount: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
}
struct Params {
  camPositionTanHalf: vec4f,
  forwardThreshold: vec4f,
  viewportNodeCount: vec4f,
}

@group(0) @binding(0) var<storage, read> clusterNodes: array<ClusterLodNode>;
@group(0) @binding(1) var<storage, read_write> selection: array<u32>;
@group(0) @binding(2) var<storage, read_write> selectionFaults: atomic<u32>;
@group(0) @binding(3) var<uniform> params: Params;

@compute @workgroup_size(64)
fn select_cluster_lod(@builtin(global_invocation_id) gid: vec3u) {
  let nodeIndex = gid.x;
  if (nodeIndex >= u32(params.viewportNodeCount.y)) { return; }
  let node = clusterNodes[nodeIndex];
  let center = (node.boundsMin.xyz + node.boundsMax.xyz) * 0.5;
  let depth = max(dot(center - params.camPositionTanHalf.xyz, params.forwardThreshold.xyz), MIN_VIEW_DEPTH);
  let screenError = node.errorScalar * params.viewportNodeCount.x / (2.0 * depth * params.camPositionTanHalf.w);
  var chosen: u32 = REFINE_SENTINEL;
  if (node.triangleCount > 0u && screenError <= params.forwardThreshold.w) {
    chosen = node.lodLevel;
  }
  if (!(screenError >= 0.0)) {
    // Fail-closed: non-finite/negative screen error poisons the batch via the sentinel.
    atomicAdd(&selectionFaults, 1u);
    chosen = REFINE_SENTINEL;
  }
  selection[nodeIndex] = chosen;
}
