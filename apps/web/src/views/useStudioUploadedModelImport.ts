import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ModelRecord } from "@bim-studio/contracts";
import { useDialogEscape } from "../hooks/useGlobalDialogEscape";
import { modelAssetOptimizerRoute } from "../optimizer/modelAssetNavigation";
import type { AppStudioController } from "./AppStudioShell";

/**
 * AppStudioShellView 上传模型导入域:上传完成弹窗状态、场景树待插队列(画布
 * 挂载与 ViewerEngine 创建之间的手势保序)、直接插入/进入优化入口。状态与
 * 处理器自视图原文机械迁出,语句与求值顺序逐一保留。
 */
export function useStudioUploadedModelImport(controller: AppStudioController,
  setSceneImportOpen: Dispatch<SetStateAction<boolean>>,
  setSceneWorkflow: Dispatch<SetStateAction<"device-layout" | "smart-binding" | "model-diff" | null>>) {
  const { engine, loadModel, loadedModels, uploadRef, route, activeScene, bindings, project, busy } = controller;
  const [uploadedImportModels, setUploadedImportModels] = useState<ModelRecord[] | null>(null);
  // Resource-panel gestures can arrive in the short window between canvas
  // mount and ViewerEngine creation. Keep the user action instead of silently
  // dropping it when the controller is not ready yet.
  const pendingProjectModelInsertsRef = useRef<ModelRecord[]>([]);
  const uploadedImportEscapeRef = useDialogEscape(() => setUploadedImportModels(null), busy);
  const openImportModelPicker = () => {
    setSceneImportOpen(false);
    setSceneWorkflow(null);
    uploadRef.current?.click();
  };
  const openRvtImportSettings = () => {
    setSceneImportOpen(true);
    setSceneWorkflow(null);
  };
  const insertUploadedModels = async () => {
    const models = uploadedImportModels;
    if (!models?.length) return;
    setUploadedImportModels(null);
    const occupiedAssetIds = new Set(loadedModels.map((item) => item.assetModelId ?? item.id));
    for (const model of models) {
      const instanceId = occupiedAssetIds.has(model.id) ? crypto.randomUUID() : model.id;
      occupiedAssetIds.add(model.id);
      await loadModel(model, false, instanceId);
    }
  };
  const insertProjectModel = (model: ModelRecord) => {
    if (!engine) {
      if (!pendingProjectModelInsertsRef.current.some((item) => item.id === model.id)) {
        pendingProjectModelInsertsRef.current.push(model);
      }
      return;
    }
    void loadModel(model, false, loadedModels.some((item) => (item.assetModelId ?? item.id) === model.id) ? crypto.randomUUID() : model.id);
  };
  useEffect(() => {
    if (!engine || pendingProjectModelInsertsRef.current.length === 0) return;
    const pending = pendingProjectModelInsertsRef.current.splice(0);
    const occupiedAssetIds = new Set(loadedModels.map((item) => item.assetModelId ?? item.id));
    for (const model of pending) {
      const instanceId = occupiedAssetIds.has(model.id) ? crypto.randomUUID() : model.id;
      occupiedAssetIds.add(model.id);
      void loadModel(model, false, instanceId);
    }
  }, [engine, loadModel, loadedModels]);
  const optimizeUploadedModels = () => {
    const firstModel = uploadedImportModels?.[0];
    if (!firstModel) return;
    setUploadedImportModels(null);
    const assetReturn = route.assetReturn ?? (activeScene ? {
      sceneId: activeScene.id,
      ...(route.applicationId ? { applicationId: route.applicationId } : {}),
    } : undefined);
    bindings.actions.navigate(modelAssetOptimizerRoute(project?.id, firstModel.id, assetReturn));
  };
  return { uploadedImportModels, setUploadedImportModels, uploadedImportEscapeRef, openImportModelPicker,
    openRvtImportSettings, insertUploadedModels, insertProjectModel, optimizeUploadedModels };
}
