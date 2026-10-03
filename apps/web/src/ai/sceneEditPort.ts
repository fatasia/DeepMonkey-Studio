import type { SceneCommand } from "@bim-studio/scene-sdk";
import { runEditorSceneTransaction, type EditorDriverTransactionResult } from "../studio/editorSceneWriteDriver";
import type { EditorPrimitiveDeleteAuthoring } from "../studio/editorPrimitiveDeleteAuthoring";
import type { SceneEditTransaction } from "../hooks/useSceneHistoryState";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { readSceneState } from "./sceneEditState";
import type { SceneEditPort } from "./sceneEditSession";
import { captureViewportObservation } from "./sceneViewportObservation";

/** 助手改动的固定能力面:与 MCP 桥一致,不含 studio.unity(编辑器视口不支持)。 */
export const ASSISTANT_SCENE_MODULE = {
  id: "assistant-scene-edit",
  capabilities: ["studio.object", "studio.scene", "studio.camera", "studio.material", "studio.data", "studio.animation", "studio.component"],
  permissions: ["scene.read", "scene.write"],
} as const;

export interface SceneEditPortHost {
  sceneId: string;
  engine(): ViewerEngine | undefined;
  /** 播放/行为/动画运行、忙碌或无作者写入口时的原因;可写时 undefined。 */
  unavailableReason(): string | undefined;
  authoring(): EditorPrimitiveDeleteAuthoring | undefined;
  beginTransaction(label: string): SceneEditTransaction;
  /** 场景级命令(灯光/环境/天气/状态机锚)回写 React draft,保证保存链路与撤销快照一致。 */
  syncDraft(commands: readonly SceneCommand[]): void;
  /** 撤销栈当前栈顶标签(来自最新渲染)。 */
  undoLabel(): string | undefined;
  undo(): Promise<void>;
}

const nextFrames = (count: number) => new Promise<void>(resolve => {
  const frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (callback: () => void) => setTimeout(callback, 16);
  const step = (left: number) => left <= 0 ? resolve() : frame(() => step(left - 1));
  step(count);
});
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * 把引擎/撤销栈/事务 driver 包成闭环端口。
 * 原子性:整批走 commitSceneCommandTransaction,任一命令失败即整体回滚(driver 逆算子)。
 * 撤销单元:无删除的批在作者事务窗口内提交为一条;含删除的批由 driver 的删除事务统一收口(同一标签)。
 */
export function createSceneEditPort(host: SceneEditPortHost): SceneEditPort {
  let revision = 0;
  const requireViewer = () => host.engine();
  return {
    unavailableReason: () => (requireViewer() ? host.unavailableReason() : "三维视口尚未就绪"),
    readState() {
      const viewer = requireViewer();
      if (!viewer) throw new Error("三维视口尚未就绪");
      return readSceneState(viewer, host.sceneId);
    },
    async apply(commands, label, transactionId) {
      const viewer = requireViewer();
      if (!viewer) return { status: "failed", message: "三维视口尚未就绪" };
      const hasDelete = commands.some(command => command.type === "object.delete-primitive");
      const authoring = host.authoring();
      if (hasDelete && !authoring) return { status: "failed", message: "当前作者未连接可恢复的图元删除" };
      let transaction: SceneEditTransaction | undefined;
      if (!hasDelete) {
        try { transaction = host.beginTransaction(label); }
        catch (reason) { return { status: "failed", message: reason instanceof Error ? reason.message : String(reason) }; }
      }
      const baseRevision = revision;
      let result: EditorDriverTransactionResult;
      try {
        result = await runEditorSceneTransaction({
          sceneId: host.sceneId,
          viewer: () => viewer,
          readRevision: () => revision,
          bumpRevision: () => { revision += 1; },
          authoring: hasDelete && authoring ? { ...authoring, begin: () => authoring.begin(label) } : undefined,
        }, { requestId: transactionId, transaction: { id: transactionId, sceneId: host.sceneId, baseRevision, module: ASSISTANT_SCENE_MODULE, commands } });
      } catch (reason) {
        transaction?.rollback();
        return { status: "failed", message: reason instanceof Error ? reason.message : String(reason) };
      }
      if (result.status === "committed") {
        host.syncDraft(commands);
        transaction?.commit();
        const receipt = result.receipt as { id: string; baseRevision: number; finalRevision: number; commandIds: string[] };
        return { status: "committed", receipt: { id: receipt.id, baseRevision: receipt.baseRevision, finalRevision: receipt.finalRevision, commandIds: [...receipt.commandIds] } };
      }
      transaction?.rollback();
      const issue = (result.issue ?? result.issues?.[0]) as { message?: string } | undefined;
      return { status: result.status, ...(issue?.message ? { message: issue.message } : {}) };
    },
    async capture() {
      await nextFrames(2);
      return captureViewportObservation(requireViewer());
    },
    async undo(label) {
      if (host.undoLabel() !== label) return { ok: false, message: "撤销栈顶不是本批改动(其后有新的编辑),请用 Ctrl+Z 逐步撤销" };
      await host.undo();
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (host.undoLabel() !== label) { await nextFrames(2); return { ok: true }; }
        await sleep(40);
      }
      return { ok: false, message: "撤销未生效(场景忙碌或处于运行态),请稍后重试" };
    },
  };
}
