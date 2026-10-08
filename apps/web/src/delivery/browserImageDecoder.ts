import { createImageWorkerDecoder, type CappedImageDecoder, type ImageWorkerHost } from "./imageWorkerDecoder";
import { inProcessImageDecoder } from "./inProcessImageDecoder";

export const browserImageDecoder: CappedImageDecoder = typeof document !== "undefined" && typeof Worker !== "undefined"
  ? createImageWorkerDecoder(() => new Worker(new URL("./browserImageDecoder.worker.ts", import.meta.url), { type: "module" }) as unknown as ImageWorkerHost)
  : inProcessImageDecoder;
