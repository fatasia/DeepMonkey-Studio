/**
 * DCIR v0（Deep Compute IR）：跨后端确定性 compute 内核的类型化节点 DAG。
 * 设计依据与 op 白名单语义合同见 `docs/specs/r2-shader-ir-design-2026-09-19.md` §2.3/§4。
 * 节点表必须按依赖序排列；两个发射器（WGSL/GLSL）按同一顺序逐节点展开，保证求值顺序同构。
 */

export const DCIR_SCHEMA_VERSION = 1 as const;

/** v1:只读 storage buffer(WebGPU/Native 专用;WebGL2 无 SSBO,发射期 fail-closed)。 */
export type DcirBufferElementType = "u32" | "f32";

export interface DcirStorageBuffer {
  readonly name: string;
  readonly elementType: DcirBufferElementType;
  /** v1 read-only; v2 read_write is WebGPU/Native only and fails closed in GLSL. */
  readonly access: "read" | "read_write";
}

export interface DcirLoopRange {
  readonly id: string;
  readonly indexId: string;
  /** Compile-time static range: [start, end), step > 0. */
  readonly start: number;
  readonly end: number;
  readonly step: number;
  readonly body: readonly DcirNode[];
}

export type DcirValueType = "u32" | "f32" | "vec2u" | "bool";
export type DcirUniformType = "u32" | "vec2u";

export interface DcirUniform {
  readonly name: string;
  readonly type: DcirUniformType;
}

interface DcirNodeBase {
  readonly id: string;
  readonly type: DcirValueType;
}

export type DcirNode =
  | (DcirNodeBase & Readonly<{ op: "global-invocation-id" }>)
  | (DcirNodeBase & Readonly<{ op: "kernel-uniform"; uniform: string }>)
  | (DcirNodeBase & Readonly<{ op: "literal"; value: number | boolean }>)
  | (DcirNodeBase & Readonly<{
      op: "iadd" | "isub" | "imul" | "idiv" | "imin" | "imax";
      type: "u32";
      inputs: readonly [string, string];
    }>)
  | (DcirNodeBase & Readonly<{ op: "ieq" | "ult"; type: "bool"; inputs: readonly [string, string] }>)
  | (DcirNodeBase & Readonly<{ op: "make-vec2u"; type: "vec2u"; inputs: readonly [string, string] }>)
  | (DcirNodeBase & Readonly<{ op: "component"; input: string; component: 0 | 1 }>)
  | (DcirNodeBase & Readonly<{ op: "loop-index"; type: "u32"; loopId: string }>)
  | (DcirNodeBase & Readonly<{ op: "fmin" | "fmax"; type: "f32"; inputs: readonly [string, string] }>)
  | (DcirNodeBase & Readonly<{ op: "canonicalize-f32"; type: "f32"; input: string }>)
  | (DcirNodeBase & Readonly<{ op: "select"; inputs: readonly [string, string, string] }>)
  | (DcirNodeBase & Readonly<{ op: "texel-load"; type: "f32"; coords: string }>)
  | (DcirNodeBase & Readonly<{
      op: "buffer-load";
      type: DcirBufferElementType;
      buffer: string;
      /** u32 索引节点(元素下标,非字节偏移)。 */
      index: string;
    }>)
  | (DcirNodeBase & Readonly<{
      op: "buffer-store";
      type: DcirBufferElementType;
      buffer: string;
      index: string;
      value: string;
    }>)
  | (DcirNodeBase & Readonly<{
      op: "hash-rng";
      type: "u32";
      seed: string;
      salt: string;
    }>);

export interface DcirKernelOutput {
  /** vec2u 节点：目标写入坐标。 */
  readonly coords: string;
  /** f32 节点：写入值（必须已经 canonicalize，见确定性合同）。 */
  readonly value: string;
}

export interface DcirKernel {
  readonly name: string;
  /** v0 固定 (8, 8)；片段降级下 dispatch 尺寸即 viewport。 */
  readonly workgroupSize: readonly [number, number];
  readonly uniforms: readonly DcirUniform[];
  /** v1 只读 storage buffer;声明了 buffer 的内核不可发射 GLSL(WebGL2 无 SSBO)。 */
  readonly buffers?: readonly DcirStorageBuffer[];
  /** 依赖序节点表（引用只允许指向更早的节点，同时保证无环与确定性展开顺序）。 */
  readonly nodes: readonly DcirNode[];
  /** v1 静态定次循环；GLSL/WebGL2 对含循环内核整体 fail-closed。 */
  readonly loops?: readonly DcirLoopRange[];
  /** bool 节点：为假时该次调用提前退出（片段侧 discard，不写目标）。 */
  readonly guard: string;
  readonly output: DcirKernelOutput;
}

export interface DcirKernelArtifacts {
  /** IR 内容哈希（canonical JSON + 纯 TS sha256，键序为码点序）。 */
  readonly irSha256: string;
  readonly wgsl: string;
  readonly glsl: Readonly<{ vertex: string; fragment: string }>;
}
