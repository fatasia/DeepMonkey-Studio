import type { ApplicationDocument, DataConnectionRecord, DataDatasetRecord, DataPipelineDefinition, ProjectRecord } from "./index.js";
import type { ScenePublicationCompatibilityReport } from "./scenePublicationCompatibility.js";

/** 仅由服务端候选编译和窗口验证流程生成，不接受发布请求自行声明。 */
export interface SceneNativeCompiledPublication {
  runtimePackage: { key: string; bytes: number; sha256: string };
  compilationEvidence: Record<string, unknown>;
  compatibilityReport: ScenePublicationCompatibilityReport;
  compilerSha256: string;
  executableSha256: string;
  verifiedAt: string;
}

/** 服务端保护的交付输入，不附加到匿名发布记录。 */
export interface SceneClientDependencyInputs {
  project: Pick<ProjectRecord, "id" | "name" | "description" | "models" | "assets">;
  applications: ApplicationDocument[];
  runtime: { connections: DataConnectionRecord[]; datasets: DataDatasetRecord[]; pipelines: DataPipelineDefinition[] };
  resources: Array<{ id: string; name: string; url: string;
    claims: Array<{ bytes?: number; sha256?: string; integrity?: string }> }>;
}

export interface ScenePublicationDependencies {
  schemaVersion: 1;
  projectId: string;
  sceneId: string;
  version: number;
  publishedAt: string;
  publicationIdentity: string;
  inputs: SceneClientDependencyInputs;
  resources: Array<{ sourceUrl: string; key: string; bytes: number; sha256: string }>;
  nativeCompiled?: SceneNativeCompiledPublication;
}

export interface SceneClientDependencyExpectation {
  inputs: SceneClientDependencyInputs;
  resources: Array<{ sourceUrl: string; bytes: number; sha256: string }>;
}
