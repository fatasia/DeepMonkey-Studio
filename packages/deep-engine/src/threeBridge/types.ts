import type { RenderPacket } from "../renderPacket.js";

/** 结构合同；调用方更新 world matrix，适配器不调用作者方法或执行渲染钩子。 */
export interface ThreeObjectSource {
  readonly children: readonly ThreeObjectSource[];
  readonly visible: boolean;
  readonly layers: { readonly mask: number };
  readonly matrixWorld: { readonly elements: ArrayLike<number> };
  readonly type: string;
}

/** 从已使用的 THREE.Object3D / THREE.Material 原型传入，保持运行时零 Three 依赖。 */
export interface ThreeProjectionHooks {
  readonly objectBeforeRender: unknown;
  readonly objectAfterRender: unknown;
  readonly objectBeforeShadow: unknown;
  readonly objectAfterShadow: unknown;
  readonly materialBeforeRender: unknown;
  readonly materialBeforeCompile: unknown;
  readonly materialProgramCacheKey: unknown;
}
export interface ProjectionIssue {
  readonly code: "unsupported" | "invalid" | "limit";
  readonly objectId: string;
  readonly path: string;
  readonly feature: string;
  readonly message: string;
}
export type ProjectionResult = {
  readonly ok: true;
  readonly packet: RenderPacket;
  /** 相对于最近 acknowledge 成功的投影；full 必须走验证后的完整上传。 */
  readonly update: "full" | "instances";
  /** GPU 接受以后调用。新的 project / clear 会使旧候选失效，不修改作者对象。 */
  acknowledge(): boolean;
} | { readonly ok: false; readonly issues: readonly ProjectionIssue[] };

export interface IncrementalProjectionMetrics {
  readonly mode: "incremental" | "full-fallback";
  readonly sourceObjectCount: number;
  readonly rebuiltObjectCount: number;
  readonly reusedObjectCount: number;
  readonly allocatedInstanceCount: number;
}

export type IncrementalProjectionResult = ProjectionResult & { readonly metrics: IncrementalProjectionMetrics };

export class ProjectionFailure extends Error {
  constructor(readonly code: ProjectionIssue["code"], readonly feature: string, message: string) { super(message); }
}
export function unsupported(feature: string): never {
  throw new ProjectionFailure("unsupported", feature, `Three projection does not support ${feature}.`);
}
export function invalid(feature: string): never {
  throw new ProjectionFailure("invalid", feature, `Invalid Three ${feature}.`);
}
export function limit(feature: string): never {
  throw new ProjectionFailure("limit", feature, `Three projection exceeds ${feature} limit.`);
}
export function record(value: unknown, feature: string): Record<string, unknown> {
  if (!value || typeof value !== "object") invalid(feature);
  return value as Record<string, unknown>;
}
