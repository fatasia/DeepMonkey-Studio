import type { ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import { api } from "../api";
import { exportFbxFile, exportGlbFile, exportLooseScene, exportScenePackage, readSceneFile } from "../sceneFiles";
import { rebindImportedSceneModels } from "./sceneImportRebinding";
import type { ScenePersistenceControllerContext } from "./scenePersistenceControllerContext";

type FileTransferContext = Pick<
  ScenePersistenceControllerContext,
  | "engine"
  | "project"
  | "activeScene"
  | "sceneName"
  | "importRef"
  | "waitForModelReady"
  | "sortScenesByTime"
  | "showError"
  | "setBusy"
  | "setMessage"
  | "setProject"
  | "setProjects"
  | "setScenes"
>;

type ApplyScene = (scene: SceneSnapshot, updateRoute?: boolean, sceneProject?: ProjectRecord) => Promise<void>;
type MakeSnapshot = () => SceneSnapshot | undefined;

/** 场景文件进出边界：配置、单文件项目包与标准三维格式共用同一套提示和错误恢复。 */
export function createSceneFileTransferActions(context: FileTransferContext, makeSnapshot: MakeSnapshot, applyScene: ApplyScene) {
  const {
    engine,
    project,
    activeScene,
    sceneName,
    importRef,
    waitForModelReady,
    sortScenesByTime,
    showError,
    setBusy,
    setMessage,
    setProject,
    setProjects,
    setScenes,
  } = context;

  function exportSceneConfig(scene?: SceneSnapshot) {
    const snapshot = scene ?? makeSnapshot();
    if (!snapshot) return;
    exportLooseScene(snapshot);
    setMessage("已导出零散场景配置；模型资源仍由项目资源库管理");
  }

  async function exportSingleFileScene(scene?: SceneSnapshot) {
    const snapshot = scene ?? makeSnapshot();
    if (!snapshot || !project) return;
    setBusy(true);
    try {
      await exportScenePackage(snapshot, project.models);
      setMessage("已导出单文件场景（.bimscene，包含可浏览模型资源）");
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function exportGlbScene(scene?: SceneSnapshot) {
    if (!engine) return;
    setBusy(true);
    try {
      if (scene && activeScene?.id !== scene.id) await applyScene(scene, false);
      const data = await engine.exportSceneGlb({ scope: "all" });
      exportGlbFile(data, scene?.name ?? sceneName);
      setMessage("已导出完整场景 GLB（几何、材质、纹理、层级、变换与兼容动画）");
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function exportFbxScene(scene?: SceneSnapshot) {
    if (!engine) return;
    setBusy(true);
    try {
      if (scene && activeScene?.id !== scene.id) await applyScene(scene, false);
      const data = await engine.exportSceneFbx();
      exportFbxFile(data, scene?.name ?? sceneName);
      setMessage("已导出 FBX（当前可见网格、变换与基础材质）");
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function importScene(file?: File) {
    if (!file || !project) return;
    setBusy(true);
    try {
      const importedFile = await readSceneFile(file);
      let targetProject = project;
      const modelIdMap = new Map<string, string>();

      for (const asset of importedFile.assets) {
        const existing =
          targetProject.models.find((model) => model.id === asset.originalModelId && model.status === "ready") ??
          targetProject.models.find((model) => model.name === asset.sourceName && model.format === asset.sourceFormat && model.status === "ready");
        if (existing) {
          modelIdMap.set(asset.originalModelId, existing.id);
          continue;
        }
        const uploaded = await api.uploadModel(targetProject.id, asset.file);
        targetProject = await waitForModelReady(targetProject.id, uploaded.id);
        modelIdMap.set(asset.originalModelId, uploaded.id);
      }

      const rebound = rebindImportedSceneModels(importedFile.scene, targetProject, modelIdMap);
      const imported = await api.importScene(project.id, rebound.scene);
      setProject(targetProject);
      setProjects((items) => items.map((item) => (item.id === targetProject.id ? targetProject : item)));
      setScenes((items) => sortScenesByTime([imported, ...items]));
      await applyScene(imported, true, targetProject);
      setMessage(
        rebound.missingModelCount > 0
          ? `场景已导入，但缺少 ${rebound.missingModelCount} 个模型资源；请上传同名文件后重新打开`
          : importedFile.mode === "package"
            ? "单文件场景及模型资源已导入"
            : "零散场景配置已导入",
      );
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
      if (importRef.current) importRef.current.value = "";
    }
  }

  return { exportSceneConfig, exportSingleFileScene, exportGlbScene, exportFbxScene, importScene };
}
