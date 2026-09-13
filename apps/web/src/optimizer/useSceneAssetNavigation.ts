import { useEffect, useRef, useState } from "react";
import type { ModelRecord } from "@bim-studio/contracts";
import type { AppViewBindings } from "../views/appViewBindings";

/** Scene-side continuation. URL carries intent; the loaded project remains authoritative. */
export function useSceneAssetNavigation(bindings: AppViewBindings) {
  const [leaving, setLeaving] = useState(false);
  const pending = useRef(false);
  const consumed = useRef<string | undefined>(undefined);
  const inserting = useRef<string | undefined>(undefined);
  const latest = useRef(bindings);
  latest.current = bindings;
  const { state, sceneEditor, scenePersistence, sceneHistory, actions } = bindings;
  const { route, project, activeScene, engine, busy } = state;

  async function open(destination: "optimizer" | "manager", model?: ModelRecord, instanceId?: string) {
    if (pending.current || busy || !project || !activeScene || route.view !== "studio") return;
    pending.current = true; setLeaving(true);
    try {
      const saved = await scenePersistence.saveScene();
      const current = latest.current.state;
      if (!saved || current.route.view !== "studio" || current.activeScene?.id !== saved.id || current.project?.id !== project.id) return;
      actions.navigate({ view: destination, projectId: project.id,
        ...(model ? { modelId: model.id } : {}),
        ...(destination === "manager" ? { managerTab: "assets" } : {}),
        assetReturn: { sceneId: saved.id, ...(route.applicationId ? { applicationId: route.applicationId } : {}), ...(instanceId ? { instanceId } : {}) },
      });
    } catch (reason) { state.showError(reason); }
    finally { pending.current = false; setLeaving(false); }
  }

  useEffect(() => {
    const modelId = route.insertModelId;
    if (!modelId) { consumed.current = undefined; return; }
    if (route.view !== "studio" || !modelId || !engine || busy || !project || !activeScene || activeScene.id !== route.sceneId || activeScene.projectId !== project.id) return;
    if (route.projectId && route.projectId !== project.id) return;
    // 返回页面时 activeScene 可能仍是旧状态；必须等引擎恢复完原快照，避免刚插入的模型被恢复清空。
    if (!engine.isSceneSnapshotReady(activeScene.id)) return;
    const replaceInstanceId = route.replaceModelInstanceId;
    const key = `${project.id}:${activeScene.id}:${modelId}:${replaceInstanceId ?? "insert"}`;
    if (consumed.current === key || inserting.current === key) return;
    const model = project.models.find(item => item.id === modelId);
    if (!model || model.status !== "ready" || !model.manifest) {
      state.setMessage("待添加模型不存在或尚未就绪，请从项目素材重新选择；原场景未修改");
      return;
    }
    inserting.current = key;
    const alreadyLoaded = engine.listModels().some(item => item.id === modelId);
    void (async () => {
      try {
        let completed = false;
        if (replaceInstanceId) {
          const instance = engine.listModels().find(item => item.id === replaceInstanceId && item.kind === "model");
          if (!instance) throw new Error("原场景实例已被删除，优化结果仍保留在项目素材中");
          sceneHistory.flush();
          await engine.replaceModelManifest(replaceInstanceId, model.manifest!);
          const current = latest.current.state;
          if (current.engine !== engine || current.project?.id !== project.id || current.route.sceneId !== route.sceneId || current.route.view !== "studio") return;
          engine.select(replaceInstanceId);
          state.setSceneOrganizationSelection(new Set([replaceInstanceId]));
          state.setRevision(value => value + 1);
          sceneHistory.flush("应用优化并替换素材");
          completed = true;
        } else {
          completed = Boolean(await sceneEditor.loadModel(model));
        }
        const current = latest.current.state;
        if (!completed || current.engine !== engine || current.project?.id !== project.id || current.route.sceneId !== route.sceneId || current.route.view !== "studio") return;
        consumed.current = key;
        if (!replaceInstanceId && alreadyLoaded) engine.focusModel(modelId);
        const { insertModelId: _completed, replaceModelInstanceId: _replaced, ...remaining } = latest.current.state.route;
        actions.navigate(remaining, true);
        state.setMessage(replaceInstanceId
          ? `已将优化结果应用到“${instanceName(engine, replaceInstanceId)}”；实例身份、位姿与绑定保持不变`
          : alreadyLoaded ? `已选中场景中的“${model.name}”，未重复添加` : `已添加并选中“${model.name}”；可撤销本次添加`);
      } catch (reason) {
        const current = latest.current.state;
        if (current.engine === engine && current.route.view === "studio") state.showError(reason);
      } finally {
        if (inserting.current === key) inserting.current = undefined;
      }
    })();
  }, [route.view, route.sceneId, route.projectId, route.insertModelId, route.replaceModelInstanceId, project, activeScene?.id, engine, busy]);

  return { leaving, optimize: (model?: ModelRecord, instanceId?: string) => void open("optimizer", model, instanceId), browse: () => void open("manager") };
}

function instanceName(engine: NonNullable<AppViewBindings["state"]["engine"]>, instanceId: string): string {
  return engine.listModels().find(item => item.id === instanceId)?.name ?? "当前实例";
}
