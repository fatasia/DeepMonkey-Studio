import { describe, expect, it, vi } from "vitest";
import type { GltfEncodedImage } from "@bim-studio/deep-engine/gltf";
import { createImageWorkerDecoder, type ImageWorkerHost } from "./imageWorkerDecoder";
import { capImageDimension } from "./textureBudget";

class FakeWorker {
  onmessage?: (event: MessageEvent) => void;
  onerror?: (event: ErrorEvent) => void;
  onmessageerror?: () => void;
  terminate = vi.fn();
  sent: { message: { id: number; image?: GltfEncodedImage; cap?: number; cancel?: boolean }; transfer: Transferable[] }[] = [];
  postMessage(message: FakeWorker["sent"][number]["message"], transfer: Transferable[] = []) {
    const cloned = structuredClone(message, { transfer });
    this.sent.push({ message: cloned, transfer });
  }
  reply(id: number) { this.onmessage?.({ data: { id, image: { width: 1, height: 1, data: new Uint8Array([1, 2, 3, 255]) } } } as MessageEvent); }
}
const encoded = (): GltfEncodedImage => ({ id: "shared-glb", imageIndex: 0, mimeType: "image/png", data: new Uint8Array([7, 8, 9, 10]).subarray(1, 3) });

describe("image worker scheduling", () => {
  it("lazily transfers an encoded slice without detaching its owning GLB and preserves returned RGBA", async () => {
    const worker = new FakeWorker(), factory = vi.fn(() => worker as unknown as ImageWorkerHost);
    const decoder = createImageWorkerDecoder(factory), source = encoded();
    expect(factory).not.toHaveBeenCalled();
    const pending = decoder.decode(source);
    expect(source.data.buffer.byteLength).toBe(4);
    expect([...source.data]).toEqual([8, 9]);
    expect([...worker.sent[0]!.message.image!.data]).toEqual([8, 9]);
    worker.reply(worker.sent[0]!.message.id);
    expect([...(await pending).data]).toEqual([1, 2, 3, 255]);
  });

  it("sends the existing budget cap into the same worker instead of decoding first on the caller", async () => {
    const worker = new FakeWorker(), decoder = capImageDimension(createImageWorkerDecoder(() => worker as unknown as ImageWorkerHost), 512);
    const pending = decoder.decode(encoded());
    expect(worker.sent[0]!.message.cap).toBe(512);
    worker.reply(worker.sent[0]!.message.id); await pending;
  });

  it("cancels immediately and terminates orphan work; a later decode gets a fresh worker", async () => {
    const workers = [new FakeWorker(), new FakeWorker()]; let cursor = 0;
    const factory = vi.fn(() => workers[cursor++] as unknown as ImageWorkerHost);
    const decoder = createImageWorkerDecoder(factory), controller = new AbortController();
    const first = decoder.decode(encoded(), controller.signal), reason = new Error("cancelled");
    const rejected = expect(first).rejects.toBe(reason);
    controller.abort(reason); await rejected;
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    const second = decoder.decode(encoded());
    workers[1]!.reply(workers[1]!.sent[0]!.message.id); await second;
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
