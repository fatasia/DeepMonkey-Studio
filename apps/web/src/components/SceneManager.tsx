import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelRecord, ProjectAssetRecord, SceneSnapshot } from "@bim-studio/contracts";
import { api } from "../api";
import { translate as tr } from "../i18n";
import type { SceneManagerProps } from "./sceneManagerTypes";
import { SceneManagerView } from "./SceneManagerView";
import { analyzeProjectResourceGovernance } from "./projectResourceGovernance";
import { filterAndSortScenes, type SceneSortKey, type SceneStatusFilter } from "./sceneManagerPresentation";
import { useScenePublicationHistory } from "../hooks/useScenePublicationHistory";

type ProjectAssetTab = "all" | "model" | "image" | "video" | "environment" | "pbr-material";

function useSceneManagerController({
  locale,
  managerTab: requestedManagerTab,
  assetScope,
  selectedAssetModelId,
  onReturnToScene,
  onManagerTabChange,
  branding,
  projects,
  project,
  scenes,
  applications,
  topologies,
  userName,
  isAdmin,
  navigationNotice,
  onDismissNavigationNotice,
  onProjectChange,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onCreate,
  onCreateShowcase,
  showcaseExists,
  onOpen,
  onOpenBehavior,
  onOpenSimulation,
  onCopy,
  onRename,
  onPublish,
  onUnpublish,
  onRestorePublication,
  onBrowse,
  onBrowsePublished,
  onImport,
  onExportLoose,
  onExportSingle,
  onExportGlb,
  onExportFbx,
  onDelete,
  onOptimizer,
  onDataCenter,
  onCreateTopology,
  onOpenTopology,
  onVisionCenter,
  onOperationsCenter,
  onAiAssistant,
  onDocs,
  onSystem,
  onCloudRender,
  onLocaleToggle,
  onConnectionStatus,
  onCredits,
  onLogout,
  onUploadModels,
  onDeleteModel,
  onRefreshModels,
}: SceneManagerProps) {
  const [dialogMode, setDialogMode] = useState<"create" | "rename">();
  const [localManagerTab, setLocalManagerTab] = useState<"scenes" | "assets" | "topology" | "examples">("scenes");
  const managerTab = requestedManagerTab ?? localManagerTab;
  const setManagerTab = (tab: typeof managerTab) => { setLocalManagerTab(tab); onManagerTabChange?.(tab); };
  const [targetScene, setTargetScene] = useState<SceneSnapshot>();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [modelLibraryBusy, setModelLibraryBusy] = useState(false);
  const [showcaseBusy, setShowcaseBusy] = useState(false);
  const [assetTab, setAssetTab] = useState<ProjectAssetTab>("all");
  const [assetSearch, setAssetSearch] = useState("");
  const [sceneSearch, setSceneSearch] = useState("");
  const [copyNotice, setCopyNotice] = useState("");
  const [sceneStatusFilter, setSceneStatusFilter] = useState<SceneStatusFilter>("all");
  const [sceneSort, setSceneSort] = useState<SceneSortKey>("updated");
  const [deliveryReviewOpen, setDeliveryReviewOpen] = useState(false);
  const [cloudConfigured, setCloudConfigured] = useState(false);
  const [cloudScenePolicies, setCloudScenePolicies] = useState<Record<string, boolean>>({});
  const [cloudBusySceneId, setCloudBusySceneId] = useState<string>();
  const [cloudSceneLinks, setCloudSceneLinks] = useState<Record<string, string>>({});
  const [cloudError, setCloudError] = useState<string>();
  const [projectCloudBusy, setProjectCloudBusy] = useState(false);
  const [publishTarget, setPublishTarget] = useState<SceneSnapshot>();
  const [publishMode, setPublishMode] = useState<NonNullable<SceneSnapshot["publicationMode"]>>("webgl");
  const [publishPerformance, setPublishPerformance] = useState<NonNullable<SceneSnapshot["publicationPerformance"]>>("standard");
  const { versionTarget, setVersionTarget, publicationVersions, versionBusy, versionError, openVersions, restoreVersion }
    = useScenePublicationHistory(project?.id, locale, onRestorePublication);
  const [parametricWorkbenchOpen, setParametricWorkbenchOpen] = useState(false);
  const [parametricSourceModel, setParametricSourceModel] = useState<ModelRecord>();
  const modelUploadRef = useRef<HTMLInputElement>(null);
  const imageUploadRef = useRef<HTMLInputElement>(null);
  const videoUploadRef = useRef<HTMLInputElement>(null);

  const sortedScenes = useMemo(() => [...scenes].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)), [scenes]);
  const visibleScenes = useMemo(
    () => filterAndSortScenes(scenes, sceneSearch, sceneStatusFilter, sceneSort),
    [sceneSearch, sceneSort, sceneStatusFilter, scenes],
  );
  const resourceGovernance = useMemo(
    () => analyzeProjectResourceGovernance(project, applications, scenes),
    [applications, project, scenes],
  );

  useEffect(() => {
    if (!isAdmin || !project) return;
    let cancelled = false;
    void api
      .getCloudRenderOverview()
      .then((overview) => {
        if (cancelled) return;
        setCloudConfigured(overview.configured);
        setCloudScenePolicies(Object.fromEntries(overview.scenes.map((scene) => [scene.sceneId, scene.enabled])));
        setCloudSceneLinks(Object.fromEntries(overview.scenes.flatMap((scene) => (scene.session?.viewerUrl ? [[scene.sceneId, scene.session.viewerUrl]] : []))));
      })
      .catch(() => {
        if (!cancelled) {
          setCloudConfigured(false);
          setCloudScenePolicies({});
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin, project?.id, scenes]);

  useEffect(() => {
    setSceneSearch("");
    setAssetSearch("");
    setSceneStatusFilter("all");
    setCopyNotice("");
  }, [project?.id]);

  async function toggleSceneCloudRender(sceneId: string, enabled: boolean): Promise<boolean> {
    setCloudBusySceneId(sceneId);
    setCloudError(undefined);
    try {
      const policy = await api.setCloudRenderEnabled(sceneId, enabled);
      setCloudScenePolicies((current) => ({ ...current, [sceneId]: policy.enabled }));
      if (enabled) {
        const session = await api.startCloudRenderSession(sceneId);
        if (session.viewerUrl) setCloudSceneLinks((current) => ({ ...current, [sceneId]: session.viewerUrl! }));
      } else
        setCloudSceneLinks((current) => {
          const next = { ...current };
          delete next[sceneId];
          return next;
        });
      return true;
    } catch (reason) {
      setCloudError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setCloudBusySceneId(undefined);
    }
  }

  async function enableProjectCloudRender() {
    const published = sortedScenes.filter((scene) => scene.publishedAt);
    if (!cloudConfigured || published.length === 0) return;
    setProjectCloudBusy(true);
    try {
      for (const scene of published) await toggleSceneCloudRender(scene.id, true);
    } finally {
      setProjectCloudBusy(false);
    }
  }

  async function copyLink(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyNotice(tr(locale, "链接已复制", "Link copied"));
    } catch {
      setCopyNotice(tr(locale, "复制失败，请检查浏览器剪贴板权限后重试", "Copy failed. Check clipboard permissions and retry."));
    }
  }

  async function submitPublish(toolbarVisible: boolean) {
    if (!publishTarget) return;
    const target = publishTarget;
    const published = await onPublish(target, publishMode, publishPerformance, toolbarVisible);
    if (!published) return;
    setPublishTarget(undefined);
  }

  function openCreateDialog() {
    setTargetScene(undefined);
    setName("");
    setDialogMode("create");
  }

  function openRenameDialog(scene: SceneSnapshot) {
    setTargetScene(scene);
    setName(scene.name);
    setDialogMode("rename");
  }

  async function submitSceneDialog() {
    const value = name.trim();
    if (!value) return;
    setBusy(true);
    try {
      if (dialogMode === "rename" && targetScene) await onRename(targetScene, value);
      else await onCreate(value);
      setName("");
      setTargetScene(undefined);
      setDialogMode(undefined);
    } finally {
      setBusy(false);
    }
  }

  async function createShowcase() {
    setShowcaseBusy(true);
    try {
      await onCreateShowcase();
    } finally {
      setShowcaseBusy(false);
    }
  }

  async function uploadLibraryModels(files: FileList | null) {
    if (!files?.length) return;
    setModelLibraryBusy(true);
    try {
      await onUploadModels(files);
    } finally {
      setModelLibraryBusy(false);
      if (modelUploadRef.current) modelUploadRef.current.value = "";
    }
  }

  async function deleteLibraryModel(model: ModelRecord) {
    const usage = resourceGovernance.resources.find((resource) => resource.kind === "model" && resource.id === model.id);
    if (
      !window.confirm(
        tr(
          locale,
          usage?.instanceCount
            ? `模型“${model.name}”仍有 ${usage.instanceCount} 个场景实例。继续删除会造成引用断开，建议先移除实例。仍要删除吗？`
            : `确定删除未引用模型“${model.name}”吗？`,
          usage?.instanceCount
            ? `Model “${model.name}” still has ${usage.instanceCount} scene instances. Deleting it breaks those references; remove the instances first. Delete anyway?`
            : `Delete unused model “${model.name}”?`,
        ),
      )
    )
      return;
    setModelLibraryBusy(true);
    try {
      await onDeleteModel(model);
    } finally {
      setModelLibraryBusy(false);
    }
  }

  async function refreshLibraryModels() {
    setModelLibraryBusy(true);
    try {
      await onRefreshModels();
    } finally {
      setModelLibraryBusy(false);
    }
  }

  async function uploadLibraryImages(files: FileList | null) {
    if (!files?.length || !project) return;
    setModelLibraryBusy(true);
    try {
      for (const file of [...files]) await api.uploadImageAsset(project.id, file);
      await onRefreshModels();
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setModelLibraryBusy(false);
      if (imageUploadRef.current) imageUploadRef.current.value = "";
    }
  }

  async function uploadLibraryVideos(files: FileList | null) {
    if (!files?.length || !project) return;
    setModelLibraryBusy(true);
    try {
      for (const file of [...files]) await api.uploadVideoAsset(project.id, file);
      await onRefreshModels();
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setModelLibraryBusy(false);
      if (videoUploadRef.current) videoUploadRef.current.value = "";
    }
  }

  async function renameLibraryItem(item: ModelRecord | ProjectAssetRecord, kind: "model" | "asset") {
    if (!project) return;
    const nextName = window.prompt(tr(locale, "输入新的资源名称", "Enter a new asset name"), item.name)?.trim();
    if (!nextName || nextName === item.name) return;
    setModelLibraryBusy(true);
    try {
      if (kind === "model") await api.renameModel(project.id, item.id, nextName);
      else await api.renameAsset(project.id, item.id, nextName);
      await onRefreshModels();
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setModelLibraryBusy(false);
    }
  }

  async function deleteLibraryAsset(asset: ProjectAssetRecord) {
    const kindName = asset.kind === "video"
      ? tr(locale, "视频", "video")
      : asset.kind === "environment"
        ? tr(locale, "环境", "environment")
        : asset.kind === "pbr-material"
          ? tr(locale, "材质", "material")
          : tr(locale, "图片", "image");
    const usage = resourceGovernance.resources.find((resource) => resource.kind === "media" && resource.id === asset.id);
    const appearanceAsset = asset.kind === "environment" || asset.kind === "pbr-material";
    const message = usage?.instanceCount
      ? tr(
          locale,
          `${kindName}“${asset.name}”仍被 ${usage.instanceCount} 个${appearanceAsset ? "场景或对象" : "二维组件"}引用，删除后引用会断开。仍要删除吗？`,
          `${kindName} “${asset.name}” is referenced by ${usage.instanceCount} ${appearanceAsset ? "scenes or objects" : "dashboard components"}. Delete it and break those references?`,
        )
      : tr(locale, `确定删除未引用${kindName}“${asset.name}”吗？`, `Delete unused ${kindName} “${asset.name}”?`);
    if (!project || !window.confirm(message)) return;
    setModelLibraryBusy(true);
    try {
      await api.deleteAsset(project.id, asset.id);
      await onRefreshModels();
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setModelLibraryBusy(false);
    }
  }

  const normalizedSearch = assetSearch.trim().toLocaleLowerCase();
  const visibleModels = (project?.models ?? []).filter(
    (model) => (assetTab === "all" || assetTab === "model") && (!normalizedSearch || model.name.toLocaleLowerCase().includes(normalizedSearch)),
  );
  const visibleImages = (project?.assets ?? []).filter(
    (asset) => asset.kind === "image" && (assetTab === "all" || assetTab === "image") && (!normalizedSearch || asset.name.toLocaleLowerCase().includes(normalizedSearch)),
  );
  const visibleVideos = (project?.assets ?? []).filter(
    (asset) => asset.kind === "video" && (assetTab === "all" || assetTab === "video") && (!normalizedSearch || asset.name.toLocaleLowerCase().includes(normalizedSearch)),
  );
  const visibleAppearanceAssets = (project?.assets ?? []).filter(
    (asset) => (asset.kind === "environment" || asset.kind === "pbr-material")
      && (assetTab === "all" || assetTab === asset.kind)
      && (!normalizedSearch || asset.name.toLocaleLowerCase().includes(normalizedSearch)),
  );

  return {
    assetScope,
    selectedAssetModelId,
    onReturnToScene,
    assetSearch,
    assetTab,
    branding,
    busy,
    cloudBusySceneId,
    cloudConfigured,
    cloudError,
    cloudSceneLinks,
    cloudScenePolicies,
    copyLink,
    copyNotice,
    createShowcase,
    deleteLibraryAsset,
    deleteLibraryModel,
    deliveryReviewOpen,
    dialogMode,
    enableProjectCloudRender,
    imageUploadRef,
    isAdmin,
    locale,
    managerTab,
    modelLibraryBusy,
    modelUploadRef,
    name,
    normalizedSearch,
    navigationNotice,
    onDismissNavigationNotice,
    onAiAssistant,
    onBrowse,
    onBrowsePublished,
    onCloudRender,
    onConnectionStatus,
    onCopy,
    onCreateProject,
    onCreateTopology,
    onCredits,
    onDataCenter,
    onDelete,
    onDeleteProject,
    onDocs,
    onExportFbx,
    onExportGlb,
    onExportLoose,
    onExportSingle,
    onImport,
    onLocaleToggle,
    onLogout,
    onOpen,
    onOpenBehavior,
    onOpenSimulation,
    onOpenTopology,
    onOperationsCenter,
    onOptimizer,
    onProjectChange,
    onPublish,
    onRenameProject,
    onSystem,
    onUnpublish,
    onVisionCenter,
    openCreateDialog,
    openRenameDialog,
    openVersions,
    parametricSourceModel,
    parametricWorkbenchOpen,
    project,
    projectCloudBusy,
    projects,
    publicationVersions,
    resourceGovernance,
    publishMode,
    publishPerformance,
    publishTarget,
    refreshLibraryModels,
    renameLibraryItem,
    restoreVersion,
    scenes,
    sceneSearch,
    sceneSort,
    sceneStatusFilter,
    setAssetSearch,
    setAssetTab,
    setCloudError,
    setDeliveryReviewOpen,
    setDialogMode,
    setManagerTab,
    setName,
    setSceneSearch,
    setSceneSort,
    setSceneStatusFilter,
    setParametricSourceModel,
    setParametricWorkbenchOpen,
    setPublishMode,
    setPublishPerformance,
    setPublishTarget,
    setVersionTarget,
    showcaseBusy,
    showcaseExists,
    sortedScenes,
    submitPublish,
    submitSceneDialog,
    toggleSceneCloudRender,
    topologies,
    uploadLibraryImages,
    uploadLibraryModels,
    uploadLibraryVideos,
    userName,
    versionBusy,
    versionError,
    versionTarget,
    videoUploadRef,
    visibleImages,
    visibleAppearanceAssets,
    visibleModels,
    visibleVideos,
    visibleScenes,
  };
}

export type SceneManagerController = ReturnType<typeof useSceneManagerController>;

export function SceneManager(props: SceneManagerProps) {
  const controller = useSceneManagerController(props);
  return <SceneManagerView controller={controller} />;
}
