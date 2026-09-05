import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { usePersistedBooleanState } from "../hooks/usePersistedBooleanState";
import type { DashboardFieldDrag } from "./dashboardFieldBinding";
import { useDashboardFieldCatalog } from "./useDashboardFieldCatalog";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";
import "./DashboardFieldBinding.css";

function useDataBindingState() {
  const { project, selectedNode, inspectorTab, inspectorOpen } = useDashboardWorkspace();
  const [open, setOpen] = usePersistedBooleanState("bim-studio:dashboard:data-panel-open", false);
  const [drag, setDrag] = useState<DashboardFieldDrag>();
  const catalog = useDashboardFieldCatalog(project.id, open || (inspectorOpen && inspectorTab === "data" && selectedNode?.kind === "data-widget"));
  useEffect(() => {
    const stop = () => setDrag(undefined);
    window.addEventListener("dragend", stop);
    window.addEventListener("drop", stop);
    return () => { window.removeEventListener("dragend", stop); window.removeEventListener("drop", stop); };
  }, []);
  return { ...catalog, open, setOpen, drag, setDrag };
}
const BindingContext = createContext<ReturnType<typeof useDataBindingState> | undefined>(undefined);
export function DashboardDataBindingProvider({ children }: { children: ReactNode }) {
  const value = useDataBindingState();
  return <BindingContext.Provider value={value}>{children}</BindingContext.Provider>;
}
export function useDashboardDataBinding() {
  const value = useContext(BindingContext);
  if (!value) throw new Error("字段绑定需位于二维工作区内");
  return value;
}
