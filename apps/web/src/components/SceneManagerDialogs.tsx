import { lazy, Suspense } from "react";
import { RefreshCw } from "lucide-react";
import type { ConversionStatus } from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import { DeliveryReviewDialog, PublicationVersionItem } from "./SceneDeliveryWorkflow";
import { ScenePublicationDialog } from "./ScenePublicationDialog";
import { NameLengthHint } from "./NameLengthHint";
import type { SceneManagerController } from "./SceneManager";
import { useDialogEscape } from "../hooks/useGlobalDialogEscape";

const ParametricModelWorkbench = lazy(() => import("../parametric/ParametricModelWorkbench"));

function statusLabel(status: ConversionStatus, locale: AppLocale): string {
  const zh = { queued: "排队中", processing: "转换中", ready: "可使用", waiting_converter: "等待转换器", failed: "失败" }[status];
  const en = { queued: "Queued", processing: "Converting", ready: "Ready", waiting_converter: "Waiting for converter", failed: "Failed" }[status];
  return tr(locale, zh, en);
}

export function SceneManagerDialogs({ controller }: { controller: SceneManagerController }) {
  const {
    busy,
    cloudConfigured,
    cloudHint,
    deliveryReviewOpen,
    dialogMode,
    locale,
    name,
    onDataCenter,
    onOpen,
    onPublish,
    openVersions,
    parametricSourceModel,
    parametricWorkbenchOpen,
    project,
    publicationVersions,
    publishMode,
    publishPerformance,
    publishTarget,
    refreshLibraryModels,
    restoreVersion,
    scenes,
    setDeliveryReviewOpen,
    setDialogMode,
    setManagerTab,
    setName,
    setParametricSourceModel,
    setParametricWorkbenchOpen,
    setPublishMode,
    setPublishPerformance,
    setPublishTarget,
    setVersionTarget,
    sortedScenes,
    submitPublish,
    submitSceneDialog,
    versionBusy,
    versionError,
    versionTarget,
  } = controller;
  const sceneEscapeRef = useDialogEscape(() => setDialogMode(undefined), busy);
  const versionEscapeRef = useDialogEscape(() => setVersionTarget(undefined), versionBusy);
  const loadingEscapeRef = useDialogEscape(() => undefined, true);

  return (
    <>
      {dialogMode && (
        <div className="dialog-backdrop" ref={sceneEscapeRef} onMouseDown={() => !busy && setDialogMode(undefined)}>
          <form
            className="dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void submitSceneDialog();
            }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className="eyebrow">{dialogMode === "rename" ? "RENAME SCENE" : "NEW SCENE"}</span>
            <h2>{dialogMode === "rename" ? tr(locale, "重命名场景", "Rename scene") : tr(locale, "新建场景", "New scene")}</h2>
            <p>
              {dialogMode === "rename"
                ? tr(locale, "修改场景在管理中心和编辑器中显示的名称。", "Change the scene name shown in management and the editor.")
                : tr(locale, "新场景从空画布开始，之后可以连续加载多个模型。", "A new scene starts empty and can load multiple models.")}
            </p>
            <label>
              <span>{tr(locale, "场景名称", "Scene name")}</span>
              <input
                autoFocus
                disabled={busy}
                value={name}
                aria-describedby="scene-name-hint"
                onChange={(event) => setName(event.target.value)}
                placeholder={tr(locale, "例如：1 号楼施工总览", "For example: Building 1 overview")}
              />
            </label>
            <NameLengthHint id="scene-name-hint" value={name} locale={locale} />
            <div className="dialog-actions">
              <button type="button" className="button" disabled={busy} onClick={() => setDialogMode(undefined)}>
                {tr(locale, "取消", "Cancel")}
              </button>
              <button className="button primary" disabled={!name.trim() || busy}>
                {dialogMode === "rename" ? tr(locale, "保存名称", "Save name") : tr(locale, "创建并进入", "Create and open")}
              </button>
            </div>
          </form>
        </div>
      )}

      {parametricWorkbenchOpen && project && (
        <Suspense
          fallback={
            <div className="dialog-backdrop" ref={loadingEscapeRef}>
              <div className="optimizer-loading">
                <RefreshCw className="spin" size={22} />
                {tr(locale, "正在加载参数化建模内核…", "Loading parametric modeling…")}
              </div>
            </div>
          }
        >
          <ParametricModelWorkbench
            projectId={project.id}
            locale={locale}
            dataConnections={project.dataConnections ?? []}
            datasets={project.datasets ?? []}
            {...(parametricSourceModel ? { sourceModel: parametricSourceModel } : {})}
            onClose={() => {
              setParametricWorkbenchOpen(false);
              setParametricSourceModel(undefined);
            }}
            onSaved={async () => {
              await refreshLibraryModels();
            }}
          />
        </Suspense>
      )}

      {deliveryReviewOpen && project && (
        <DeliveryReviewDialog
          locale={locale}
          project={project}
          scenes={scenes}
          onClose={() => setDeliveryReviewOpen(false)}
          onOpenData={() => {
            setDeliveryReviewOpen(false);
            onDataCenter();
          }}
          onOpenAssets={() => {
            setDeliveryReviewOpen(false);
            setManagerTab("assets");
          }}
          onOpenScenes={() => {
            setDeliveryReviewOpen(false);
            setManagerTab("scenes");
          }}
          onOpenLinkage={(sceneId) => {
            setDeliveryReviewOpen(false);
            const linked = sortedScenes.find((scene) => scene.id === sceneId)
              ?? sortedScenes.find((scene) => (scene.dataBindings?.length ?? 0) + (scene.interactions?.length ?? 0) > 0)
              ?? sortedScenes[0];
            if (linked) void onOpen(linked);
            else setManagerTab("scenes");
          }}
        />
      )}

      {publishTarget && (
        <ScenePublicationDialog
          locale={locale}
          sceneName={publishTarget.name}
          mode={publishMode}
          performance={publishPerformance}
          defaultToolbarVisible={publishTarget.publicationToolbarVisible !== false}
          cloudConfigured={cloudConfigured}
          cloudHint={cloudHint}
          busy={busy}
          onModeChange={setPublishMode}
          onPerformanceChange={setPublishPerformance}
          onCancel={() => setPublishTarget(undefined)}
          onPublish={(toolbarVisible) => void submitPublish(toolbarVisible)}
        />
      )}

      {versionTarget && (
        <div className="dialog-backdrop" ref={versionEscapeRef} onMouseDown={() => !versionBusy && setVersionTarget(undefined)}>
          <section className="dialog publication-history-dialog" role="dialog" aria-modal="true" aria-label={tr(locale, "发布版本", "Publication versions")} onMouseDown={(event) => event.stopPropagation()}>
            <span className="eyebrow">VERSION HISTORY</span>
            <h2>{tr(locale, "发布版本", "Publication versions")}</h2>
            <p>
              {versionTarget.name} ·{" "}
              {tr(
                locale,
                "每个版本均与当前草稿比较；恢复会生成新的发布版本，不会抹掉历史。",
                "Each version is compared with the current draft. Restoring creates a new publication without deleting history.",
              )}
            </p>
            <div className="publication-history-list">
              {versionBusy && <div role="status">{tr(locale, "正在读取版本记录…", "Loading versions…")}</div>}
              {versionError && <div role="alert">{versionError}</div>}
              {publicationVersions.map((version, index) => (
                <PublicationVersionItem
                  key={`${version.publishedAt}:${version.version}`}
                  locale={locale}
                  draft={versionTarget}
                  version={version}
                  fallbackVersion={publicationVersions.length - index}
                  latest={index === 0}
                  busy={versionBusy}
                  onRestore={() => void restoreVersion(version.publishedAt)}
                />
              ))}
              {!versionBusy && !versionError && publicationVersions.length === 0 && <div>{tr(locale, "暂无版本记录", "No versions yet")}</div>}
            </div>
            <div className="dialog-actions">
              {versionError && <button className="button" disabled={versionBusy} onClick={() => void openVersions(versionTarget)}>{tr(locale, "重新加载", "Reload")}</button>}
              <button className="button" disabled={versionBusy} onClick={() => setVersionTarget(undefined)}>
                {tr(locale, "关闭", "Close")}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
