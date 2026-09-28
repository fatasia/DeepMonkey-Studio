import { useCallback, useSyncExternalStore } from "react";
import type { TransientChannel } from "../viewer/transientChannel.js";

export interface UseTransientValueOptions<Snapshot> {
  /** 消费端节流:两次 React 渲染之间的最小间隔;中间值只更新外部快照不触发渲染。默认 0(每次变更都渲染)。 */
  throttleMs?: number;
  /** 值不可用时(通道尚无快照)的渲染期兜底;不传则首帧前组件须保证不渲染或由调用方守卫。 */
  fallback?: Snapshot;
}

/**
 * React 侧的 transient 订阅:useSyncExternalStore + selector + 消费端节流。
 * selector 只应做纯投影(取字段/轻量换算);返回值经 Object.is 比较,不变不渲染。
 * 与 R3F useFrame 的区别:这里只服务"确实需要 React 渲染"的面板;纯 DOM 读数请用
 * bindTransientText/bindTransientStyle 直写通道,完全绕开渲染。
 */
export function useTransientValue<Snapshot, Selected>(
  channel: TransientChannel<Snapshot> | undefined,
  selector: (snapshot: Snapshot) => Selected,
  options?: UseTransientValueOptions<Selected>,
): Selected | undefined {
  const getSnapshot = useCallback((): Selected | undefined => {
    if (!channel) return options?.fallback;
    try {
      return selector(channel.snapshot());
    } catch {
      return options?.fallback;
    }
  }, [channel, selector, options?.fallback]);

  const subscribe = useCallback((onStoreChange: () => void) => {
    if (!channel) return () => undefined;
    const throttleMs = options?.throttleMs ?? 0;
    let lastRender = 0;
    let pendingHandle: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = channel.subscribe(() => {
      if (throttleMs <= 0) {
        onStoreChange();
        return;
      }
      const now = Date.now();
      const elapsed = now - lastRender;
      if (elapsed >= throttleMs) {
        lastRender = now;
        onStoreChange();
        return;
      }
      if (pendingHandle !== undefined) return;
      pendingHandle = setTimeout(() => {
        pendingHandle = undefined;
        lastRender = Date.now();
        onStoreChange();
      }, throttleMs - elapsed);
    });
    return () => {
      unsubscribe();
      if (pendingHandle !== undefined) clearTimeout(pendingHandle);
    };
  }, [channel, options?.throttleMs]);

  return useSyncExternalStore(subscribe, getSnapshot, () => options?.fallback);
}
