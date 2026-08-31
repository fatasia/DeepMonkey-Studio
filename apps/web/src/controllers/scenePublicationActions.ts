import type { SceneSnapshot } from "@bim-studio/contracts";
import { api } from "../api";
import { routePath } from "../appRoute";
import { translate as tr } from "../i18n";
import { publicationSuccessMessage } from "./scenePublicationMessage";
import type { ScenePersistenceControllerContext } from "./scenePersistenceControllerContext";

type PublicationContext = Pick<
  ScenePersistenceControllerContext,
  | "project"
  | "activeScene"
  | "route"
  | "locale"
  | "studioPublishMode"
  | "studioPublishPerformance"
  | "enablePublishedCloudScene"
  | "navigate"
  | "sortScenesByTime"
  | "showError"
  | "setActiveScene"
  | "setMessage"
  | "setSceneName"
  | "setScenes"
  | "setStudioPublishOpen"
>;

type SaveScene = () => Promise<SceneSnapshot | undefined>;

/** 浏览与发布共享同一次保存结果，避免用户看到未保存草稿或发布版本不一致。 */
export function createScenePublicationActions(context: PublicationContext, saveScene: SaveScene) {
  const {
    project,
    activeScene,
    route,
    locale,
    studioPublishMode,
    studioPublishPerformance,
    enablePublishedCloudScene,
    navigate,
    sortScenesByTime,
    showError,
    setActiveScene,
    setMessage,
    setSceneName,
    setScenes,
    setStudioPublishOpen,
  } = context;

  async function browseActiveScene() {
    const browseWindow = window.open("about:blank", "_blank");
    if (browseWindow) {
      browseWindow.opener = null;
      browseWindow.document.title = tr(locale, "正在打开场景…", "Opening scene…");
    }
    const saved = await saveScene();
    if (!saved) {
      browseWindow?.close();
      return;
    }
    const path = routePath({ view: "view", sceneId: saved.id });
    if (browseWindow && !browseWindow.closed) {
      browseWindow.location.replace(path);
      return;
    }
    const fallback = window.open(path, "_blank", "noopener,noreferrer");
    if (!fallback) showError(new Error(tr(locale, "浏览器阻止了新窗口，请允许本站弹出窗口", "The browser blocked the viewer window; allow pop-ups for this site")));
  }

  async function publishActiveScene(
    mode: NonNullable<SceneSnapshot["publicationMode"]> = studioPublishMode,
    performanceProfile: NonNullable<SceneSnapshot["publicationPerformance"]> = studioPublishPerformance,
    toolbarVisible = activeScene?.publicationToolbarVisible !== false,
  ) {
    const saved = await saveScene();
    if (!saved) return;
    const published = await publishScene(saved, mode, performanceProfile, toolbarVisible);
    if (published) setStudioPublishOpen(false);
  }

  async function deleteScene(scene: SceneSnapshot) {
    if (!project || !window.confirm(`确定删除场景“${scene.name}”吗？`)) return;
    try {
      await api.deleteScene(project.id, scene.id);
      setScenes((items) => items.filter((item) => item.id !== scene.id));
      if (activeScene?.id === scene.id) setActiveScene(undefined);
      if ((route.view === "studio" || route.view === "view" || route.view === "published") && route.sceneId === scene.id) navigate({ view: "manager" });
      setMessage(`场景“${scene.name}”已删除`);
    } catch (reason) {
      showError(reason);
    }
  }

  async function copyScene(scene: SceneSnapshot) {
    if (!project) return;
    try {
      const copy = await api.copyScene(project.id, scene.id);
      setScenes((items) => sortScenesByTime([copy, ...items]));
      setMessage(`已复制为“${copy.name}”`);
    } catch (reason) {
      showError(reason);
    }
  }

  async function renameScene(scene: SceneSnapshot, name: string) {
    if (!project) return;
    try {
      const updated = await api.renameScene(project.id, scene.id, name);
      setScenes((items) => sortScenesByTime(items.map((item) => (item.id === updated.id ? updated : item))));
      if (activeScene?.id === updated.id) {
        setActiveScene(updated);
        setSceneName(updated.name);
      }
      setMessage(`场景已重命名为“${updated.name}”`);
    } catch (reason) {
      showError(reason);
    }
  }

  async function publishScene(
    scene: SceneSnapshot,
    mode: NonNullable<SceneSnapshot["publicationMode"]> = scene.publicationMode ?? "webgl",
    performanceProfile: NonNullable<SceneSnapshot["publicationPerformance"]> = scene.publicationPerformance ?? "standard",
    toolbarVisible = scene.publicationToolbarVisible !== false,
  ): Promise<boolean> {
    if (!project) return false;
    try {
      const configured = await api.saveScene({
        ...scene,
        publicationMode: mode,
        publicationPerformance: performanceProfile,
        publicationToolbarVisible: toolbarVisible,
        updatedAt: new Date().toISOString(),
      });
      const publication = await api.publishScene(project.id, configured.id);
      setScenes((items) => sortScenesByTime(items.map((item) => (item.id === scene.id ? publication.snapshot : item))));
      if (activeScene?.id === scene.id) setActiveScene(publication.snapshot);
      if (mode === "cloud") {
        const session = await enablePublishedCloudScene(scene.id);
        setMessage(publicationSuccessMessage({ locale, sceneName: scene.name, mode, performanceProfile, cloudViewerReady: Boolean(session.viewerUrl) }));
      } else {
        setMessage(publicationSuccessMessage({ locale, sceneName: scene.name, mode, performanceProfile }));
      }
      return true;
    } catch (reason) {
      showError(reason);
      return false;
    }
  }

  async function unpublishScene(scene: SceneSnapshot) {
    if (!project || !window.confirm(`撤回场景“${scene.name}”的发布版本吗？`)) return;
    try {
      await api.unpublishScene(project.id, scene.id);
      const updated = { ...scene };
      delete updated.publishedAt;
      setScenes((items) => items.map((item) => (item.id === scene.id ? updated : item)));
      if (activeScene?.id === scene.id) setActiveScene(updated);
      setMessage(`场景“${scene.name}”已撤回发布`);
    } catch (reason) {
      showError(reason);
    }
  }

  return { browseActiveScene, publishActiveScene, deleteScene, copyScene, renameScene, publishScene, unpublishScene };
}
