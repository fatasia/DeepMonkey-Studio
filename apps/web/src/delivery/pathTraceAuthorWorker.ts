import { PathTraceAuthorBandHost, pathTraceAuthorTransferables } from "./pathTraceAuthorBandHost";
import type { PathTraceAuthorWorkerInput, PathTraceAuthorWorkerOutput } from "./pathTraceAuthorWorkerTypes";

const worker = self as unknown as { onmessage: ((event: MessageEvent<PathTraceAuthorWorkerInput>) => void) | null;
  postMessage(value: PathTraceAuthorWorkerOutput, transfer?: Transferable[]): void };
const host = new PathTraceAuthorBandHost();
worker.onmessage = event => {
  const output = host.handle(event.data);
  if (output) worker.postMessage(output, pathTraceAuthorTransferables(output));
};
