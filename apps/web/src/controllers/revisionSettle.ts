/**
 * A3(2026-10-06 应用层交互风暴归因):滑块类连续写路径的 revision 合流。
 *
 * 归因实测(apps/web/scripts/_tmp-app-perf-storm.mjs,2026-10-06):
 * 不透明度滑块 1s 拖拽 = 121 次全壳 React 提交,React 自采样占该窗口 CPU 35.8%,
 * 长任务 85ms——每次 range onChange 的 setRevision 都是一次全壳(631 组件)提交。
 * revision 的消费方(交互目标清单、后处理判定、派生只读视图)只需要拖拽静止后的
 * 收敛值;引擎写点(setOpacity 等)保持逐事件,画布反馈不受影响。
 *
 * 语义:首沿立即(距上次冲刷 ≥intervalMs 的首个事件同步落定,离散单击不受延迟)、
 * 尾沿 intervalMs 内落定(拖拽结束 ≤150ms 后收敛值与逐事件应用逐位一致)。
 */
let revisionSettleTimer: number | undefined;
let revisionLastFlush = Number.NEGATIVE_INFINITY;

export function settleRevision(setRevision: (updater: (value: number) => number) => void, intervalMs = 150): void {
  const flush = () => {
    revisionSettleTimer = undefined;
    revisionLastFlush = performance.now();
    setRevision((value) => value + 1);
  };
  const elapsed = performance.now() - revisionLastFlush;
  if (elapsed >= intervalMs) {
    if (revisionSettleTimer !== undefined) {
      window.clearTimeout(revisionSettleTimer);
      revisionSettleTimer = undefined;
    }
    flush();
    return;
  }
  if (revisionSettleTimer === undefined) revisionSettleTimer = window.setTimeout(flush, intervalMs - elapsed);
}
