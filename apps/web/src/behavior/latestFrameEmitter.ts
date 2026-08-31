export type FrameRequester = (callback: FrameRequestCallback) => number;

/**
 * 合并同一渲染帧内的频繁状态，但始终把最新值交给 React。
 * 运行时状态可能在一帧内从“初始化”连续变为“运行”或“错误”，不能丢弃后者。
 */
export function createLatestFrameEmitter<T>(
  publish: (value: T) => void,
  requestFrame: FrameRequester = window.requestAnimationFrame.bind(window),
): (value: T) => void {
  let scheduled = false;
  let latest: T | undefined;

  return (value) => {
    latest = value;
    if (scheduled) return;
    scheduled = true;
    requestFrame(() => {
      scheduled = false;
      const pending = latest;
      latest = undefined;
      if (pending !== undefined) publish(pending);
    });
  };
}
