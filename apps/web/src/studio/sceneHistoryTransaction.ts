/** 事件命令使用同步提交，让快照工厂读取已提交的 React 作者状态。 */
export function runSceneHistoryTransaction(
  change: () => void,
  flushHistory: () => void,
  commitState: (change: () => void) => void,
): void {
  flushHistory();
  commitState(change);
  flushHistory();
}
