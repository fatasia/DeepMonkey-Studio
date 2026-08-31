export type ParametricCadParameterUnit = "mm" | "deg" | "count";
export type ParametricCadValue = number | string;
export type ParametricCadPrimitive = "box" | "cylinder" | "sphere" | "ellipsoid";
export type ParametricCadOperation = "base" | "union" | "cut" | "intersect";

export interface ParametricCadParameter {
  id: string;
  label: string;
  unit: ParametricCadParameterUnit;
  value: number;
  min: number;
  max: number;
  step: number;
  semantic?: string;
}

export interface ParametricCadFeature {
  id: string;
  label: string;
  primitive: ParametricCadPrimitive;
  operation: ParametricCadOperation;
  size?: [ParametricCadValue, ParametricCadValue, ParametricCadValue];
  radius?: ParametricCadValue;
  height?: ParametricCadValue;
  axes?: [ParametricCadValue, ParametricCadValue, ParametricCadValue];
  position: [ParametricCadValue, ParametricCadValue, ParametricCadValue];
  rotation?: [ParametricCadValue, ParametricCadValue, ParametricCadValue];
}

export interface ParametricCadSemanticBinding {
  parameterId: string;
  source: string;
  meaning: string;
  /** 可选的孪生变量或仿真信号标识，用于把几何参数接入运行工作流。 */
  targetId?: string;
  /** 结构化运行绑定；保存时必须能解析到当前项目的数据连接与字段。 */
  target?: ParametricCadBindingTarget;
}

export type ParametricCadBindingKind = "dataset-field" | "simulation-signal" | "device-point";

export interface ParametricCadBindingTarget {
  kind: ParametricCadBindingKind;
  connectionId: string;
  datasetId: string;
  field: string;
}

export interface ParametricCadDefinition {
  schemaVersion: 1;
  name: string;
  summary: string;
  unit: "mm";
  parameters: ParametricCadParameter[];
  features: ParametricCadFeature[];
  edgeTreatment?: { kind: "fillet" | "chamfer"; radius: ParametricCadValue };
  semanticBindings?: ParametricCadSemanticBinding[];
}

export interface ParametricCadBuildSummary {
  durationMs: number;
  volumeMm3: number;
  faceCount: number;
  edgeCount: number;
  triangleCount: number;
  bounds: [[number, number, number], [number, number, number]];
  warnings: string[];
}

/**
 * 跟随模型资源保存的可追溯生成信息。STEP 是不可变制品，修改参数会创建新模型版本，
 * 不在原资源上做隐式覆盖，确保既有场景可复现。
 */
export interface ParametricModelGeneration {
  kind: "parametric";
  generatorId: "bim.parametric-modeling";
  generatorVersion: string;
  definition: ParametricCadDefinition;
  revision: number;
  generatedAt: string;
  build: ParametricCadBuildSummary;
  supersedesModelId?: string;
}
