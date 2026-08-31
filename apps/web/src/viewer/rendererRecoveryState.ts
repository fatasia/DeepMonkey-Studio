import type { SceneSnapshot } from "@bim-studio/contracts";

/** 渲染器重建时必须无损保留的场景与运行策略。 */
export interface RendererRecoveryState {
  scene: SceneSnapshot;
  readOnly: boolean;
  fastRuntime?: boolean;
  recoveryMessage?: string;
  temporaryBackend?: boolean;
}
