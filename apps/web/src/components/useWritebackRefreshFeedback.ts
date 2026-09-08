import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardRefreshResult } from "./dashboardDatasetRefreshQueue";

export type WritebackRefresh = () => void | DashboardRefreshResult | Promise<void | DashboardRefreshResult>;

/** 刷新状态不进入写回会话；取消/换记录只撤销反馈，不重放已经确认的写入。 */
export function useWritebackRefreshFeedback(saved: boolean, identity: unknown, onRefresh?: WritebackRefresh) {
  const callback = useRef(onRefresh); callback.current = onRefresh;
  const generation = useRef(0);
  const busy = useRef(false);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const refresh = useCallback(async () => {
    if (busy.current || !callback.current) return;
    const current = generation.current;
    busy.current = true;
    setStatus("loading");
    try {
      const result = await callback.current();
      if (current === generation.current) setStatus(result === "error" ? "error" : "idle");
    } catch {
      if (current === generation.current) setStatus("error");
    } finally {
      if (current === generation.current) busy.current = false;
    }
  }, []);
  useEffect(() => {
    generation.current++;
    busy.current = false;
    setStatus("idle");
    if (saved) void refresh();
    return () => { generation.current++; };
  }, [saved, identity, refresh]);
  return { status, refresh };
}
