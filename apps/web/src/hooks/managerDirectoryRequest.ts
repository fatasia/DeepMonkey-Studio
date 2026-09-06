export interface DirectoryLoadState {
  key: string;
  phase: "idle" | "loading" | "ready" | "error";
  hasData: boolean;
  httpStatus?: number;
}

export const EMPTY_DIRECTORY_STATE: DirectoryLoadState = { key: "", phase: "idle", hasData: false };

/** 一个目录仅接受当前请求；手动重复点击合并，取消和迟到响应均不改变页面状态。 */
export function createDirectoryRequest<T>(publish: (state: DirectoryLoadState) => void) {
  let state = EMPTY_DIRECTORY_STATE;
  let generation = 0;
  let active: { key: string; controller: AbortController; promise: Promise<void> } | undefined;

  function cancel() { generation++; active?.controller.abort(); active = undefined; }

  function load(key: string, read: (signal: AbortSignal) => Promise<T>, accept: (data: T) => void, isCurrent: () => boolean) {
    if (active?.key === key) return active.promise;
    cancel();
    const request = generation;
    const controller = new AbortController();
    state = { key, phase: "loading", hasData: state.key === key && state.hasData };
    publish(state);
    const current = () => request === generation && !controller.signal.aborted && isCurrent();
    const promise = Promise.resolve().then(() => read(controller.signal)).then(data => {
      if (!current()) return;
      accept(data);
      state = { key, phase: "ready", hasData: true };
      publish(state);
    }).catch((reason: unknown) => {
      if (!current()) return;
      const status = reason && typeof reason === "object" && "status" in reason ? reason.status : undefined;
      state = { key, phase: "error", hasData: state.hasData,
        ...(typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? { httpStatus: status } : {}) };
      publish(state);
    }).finally(() => { if (request === generation) active = undefined; });
    active = { key, controller, promise };
    return promise;
  }

  return { load, cancel };
}

/** 请求尚未进入 effect 时也不短暂展示旧项目或真实空态。 */
export function directoryStateForKey(state: DirectoryLoadState, key: string): DirectoryLoadState {
  return state.key === key ? state : { key, phase: "loading", hasData: false };
}
