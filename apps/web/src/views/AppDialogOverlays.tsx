import { translate as tr } from "../i18n";
import { ScenePublicationDialog } from "../components/ScenePublicationDialog";
import { NameLengthHint } from "../components/NameLengthHint";
import type { AppViewBindings } from "./appViewBindings";
import { useDialogEscape } from "../hooks/useGlobalDialogEscape";

export function AppDialogOverlays({ bindings }: { bindings: AppViewBindings }) {
  return (
    <>
      <ProjectDialog bindings={bindings} />
      <PublicationDialog bindings={bindings} />
    </>
  );
}

function ProjectDialog({ bindings }: { bindings: AppViewBindings }) {
  const { state, actions } = bindings;
  const { busy, locale, newProjectDescription, newProjectName, projectDialogMode } = state;
  const escapeRef = useDialogEscape(() => state.setProjectDialogMode(undefined), busy);
  if (!projectDialogMode) return null;

  return (
    <div className="dialog-backdrop" ref={escapeRef} onMouseDown={() => !busy && state.setProjectDialogMode(undefined)}>
      <form
        className="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void actions.submitProjectDialog();
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="eyebrow">{projectDialogMode === "rename" ? "EDIT PROJECT" : "NEW PROJECT"}</span>
        <h2>
          {projectDialogMode === "rename"
            ? tr(locale, "编辑项目", "Edit project")
            : tr(locale, "新建项目", "New project")}
        </h2>
        <p>
          {projectDialogMode === "rename"
            ? tr(
                locale,
                "修改项目名称和说明，不影响已有模型与场景。",
                "Change the project name and description without affecting existing models or scenes.",
              )
            : tr(
                locale,
                "项目用于隔离模型资产和场景，可随时从顶部切换。",
                "Projects separate model assets and scenes and can be switched from the top bar.",
              )}
        </p>
        <label>
          <span>{tr(locale, "项目名称", "Project name")}</span>
          <input
            autoFocus
            disabled={busy}
            value={newProjectName}
            aria-describedby="project-name-hint"
            onChange={(event) => state.setNewProjectName(event.target.value)}
            placeholder={tr(locale, "例如：研发中心一期", "For example: R&D Center Phase 1")}
          />
        </label>
        <NameLengthHint id="project-name-hint" value={newProjectName} locale={locale} />
        <label>
          <span>{tr(locale, "项目说明", "Project description")}</span>
          <textarea
            disabled={busy}
            value={newProjectDescription}
            onChange={(event) => state.setNewProjectDescription(event.target.value)}
            placeholder={tr(locale, "可选", "Optional")}
            rows={3}
          />
        </label>
        <div className="dialog-actions">
          <button type="button" className="button" disabled={busy} onClick={() => state.setProjectDialogMode(undefined)}>
            {tr(locale, "取消", "Cancel")}
          </button>
          <button className="button primary" disabled={!newProjectName.trim() || busy}>
            {busy
              ? tr(locale, "保存中…", "Saving…")
              : projectDialogMode === "rename"
                ? tr(locale, "保存修改", "Save changes")
                : tr(locale, "创建并切换", "Create and switch")}
          </button>
        </div>
      </form>
    </div>
  );
}

function PublicationDialog({ bindings }: { bindings: AppViewBindings }) {
  const { state, scenePersistence } = bindings;
  const { activeScene, busy, locale, studioCloudConfigured, studioCloudHint, studioPublishMode, studioPublishPerformance, studioPublishClientTarget } = state;
  if (!state.studioPublishOpen || !activeScene) return null;

  return <ScenePublicationDialog
    artifacts={bindings.publicationArtifacts}
    projectId={activeScene.projectId}
    sceneId={activeScene.id}
    locale={locale}
    sceneName={activeScene.name}
    mode={studioPublishMode}
    performance={studioPublishPerformance}
    clientTarget={studioPublishClientTarget}
    defaultToolbarVisible={activeScene.publicationToolbarVisible !== false}
    cloudConfigured={studioCloudConfigured}
    cloudHint={studioCloudHint}
    busy={busy}
    onModeChange={state.setStudioPublishMode}
    onPerformanceChange={state.setStudioPublishPerformance}
    onClientTargetChange={state.setStudioPublishClientTarget}
    onCancel={() => state.setStudioPublishOpen(false)}
    onPublish={(toolbarVisible, clientTarget) => scenePersistence.publishActiveScene(studioPublishMode, studioPublishPerformance, toolbarVisible, clientTarget)}
  />;
}
