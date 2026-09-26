/**
 * Transient 专用通道(React↔3D 每帧数据的高性能旁路)。
 *
 * 设计目标:超越 R3F useFrame 模式——
 * 1. 变更驱动而非帧驱动:值经 Object.is diff,不变零成本(R3F useFrame 每帧必跑);
 * 2. 同帧写入合并:一帧内多次 publish 只通知一次(对齐渲染节拍);
 * 3. 三种消费粒度同源:DOM 直写(bindText/bindStyle,零 React 渲染)、
 *    useSyncExternalStore 细粒度 selector(只订阅组件渲染)、命令式 subscribe;
 * 4. 消费端自定节流(selector 级 throttleMs),源端永远无节流损耗;
 * 5. 发布侧 O(1),无分配(写时复用快照对象由消费端 selector 决定)。
 *
 * 语义约束:transient 通道的值不进 React state、不入场景快照、不持久化——
 * 它是"当前播放头/指针/相机位"这类纯瞬态;需要固化的状态仍走既有 reactive 通道。
 */

export interface TransientChannel<T> {
  /** 高频发布;Object.is 不变时零通知。 */
  publish(value: T): void;
  /** 命令式订阅;返回退订函数。监听器在合帧后收到最终值。 */
  subscribe(listener: (value: T) => void): () => void;
  /** 当前快照(引用在值不变时保持稳定,供 useSyncExternalStore)。 */
  snapshot(): T;
}

export interface TransientChannelOptions<T> {
  /** 发布时逐字段比较(浅比较对象字段),字段全等则跳过通知;默认 Object.is 整体比较。 */
  shallow?: boolean;
  /** 可选的外部调度(测试注入);默认用 requestAnimationFrame 合帧。 */
  schedule?: (task: () => void) => void;
  cancel?: (handle: unknown) => void;
}

interface ChannelRecord<T> {
  value: T | undefined;
  hasValue: boolean;
  listeners: Set<(value: T) => void>;
  schedule?: (task: () => void) => void;
  cancel?: (handle: unknown) => void;
  flushHandle?: unknown;
  flushScheduled: boolean;
  shallow: boolean;
}

export interface TransientChannelRegistry {
  channel<T>(name: string, options?: TransientChannelOptions<T>): TransientChannel<T>;
  /** 便捷访问:未创建过的通道返回 undefined(消费端应先由源侧创建)。 */
  peek<T>(name: string): TransientChannel<T> | undefined;
  /** 释放全部通道(引擎销毁时)。 */
  dispose(): void;
}

export function createTransientRegistry(scheduler?: {
  schedule: (task: () => void) => unknown;
  cancel: (handle: unknown) => void;
}): TransientChannelRegistry {
  const channels = new Map<string, ChannelRecord<unknown>>();
  const defaultSchedule = scheduler?.schedule ?? ((task: () => void) => requestAnimationFrame(task));
  const defaultCancel = scheduler?.cancel ?? ((handle: unknown) => cancelAnimationFrame(handle as number));

  function ensureChannel<T>(name: string, options?: TransientChannelOptions<T>): ChannelRecord<T> {
    const existing = channels.get(name);
    if (existing) return existing as ChannelRecord<T>;
    const created: ChannelRecord<T> = {
      value: undefined,
      hasValue: false,
      listeners: new Set(),
      schedule: options?.schedule ?? (defaultSchedule as (task: () => void) => void),
      ...(options?.cancel ? { cancel: options.cancel } : {}),
      flushScheduled: false,
      shallow: options?.shallow ?? false,
    };
    channels.set(name, created as ChannelRecord<unknown>);
    return created;
  }

  function flush<T>(record: ChannelRecord<T>): void {
    record.flushScheduled = false;
    if (!record.hasValue) return;
    const value = record.value as T;
    for (const listener of [...record.listeners]) listener(value);
  }

  function shallowEqual(previous: unknown, next: unknown): boolean {
    if (previous === next) return true;
    if (typeof previous !== "object" || typeof next !== "object" || !previous || !next) return false;
    const left = previous as Record<string, unknown>;
    const right = next as Record<string, unknown>;
    const leftKeys = Object.keys(left);
    if (leftKeys.length !== Object.keys(right).length) return false;
    return leftKeys.every((key) => left[key] === right[key]);
  }

  return {
    channel<T>(name: string, options?: TransientChannelOptions<T>): TransientChannel<T> {
      const record = ensureChannel<T>(name, options);
      return {
        publish(value: T): void {
          if (record.hasValue) {
            const unchanged = record.shallow
              ? shallowEqual(record.value, value)
              : Object.is(record.value, value);
            if (unchanged) return;
          }
          record.value = value;
          record.hasValue = true;
          if (record.flushScheduled || record.listeners.size === 0) return;
          record.flushScheduled = true;
          record.schedule?.(() => flush(record));
        },
        subscribe(listener: (value: T) => void): () => void {
          record.listeners.add(listener);
          return () => record.listeners.delete(listener);
        },
        snapshot(): T {
          if (!record.hasValue) throw new Error(`transient channel "${name}" 尚无快照`);
          return record.value as T;
        },
      };
    },
    peek<T>(name: string): TransientChannel<T> | undefined {
      return channels.get(name) as TransientChannel<T> | undefined;
    },
    dispose(): void {
      for (const record of channels.values()) {
        if (record.flushHandle !== undefined) record.cancel?.(record.flushHandle);
        record.listeners.clear();
        record.hasValue = false;
        record.value = undefined;
      }
      channels.clear();
    },
  };
}

/** 浅比较发布的便捷构造(对象快照通道)。 */
export function createShallowChannel<T extends object>(registry: TransientChannelRegistry, name: string): TransientChannel<T> {
  return registry.channel<T>(name, { shallow: true });
}
