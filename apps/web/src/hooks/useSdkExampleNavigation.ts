import { useEffect, useRef, useState } from "react";
import type { AppRoute } from "../appRoute";
import type { AppViewBindings } from "../views/appViewBindings";
import { getSdkExample, type SdkExampleId } from "../docs/sdkExamples";
import { sdkExampleUnavailableReason, type SdkExampleInsertRequest, type SdkExampleWorkspaceContext } from "../behavior/sdkExampleInsertion";

export interface SdkExampleOrigin {
  route: AppRoute;
  userId?: string;
}

export function sdkExampleDestination(origin: SdkExampleOrigin | undefined, identity: {
  userId?: string; projectId?: string; applicationId?: string;
}): AppRoute | undefined {
  const route = origin?.route;
  if (!route || !identity.userId || origin.userId !== identity.userId) return undefined;
  if (route.view !== "dashboard" && route.view !== "studio") return undefined;
  if (!identity.projectId || route.projectId !== identity.projectId || !identity.applicationId || route.applicationId !== identity.applicationId) return undefined;
  if (route.view === "dashboard" ? !route.pageId : !route.sceneId) return undefined;
  return structuredClone(route);
}

/** 请求只属于进入文档前的编辑器身份，不把已加载但未打开的应用当作插入目标。 */
export function useSdkExampleNavigation(bindings: AppViewBindings) {
  const { state, actions } = bindings;
  const origin = useRef<SdkExampleOrigin | undefined>(undefined);
  const latest = useRef(bindings);
  latest.current = bindings;
  if (state.route.view !== "docs") origin.current = {
    route: structuredClone(state.route), ...(state.currentUser ? { userId: state.currentUser.id } : {}),
  };
  const [request, setRequest] = useState<SdkExampleInsertRequest>();
  const requested = useRef<SdkExampleInsertRequest | undefined>(undefined);
  const requestedUserId = useRef<string | undefined>(undefined);
  const identity = {
    ...(state.currentUser ? { userId: state.currentUser.id } : {}),
    ...(state.project ? { projectId: state.project.id } : {}),
    ...(state.activeApplication ? { applicationId: state.activeApplication.metadata.id } : {}),
  };
  const destination = sdkExampleDestination(origin.current, identity);
  const applicationMatchesProject = state.activeApplication?.metadata.projectId === state.project?.id;
  const context: SdkExampleWorkspaceContext = {
    authenticated: state.authReady && Boolean(state.currentUser),
    ...(destination && applicationMatchesProject ? { projectId: state.project!.id, projectName: state.project!.name, applicationId: state.activeApplication!.metadata.id } : {}),
    ...(!destination || !applicationMatchesProject ? { unavailableReason: "请先打开项目的二维或三维编辑器，再从文档新增样例。" } : {}),
  };

  useEffect(() => {
    if (!requested.current) return;
    if (!state.currentUser || state.currentUser.id !== requestedUserId.current ||
      !["studio", "dashboard"].includes(state.route.view) ||
      requested.current.projectId !== state.project?.id || requested.current.applicationId !== state.activeApplication?.metadata.id ||
      requested.current.projectId !== state.route.projectId || requested.current.applicationId !== state.route.applicationId) {
      requested.current = undefined;
      requestedUserId.current = undefined;
      setRequest(undefined);
    }
  }, [state.currentUser?.id, state.project?.id, state.activeApplication?.metadata.id, state.route.view, state.route.projectId, state.route.applicationId]);

  function insert(exampleId: SdkExampleId) {
    const current = latest.current.state;
    const reason = sdkExampleUnavailableReason(context);
    if (reason || !destination || current.route.view !== "docs") throw new Error(reason ?? "当前编辑上下文已改变，请重新打开文档。");
    if (requested.current) return;
    if (!getSdkExample(exampleId)) throw new Error("样例已不可用，请重新选择。");
    const document = current.applicationSessionRef.current.store.getState().document;
    if (!document || document.metadata.id !== context.applicationId || document.metadata.projectId !== context.projectId) throw new Error("当前应用已改变，请返回编辑器后重试。");
    if (destination.view === "dashboard" ? !document.pages.some(page => page.id === destination.pageId) : !document.scenes.some(scene => scene.id === destination.sceneId)) throw new Error("目标页面或场景已不存在，请返回编辑器重新选择。");
    const next: SdkExampleInsertRequest = {
      requestId: crypto.randomUUID(), exampleId, projectId: context.projectId!, applicationId: context.applicationId!,
    };
    requested.current = next;
    requestedUserId.current = current.currentUser?.id;
    setRequest(next);
    current.setSceneBehaviorOpen(true);
    current.setMessage("正在打开样例文件；可修改后试运行。");
    actions.navigate(destination);
  }

  function consumed(requestId: string) {
    if (requested.current?.requestId !== requestId) return;
    requested.current = undefined;
    requestedUserId.current = undefined;
    setRequest(undefined);
  }

  return { context, request, insert, consumed };
}
