import type { SceneSnapshot } from "@bim-studio/contracts";
import { api } from "../api";
import { routePath } from "../appRoute";
import { translate as tr } from "../i18n";
import { publicationSuccessMessage } from "./scenePublicationMessage";
import type { ScenePersistenceControllerContext } from "./scenePersistenceControllerContext";
import type { SceneClientPackageTarget } from "../delivery/sceneClientPackage";
import { assertScenePublicationDeliverable, ScenePublicationCompatibilityError } from "../delivery/scenePublicationCompatibilityGate";
import { assessScenePublication } from "../components/publicationReadiness";

type PublicationContext = Pick<
  ScenePersistenceControllerContext,
  | "project"
  | "activeScene"
  | "getActiveScene"
  | "getRoute"
  | "getScenes"
  | "buildPublicationArtifact"
  | "sceneApplyVersionRef"
  | "scenes"
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
    getActiveScene,
    getRoute,
    getScenes,
    sceneApplyVersionRef,
    scenes,
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
    clientTarget: SceneClientPackageTarget = "none",
  ) {
    const owner = getActiveScene();
    const generation = sceneApplyVersionRef.current;
    const saved = await saveScene();
    if (!saved) return;
    if (sceneApplyVersionRef.current !== generation || (owner && (getActiveScene()?.id !== owner.id || getActiveScene()?.projectId !== owner.projectId))) return;
    const published = await publishScene(saved, mode, performanceProfile, toolbarVisible, clientTarget);
    const current = getActiveScene();
    if (published && sceneApplyVersionRef.current === generation && current?.id === saved.id && current.projectId === saved.projectId) setStudioPublishOpen(false);
  }

  async function deleteScene(scene: SceneSnapshot) {
    if (!project || !window.confirm(`确定删除场景“${scene.name}”吗？`)) return;
    const { id, projectId, name } = scene;
    const isCurrent = captureDiscardScope();
    try {
      if (projectId !== project.id) throw new Error("场景不属于当前项目，请重新打开后删除");
      await api.deleteScene(projectId, id);
      setScenes(items => items.filter(item => item.id !== id || item.projectId !== projectId));
      if (!isCurrent()) return;
      const current = getActiveScene();
      if (current?.id === id && current.projectId === projectId) setActiveScene(value =>
        isCurrent() && value?.id === id && value.projectId === projectId ? undefined : value);
      if ((route.view === "studio" || route.view === "view" || route.view === "published") && route.sceneId === id) navigate({ view: "manager" });
      setMessage(`场景“${name}”已删除`);
    } catch (reason) {
      if (isCurrent()) showError(reason);
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
    clientTarget: SceneClientPackageTarget = "none",
  ): Promise<boolean> {
    if (!project) return false;
    const generation = sceneApplyVersionRef.current;
    const owner = getActiveScene();
    const isCurrentRequest = () => {
      const current = getActiveScene();
      return sceneApplyVersionRef.current === generation
        && current?.id === owner?.id && current?.projectId === owner?.projectId;
    };
    try {
      if (scene.projectId !== project.id) throw new Error(tr(locale, "场景不属于当前项目，请重新打开后发布", "The scene belongs to another project. Reopen it before publishing."));
      const configured = await api.saveScene({
        ...scene,
        publicationMode: mode,
        publicationPerformance: performanceProfile,
        publicationToolbarVisible: toolbarVisible,
        updatedAt: new Date().toISOString(),
      });
      if (configured.id !== scene.id || configured.projectId !== project.id) throw new Error(tr(locale, "保存结果与待发布场景不一致，请重新保存", "The saved result does not match the scene being published. Save again."));
      if (!isCurrentRequest()) return false;
      const audit = assessScenePublication(project, configured, scenes);
      if (audit.status === "blocked") {
        const details = audit.issues.filter((issue) => issue.severity === "blocker")
          .map((issue) => `${issue.title}：${issue.detail} ${issue.remediation}`).join("\n");
        throw new Error(tr(locale, "发布检查未通过", "Publication checks failed") + `\n${details}`);
      }
      const renderer = mode === "webgpu-preferred" ? "webgpu-preferred" as const : "webgl" as const;
      let nativeCandidateId: string | undefined;
      if (clientTarget === "deep-native") {
        const candidate = await api.createNativeSceneCandidate(project.id, configured.id, configured);
        if (!isCurrentRequest()) return false;
        if (candidate.report.target !== "deep-native" || candidate.report.sceneId !== configured.id) throw new Error("Native 发布候选与当前场景不匹配，请重新验证");
        assertScenePublicationDeliverable(candidate.report);
        if (candidate.status !== "ready" || !candidate.candidateId?.trim()) throw new Error("Native 发布候选尚未准备完成，请重新验证");
        nativeCandidateId = candidate.candidateId;
      }
      if (!isCurrentRequest()) return false;
      const publication = clientTarget === "none" ? await api.publishScene(project.id, configured.id, configured)
        : await api.publishScene(project.id, configured.id, configured, { clientTarget,
          ...(nativeCandidateId ? { nativeCandidateId } : {}) });
      setScenes((items) => sortScenesByTime(items.map((item) => (item.id === scene.id && item.projectId === scene.projectId ? publication.snapshot : item))));
      if (!isCurrentRequest()) return false;
      const current = getActiveScene();
      if (sceneApplyVersionRef.current === generation && current?.id === scene.id && current.projectId === scene.projectId) setActiveScene(publication.snapshot);
      if (mode === "cloud") {
        const session = await enablePublishedCloudScene(scene.id);
        if (!isCurrentRequest()) return false;
        setMessage(publicationSuccessMessage({ locale, sceneName: scene.name, mode, performanceProfile, cloudViewerReady: Boolean(session.viewerUrl) }));
      } else {
        setMessage(publicationSuccessMessage({ locale, sceneName: scene.name, mode, performanceProfile }));
      }
      if (clientTarget !== "none") {
        if (!isCurrentRequest()) return false;
        try {
          const options = { target: clientTarget, renderer, toolbarVisible };
          const artifact = await context.buildPublicationArtifact(publication, options);
          if (!isCurrentRequest()) return false;
          if (artifact.record.status === "cancelled") {
            setMessage(tr(locale, `场景“${scene.name}”已发布 · 客户端打包已取消`, `Scene “${scene.name}” published · client packaging cancelled`));
            return false;
          }
          if (artifact.record.status !== "ready" || !artifact.result) throw new Error(artifact.record.error ?? tr(locale, "客户端包尚未生成，请重试打包", "The client package is not ready. Retry packaging."));
          setMessage(`${publicationSuccessMessage({ locale, sceneName: scene.name, mode, performanceProfile })} · ${artifact.result.fileName}`);
        } catch (reason) {
          if (!isCurrentRequest()) return false;
          setMessage(tr(locale, `场景“${scene.name}”已发布 · 客户端包生成失败`, `Scene “${scene.name}” published · client package generation failed`));
          throw reason;
        }
      }
      return true;
    } catch (reason) {
      if (!isCurrentRequest()) return false;
      showError(reason instanceof ScenePublicationCompatibilityError
        ? new Error(tr(locale, "发布检查未通过", "Publication checks failed"))
        : reason);
      throw reason;
    }
  }

  async function unpublishScene(scene: SceneSnapshot) {
    if (!project || !window.confirm(`撤回场景“${scene.name}”的发布版本吗？`)) return;
    const { id, projectId, name, publishedAt } = scene;
    const isCurrent = captureDiscardScope();
    const clearPublication = (item: SceneSnapshot): SceneSnapshot => {
      if (item.id !== id || item.projectId !== projectId || item.publishedAt !== publishedAt) return item;
      const { publishedAt: _publishedAt, ...draft } = item;
      return draft;
    };
    try {
      if (projectId !== project.id) throw new Error("场景不属于当前项目，请重新打开后撤回");
      await api.unpublishScene(projectId, id);
      const latestPublication = getScenes().find(item => item.id === id && item.projectId === projectId)?.publishedAt;
      setScenes(items => items.map(clearPublication));
      if (!isCurrent()) return;
      if (latestPublication !== undefined && latestPublication !== publishedAt) return;
      const current = getActiveScene();
      if (current?.id === id && current.projectId === projectId && current.publishedAt !== publishedAt) return;
      if (current?.id === id && current.projectId === projectId) setActiveScene(value =>
        isCurrent() && value ? clearPublication(value) : value);
      setMessage(`场景“${name}”已撤回发布`);
    } catch (reason) {
      if (isCurrent()) showError(reason);
    }
  }

  function captureDiscardScope() {
    const generation = sceneApplyVersionRef.current;
    const ownerRoute = getRoute();
    const owner = getActiveScene();
    const ownerId = owner?.id, ownerProjectId = owner?.projectId;
    return () => {
      const current = getActiveScene();
      return sceneApplyVersionRef.current === generation && getRoute() === ownerRoute
        && current?.id === ownerId && current?.projectId === ownerProjectId;
    };
  }

  return { browseActiveScene, publishActiveScene, deleteScene, copyScene, renameScene, publishScene, unpublishScene };
}
