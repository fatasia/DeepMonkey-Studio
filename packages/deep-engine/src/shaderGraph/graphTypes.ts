import type { ShaderNode, ShaderStage, ShaderValueType } from "../shader/types.js";

export const SHADER_GRAPH_SCHEMA_VERSION = 1 as const;
export type ShaderGraphTarget = "webgpu-forward" | "webgpu-depth" | "webgpu-shadow" | "webgpu-picking";

export interface ShaderGraphPortMetadata {
  readonly name: string;
  readonly direction: "input" | "output";
  readonly type: ShaderValueType;
  readonly required?: boolean;
}

export interface ShaderGraphNodeMetadata {
  readonly op: ShaderNode["op"];
  readonly label: string;
  readonly category: "input" | "math" | "texture" | "surface" | "stage" | "geometry";
  readonly stages: readonly ShaderStage[];
  readonly ports: readonly ShaderGraphPortMetadata[];
  readonly preview: "scalar" | "vector" | "color" | "none";
  /** 边输入端口数;省略 = 该 op 不吃边输入(literal/property 等符号源)。 */
  readonly inputCount?: number;
}

export interface ShaderGraphNodeInstance {
  readonly id: string;
  readonly op: ShaderNode["op"];
  readonly type: ShaderValueType;
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface ShaderGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly input?: number;
}

export interface ShaderGraphStage {
  readonly stage: ShaderStage;
  readonly nodes: readonly ShaderGraphNodeInstance[];
  readonly edges: readonly ShaderGraphEdge[];
  readonly outputs: readonly Readonly<Record<string, unknown>>[];
}

export interface ShaderGraphAssetV1 {
  readonly schemaVersion: typeof SHADER_GRAPH_SCHEMA_VERSION;
  readonly id: string;
  readonly label?: string;
  readonly target: ShaderGraphTarget;
  readonly properties: readonly Readonly<Record<string, unknown>>[];
  readonly stages: readonly ShaderGraphStage[];
  readonly dependencies?: readonly string[];
}

export interface ShaderGraphDiagnostic {
  readonly severity: "error" | "warning";
  readonly code: "unknown-node" | "duplicate-node" | "missing-edge" | "invalid-stage" | "cycle" | "budget"
    | "missing-input" | "extra-input" | "dangling-output" | "duplicate-edge" | "lowering-error";
  readonly path: string;
  readonly message: string;
  /** 归因:出错的节点 id(画布标红与错误面板定位消费)。 */
  readonly nodeId?: string;
  /** 归因:出错的边,键形如 `${to}#${input ?? 0}`(与画布边数据同键)。 */
  readonly edgeKey?: string;
}

export interface ShaderGraphValidationResult {
  readonly valid: boolean;
  readonly diagnostics: readonly ShaderGraphDiagnostic[];
}
