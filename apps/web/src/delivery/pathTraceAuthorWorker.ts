import { PathTraceAuthorSession } from "./pathTraceAuthorSession";
import { pathTraceAuthorPreview } from "./pathTraceAuthorPreview";
import type { PathTraceAuthorWorkerInput, PathTraceAuthorWorkerOutput } from "./pathTraceAuthorWorkerTypes";
const worker = self as unknown as { onmessage: ((event: MessageEvent<PathTraceAuthorWorkerInput>) => void) | null;
  postMessage(value: PathTraceAuthorWorkerOutput, transfer?: Transferable[]): void };
let session: PathTraceAuthorSession | undefined, abort: AbortController | undefined, lastProgress = 0;
const yieldControl = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function progress(done: boolean): void {
  if (!session || (!done && performance.now() - lastProgress < 250)) return;
  lastProgress = performance.now();
  const image = pathTraceAuthorPreview(session.render.image());
  worker.postMessage({ kind: "progress", image, done, samples: session.render.session.sampleCount,
    noise: session.render.maxRelativeStandardError, converged: session.render.converged }, [image.data.buffer]);
}
worker.onmessage = event => {
  const command = event.data;
  if (command.kind === "cancel") { abort?.abort(); session?.cancel(); session?.dispose(); session = undefined; return; }
  if (command.kind === "export") {
    try {
      if (!session) throw new Error("物理出图会话已取消。");
      const output = session.export(command.preview, command.sourceHash);
      worker.postMessage({ kind: "exported", output }, [output.bytes.buffer as ArrayBuffer]);
    } catch (error) { worker.postMessage({ kind: "failed", message: error instanceof Error ? error.message : String(error) }); }
    return;
  }
  abort?.abort(); session?.dispose();
  const controller = new AbortController(); abort = controller;
  try { session = new PathTraceAuthorSession(command.prepared); }
  catch (error) { worker.postMessage({ kind: "failed", message: error instanceof Error ? error.message : String(error) }); return; }
  void session.accumulate(controller.signal, yieldControl, () => progress(false)).then(() => {
    if (!controller.signal.aborted) progress(true);
  }).catch(error => { if (!controller.signal.aborted) worker.postMessage({ kind: "failed", message: error instanceof Error ? error.message : String(error) }); });
};
