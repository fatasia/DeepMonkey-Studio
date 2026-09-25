import type { RendererBackend } from "./viewerTypes";

interface FramePresentation {
  readonly authorBackend: RendererBackend;
  readonly presentationBackend: RendererBackend;
  readonly xrActive: boolean;
  readonly offscreenFrame: boolean;
  readonly listeners: ReadonlySet<() => void>;
  readonly drawAuthor: () => void;
  readonly updateAuthorMatrices: () => void;
  readonly updateAuthorLods?: () => void;
  /**
   * WebGPU 呈现消费独立 RenderPacket(authorRenderPacket 编译成功)时为 true。
   * 此时几何、材质、层级与 LOD 全部来自包,每帧对隐藏 Three 场景做全量
   * updateMatrixWorld/LOD 遍历纯属重复工作,可跳过;legacy 投影路径必须保持 false。
   */
  readonly authorPacketIndependent?: boolean;
}

/** Author simulation runs before this step; exactly one scene renderer presents its result. */
export function presentViewerFrame(frame: FramePresentation): void {
  const external = frame.presentationBackend !== frame.authorBackend && frame.listeners.size > 0
    && !frame.xrActive && !frame.offscreenFrame;
  // WebGPU in legacy projection mode still reads author world matrices/LOD.
  // WASM and the independent-packet WebGPU path consume their compiled packet
  // plus camera only; traversing the hidden Three scene on every input frame is
  // both redundant and a dependency/performance regression.
  if (external) {
    if (frame.presentationBackend === "webgpu" && !frame.authorPacketIndependent) {
      frame.updateAuthorMatrices();
      frame.updateAuthorLods?.();
    }
  } else frame.drawAuthor();
  // Notify even when author rendering is bypassed: Deep still consumes animation and camera changes.
  for (const listener of frame.listeners) listener();
}
