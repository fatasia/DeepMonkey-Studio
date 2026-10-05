/**
 * P2-5（2026-10-06 对抗测试第二轮 §4.2）：三维工作台场景载入的进度门。
 *
 * 二维↔三维切换的 10–20s 窗口 = 路由恢复层的场景拉取 + applyScene（此前全程无 busy，
 * 视口没有进度态，用户被诱导重复点击）。本门在恢复读取在途时延迟接通 busy 进度态：
 * - 500ms 内完成不接通——快速载入不闪进度（任务书要求"超 500ms 显示进度态"）；
 * - 超时接通 busy：视口 loading-overlay 显现，播放/保存/撤销等写入口同步被既有 busy
 *   守卫拦住（场景重载中本就不该可写）；
 * - release 幂等：apply 完成 / apply 失败 / effect 清理三路任意先到都只释放一次。
 */
export interface SceneWorkspaceLoadGate {
  /** 恢复读取开始：启动 500ms 接通计时（release 后调用是空操作）。 */
  engage(): void;
  /** 载入结束（完成/失败/被替换）：未接通则撤表，已接通则解除 busy。可重复调用。 */
  release(): void;
}

export function createSceneWorkspaceLoadGate(setBusy: (busy: boolean) => void, engageDelayMs = 500): SceneWorkspaceLoadGate {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let engaged = false;
  let released = false;
  return {
    engage() {
      if (released) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (released) return;
        engaged = true;
        setBusy(true);
      }, engageDelayMs);
    },
    release() {
      if (released) return;
      released = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (engaged) setBusy(false);
    },
  };
}
