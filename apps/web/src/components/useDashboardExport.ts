import { useLayoutEffect, useMemo, useState } from "react";
import { createDashboardExportSession, type DashboardExportState } from "./dashboardExportSession";

export function useDashboardExport(pageKey: string) {
  const [state, setState] = useState<DashboardExportState>({ busy: false, error: "", completed: false });
  const session = useMemo(() => createDashboardExportSession(setState), []);
  useLayoutEffect(() => {
    session.cancel();
    return () => session.cancel(true);
  }, [session, pageKey]);
  return { ...state, run: session.run, cancel: session.cancel };
}
