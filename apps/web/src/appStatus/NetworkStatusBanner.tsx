import { useSyncExternalStore } from "react";
import { networkStatusMonitor } from "./networkStatusMonitor";
import "../styles/app-network-status.css";

/**
 * 全局连接状态横幅:连续请求失败后出现,不阻塞操作、不可 Esc 关闭(它是状态不是弹层);
 * 恢复后短暂显示"已恢复"再自动收起。
 */
export function NetworkStatusBanner() {
  const snapshot = useSyncExternalStore(networkStatusMonitor.subscribe, networkStatusMonitor.getSnapshot);
  if (snapshot.phase === "idle") return undefined;
  const degraded = snapshot.phase === "degraded";
  return (
    <div className={`network-status-banner ${degraded ? "is-degraded" : "is-recovered"}`} role="status">
      <span className="network-status-dot" aria-hidden="true" />
      <strong>{degraded ? "与服务器的连接中断" : "连接已恢复"}</strong>
      <span className="network-status-detail">{degraded ? `${snapshot.detail ?? "网络异常"}，正在自动重试；页面内容保持当前状态` : "数据同步已继续"}</span>
    </div>
  );
}
