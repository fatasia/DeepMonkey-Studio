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
}

/** Author simulation runs before this step; exactly one scene renderer presents its result. */
export function presentViewerFrame(frame: FramePresentation): void {
  const external = frame.presentationBackend !== frame.authorBackend && frame.listeners.size > 0
    && !frame.xrActive && !frame.offscreenFrame;
  if (external) { frame.updateAuthorMatrices(); frame.updateAuthorLods?.(); }
  else frame.drawAuthor();
  // Notify even when author rendering is bypassed: Deep still consumes animation and camera changes.
  for (const listener of frame.listeners) listener();
}
