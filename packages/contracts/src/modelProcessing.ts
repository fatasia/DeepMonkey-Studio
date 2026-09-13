/** 优化产物的不可变处理记录；原文件和场景实例身份仍由现有模型合同拥有。 */
export interface ModelProcessingRecord {
  schemaVersion: 1;
  operation: "optimize" | "layers";
  preset: "detail" | "balanced" | "mobile" | "custom";
  optionsJson: string;
  layerEditsJson: string;
  inputFileName: string;
  inputSha256: string;
  /** 由上传服务计算，不接受客户端自报。 */
  outputSha256?: string;
  before: ModelProcessingStatistics;
  after: ModelProcessingStatistics;
}

export interface ModelProcessingStatistics {
  bytes: number; nodes: number; meshes: number; primitives: number;
  triangles: number; vertices: number; materials: number; textures: number;
}
