import { afterEach, expect, it, vi } from "vitest";
import { useRendererDiagnostics } from "./useRendererDiagnostics";
import { createRequestedStudioFrameCaptureSession, createStudioFrameReadbackListener,
  publishStudioFrameCaptureSession, readStudioFrameReadbacks, setStudioFrameCaptureRequested } from "./studioFrameCaptureDiagnostics";

const hook = vi.hoisted(() => ({ cursor: 0, effect: 0, states: [] as unknown[], deps: [] as unknown[][] }));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = hook.cursor++;
    if (index >= hook.states.length) hook.states[index] = typeof initial === "function" ? initial() : initial;
    return [hook.states[index], (next: unknown) => {
      hook.states[index] = typeof next === "function" ? next(hook.states[index]) : next;
    }];
  },
  useMemo: (read: () => unknown) => read(),
  useEffect: (run: () => void, deps: unknown[]) => {
    const index = hook.effect++, old = hook.deps[index];
    if (!old || deps.some((value, slot) => !Object.is(value, old[slot]))) { hook.deps[index] = deps; run(); }
  },
}));

afterEach(() => {
  setStudioFrameCaptureRequested(false); publishStudioFrameCaptureSession(undefined);
  hook.states = []; hook.deps = [];
});

it("closing diagnostics clears the actual hook's image references after the polling loop stops", () => {
  setStudioFrameCaptureRequested(true);
  const owner = createRequestedStudioFrameCaptureSession()!;
  publishStudioFrameCaptureSession(owner);
  createStudioFrameReadbackListener(owner)([{ frameId: "captured", resourceId: "present-color",
    width: 1, height: 1, format: "rgba8unorm", bytesPerRow: 4, bytes: new Uint8Array([1, 2, 3, 255]) }]);
  expect(readStudioFrameReadbacks()).toHaveLength(1);
  const onError = vi.fn();
  const renderClosed = () => {
    hook.cursor = 0; hook.effect = 0;
    return useRendererDiagnostics(undefined, false, true, onError);
  };
  renderClosed();
  expect(readStudioFrameReadbacks()).toEqual([]);
  expect(renderClosed().frameReadbacks).toEqual([]);
  expect(onError).not.toHaveBeenCalled();
});
