import type { GltfEncodedImage } from "@bim-studio/deep-engine/gltf";
import { inProcessImageDecoder } from "./inProcessImageDecoder";
import { capImageDimension } from "./textureBudget";

const scope = globalThis as unknown as Pick<Worker, "onmessage" | "postMessage">;
const controllers = new Map<number, AbortController>();
scope.onmessage = async (event: MessageEvent<{ id: number; image?: GltfEncodedImage; cap?: number; cancel?: boolean }>) => {
  const { id, image, cap, cancel } = event.data;
  if (cancel) { controllers.get(id)?.abort(); return; }
  if (!image) return;
  const controller = new AbortController(); controllers.set(id, controller);
  try {
    const decoder = cap === undefined ? inProcessImageDecoder : capImageDimension(inProcessImageDecoder, cap);
    const decoded = await decoder.decode(image, controller.signal);
    controller.signal.throwIfAborted();
    scope.postMessage({ id, image: decoded }, [decoded.data.buffer as ArrayBuffer]);
  } catch (reason) {
    if (!controller.signal.aborted) scope.postMessage({ id, error: reason instanceof Error ? reason.message : String(reason) });
  } finally { controllers.delete(id); }
};
