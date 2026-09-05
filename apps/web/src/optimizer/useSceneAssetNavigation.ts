import { useEffect, useRef, useState } from "react";
import type { ModelRecord } from "@bim-studio/contracts";
import type { AppViewBindings } from "../views/appViewBindings";

/** Scene-side continuation. URL carries intent; the loaded project remains authoritative. */
export function useSceneAssetNavigation(bindings: AppViewBindings) {
  const [leaving, setLeaving] = useState(false);
  const pending = useRef(false);
  const consumed = useRef<string | undefined>(undefined);
  const latest = useRef(bindings);
  latest.current = bindings;
  const { state, sceneEditor, scenePersistence, actions } = bindings;
  const { route, project, activeScene, engine, busy } = state;

  async function open(destination: "optimizer" | "manager", model?: ModelRecord) {
    if (pending.current || busy || !project || !activeScene || route.view !== "studio") return;
    pending.current = true; setLeaving(true);
    try {
      const saved = await scenePersistence.saveScene();
      const current = latest.current.state;
      if (!saved || current.route.view !== "studio" || current.activeScene?.id !== saved.id || current.project?.id !== project.id) return;
      actions.navigate({ view: destination, projectId: project.id,
        ...(model ? { modelId: model.id } : {}),
        ...(destination === "manager" ? { managerTab: "assets" } : {}),
        assetReturn: { sceneId: saved.id, ...(route.applicationId ? { applicationId: route.applicationId } : {}) },
      });
    } catch (reason) { state.showError(reason); }
    finally { pending.current = false; setLeaving(false); }
  }

  useEffect(() => {
    const modelId = route.insertModelId;
    if (!modelId) { consumed.current = undefined; return; }
    if (route.view !== "studio" || !modelId || !engine || busy || !project || !activeScene || activeScene.id !== route.sceneId || activeScene.projectId !== project.id) return;
    if (route.projectId && route.projectId !== project.id) return;
    const key = `${project.id}:${activeScene.id}:${modelId}`;
    if (consumed.current === key) return;
    consumed.current = key;
    const model = project.models.find(item => item.id === modelId);
    if (!model || model.status !== "ready" || !model.manifest) {
      state.setMessage("待添加模型不存在或尚未就绪，请从项目素材重新选择；原场景未修改");
      return;
    }
    const alreadyLoaded = engine.listModels().some(item => item.id === modelId);
    void sceneEditor.loadModel(model).then(loaded => {
      if (!loaded || latest.current.state.route.sceneId !== route.sceneId || latest.current.state.route.view !== "studio") return;
      if (alreadyLoaded) engine.focusModel(modelId);
      const { insertModelId: _completed, ...remaining } = latest.current.state.route;
      actions.navigate(remaining, true);
      state.setMessage(alreadyLoaded ? `已选中场景中的“${model.name}”，未重复添加` : `已添加并选中“${model.name}”；原模型保留，可撤销本次添加`);
    });
  }, [route.view, route.sceneId, route.projectId, route.insertModelId, project, activeScene?.id, engine, busy]);

  return { leaving, optimize: (model?: ModelRecord) => void open("optimizer", model), browse: () => void open("manager") };
}
