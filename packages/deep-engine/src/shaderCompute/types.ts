/**
 * DCIR v0（Deep Compute IR）：跨后端确定性 compute 内核的类型化节点 DAG。
 * 设计依据与 op 白名单语义合同见 `docs/specs/r2-shader-ir-design-2026-09-19.md` §2.3/§4。
 * 节点表必须按依赖序排列；两个发射器（WGSL/GLSL）按同一顺序逐节点展开，保证求值顺序同构。
 */

export const DCIR_SCHEMA_VERSION = 1 as const;

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
  | (DcirNodeBase & Readonly<{ op: "fmin" | "fmax"; type: "f32"; inputs: readonly [string, string] }>)
  | (DcirNodeBase & Readonly<{ op: "canonicalize-f32"; type: "f32"; input: string }>)
  | (DcirNodeBase & Readonly<{ op: "select"; inputs: readonly [string, string, string] }>)
  | (DcirNodeBase & Readonly<{ op: "texel-load"; type: "f32"; coords: string }>);

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
  /** 依赖序节点表（引用只允许指向更早的节点，同时保证无环与确定性展开顺序）。 */
  readonly nodes: readonly DcirNode[];
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
