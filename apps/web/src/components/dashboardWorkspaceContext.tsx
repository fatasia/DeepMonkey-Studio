import { createContext, type ReactNode, useContext } from "react";
import type { DashboardWorkspaceController } from "./DashboardWorkspace";

const DashboardWorkspaceContext = createContext<DashboardWorkspaceController | undefined>(undefined);

export function DashboardWorkspaceProvider({ controller, children }: { controller: DashboardWorkspaceController; children: ReactNode }) {
  return <DashboardWorkspaceContext.Provider value={controller}>{children}</DashboardWorkspaceContext.Provider>;
}

export function useDashboardWorkspace(): DashboardWorkspaceController {
  const controller = useContext(DashboardWorkspaceContext);
  if (!controller) throw new Error("DashboardWorkspace 子组件必须位于 Provider 内");
  return controller;
}
