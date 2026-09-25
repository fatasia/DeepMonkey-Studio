import { Bot, Languages, LogOut, Settings } from "lucide-react";
import { api, setAuthToken } from "../api";
import { storeLocale, translate as tr } from "../i18n";
import { AiAssistantPanel } from "../components/AiAssistantPanel";
import type { AiWorkspaceTask } from "../ai/capabilityCatalog";
import { CreditsModal } from "../components/CreditsModal";
import { DigitalTwinPanel } from "../components/DigitalTwinPanel";
import { WorkspaceRecoveryDialog } from "../components/WorkspaceRecoveryDialog";
import { ApplicationRecoveryDialog } from "../components/ApplicationRecoveryDialog";
import type { AppViewBindings } from "./appViewBindings";
import { dashboardDraftPageContext, validateDashboardDraft } from "../ai/dashboardDraft";

const assistantViews = new Set(["manager", "dashboard", "optimizer", "data", "vision", "operations"]);
const utilityViews = new Set(["manager", "optimizer", "data", "vision", "operations", "system"]);
type OperationsAiTask = Extract<AiWorkspaceTask, { workspace: "operations" }>;

export function AppPlatformOverlays({ bindings }: { bindings: AppViewBindings }) {
  const { state, recovery, actions } = bindings;
  const { activeApplication, activeDashboardPage, applicationState, currentUser, locale, project, route, scenes } = state;
  if (!currentUser) return null;

  const assistantVisible = state.aiAssistantOpen && assistantViews.has(route.view);
  // 管理页保留主导航触发的 AI 面板，但不再重复悬浮工具栏。
  const utilityVisible = route.view !== "manager" && utilityViews.has(route.view);
  return (
    <>
      {assistantVisible && (
        <AiAssistantPanel
          locale={locale}
          projectId={project?.id}
          surface="platform"
          context={route.view === "dashboard" && activeApplication && activeDashboardPage ? {
            dashboardDraftVersion: 1,
            project: project ? { id: project.id, name: project.name } : undefined,
            projectId: activeApplication.metadata.projectId,
            applicationId: activeApplication.metadata.id,
            currentView: "dashboard",
            dashboard: { id: activeDashboardPage.id, name: activeDashboardPage.name, widgets: activeDashboardPage.nodes.map(node => ({ id: node.id, kind: node.kind, name: node.name })) },
            page: dashboardDraftPageContext(activeDashboardPage),
            selection: applicationState.selection,
            selected: (() => {
              const selectedId = applicationState.selection.find(item => item.kind === "widget")?.id;
              const selected = activeDashboardPage.nodes.find(node => node.id === selectedId);
              return selected ? { id: selected.id, name: selected.name ?? selected.id, kind: selected.kind } : undefined;
            })(),
          } : {
            project: project ? { id: project.id, name: project.name } : undefined,
            currentView: route.view,
            scenes: scenes.map((scene) => ({
              id: scene.id,
              name: scene.name,
              updatedAt: scene.updatedAt,
              publishedAt: scene.publishedAt,
            })),
          }}
          {...(route.view === "dashboard" && activeApplication && activeDashboardPage
            ? {
                onValidateDashboardPageDraft: (draft: unknown, datasets: Parameters<typeof validateDashboardDraft>[3]) => {
                  const validated = validateDashboardDraft(draft, activeApplication, activeDashboardPage, datasets);
                  return { changeCount: validated.diff.length, labels: validated.diff.map(change => change.title) };
                },
                ...(currentUser.role !== "viewer" ? {
                  onApplyDashboardPageDraft: (draft: unknown, datasets: Parameters<typeof validateDashboardDraft>[3]) => {
                    const validated = validateDashboardDraft(draft, activeApplication, activeDashboardPage, datasets);
                    if (!validated.command) throw new Error(tr(locale, "没有可应用的二维变更", "There are no 2D changes to apply"));
                    bindings.applicationRuntime.dispatchApplicationCommand(validated.command);
                  },
                } : {}),
              }
            : {})}
          {...(project
            ? {
                onOpenWorkspaceTask: (task: OperationsAiTask) => {
                  state.setAiAssistantOpen(false);
                  actions.navigate({ view: "operations", operationsTab: task.tab });
                },
              }
            : {})}
          onClose={() => state.setAiAssistantOpen(false)}
        />
      )}
      {utilityVisible && <GlobalUtility bindings={bindings} />}
      {state.digitalTwinOpen && (
        <DigitalTwinPanel
          locale={locale}
          onClose={() => state.setDigitalTwinOpen(false)}
          status={state.sceneDataStatus}
          received={state.sceneDataReceived}
        />
      )}
      {recovery.draft && (
        <WorkspaceRecoveryDialog
          locale={locale}
          draft={recovery.draft}
          {...(activeApplication ? { serverRevision: activeApplication.metadata.revision } : {})}
          busy={recovery.busy}
          onRestore={() => void recovery.restore()}
          onExport={recovery.export}
          onDefer={recovery.defer}
          onDiscard={() => void recovery.discard()}
        />
      )}
      {!recovery.draft && bindings.applicationRecovery?.draft && <ApplicationRecoveryDialog recovery={bindings.applicationRecovery} locale={locale} />}
      {utilityVisible && state.creditsOpen && (
        <CreditsModal locale={locale} systemName={state.branding.systemName} onClose={() => state.setCreditsOpen(false)} />
      )}
      {state.error && <div className="toast error">{state.error}</div>}
    </>
  );
}

function GlobalUtility({ bindings }: { bindings: AppViewBindings }) {
  const { state, actions } = bindings;
  const { currentUser, locale, route } = state;
  if (!currentUser) return null;

  return (
    <div className={`global-utility global-utility-${route.view}`}>
      {currentUser.role === "admin" && (
        <button onClick={() => actions.navigate({ view: "system" })}>
          <Settings size={15} /> {tr(locale, "设置", "Settings")}
        </button>
      )}
      {route.view !== "system" && (
        <button className={state.aiAssistantOpen ? "active" : ""} onClick={() => state.setAiAssistantOpen((open) => !open)}>
          <Bot size={15} /> AI
        </button>
      )}
      <button
        onClick={() => {
          const next = locale === "zh-CN" ? "en-US" : "zh-CN";
          state.setLocale(next);
          storeLocale(next);
        }}
      >
        <Languages size={15} /> {locale === "zh-CN" ? "EN" : "中文"}
      </button>
      <button
        title={`${currentUser.displayName} · ${currentUser.role}`}
        onClick={() =>
          void api.logout().finally(() => {
            setAuthToken();
            state.setCurrentUser(undefined);
            state.setProjects([]);
            state.setProject(undefined);
          })
        }
      >
        <LogOut size={15} /> {tr(locale, "退出", "Sign out")}
      </button>
    </div>
  );
}
