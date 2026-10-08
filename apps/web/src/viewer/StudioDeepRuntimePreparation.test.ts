import { expect, it, vi } from "vitest";
import type { PbrRenderer } from "@bim-studio/deep-engine/webgpu";
import { StudioDeepRuntimePreparation } from "./StudioDeepRuntimePreparation";

function fixture() {
  const first = { dispose: vi.fn() }, replacement = { dispose: vi.fn() };
  let resolve!: (value: typeof first) => void;
  const pending = new Promise<typeof first>(done => { resolve = done; });
  const create = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(replacement);
  const controller = new AbortController(), canvas = {} as HTMLCanvasElement, gpu = {} as GPU;
  const owner = new StudioDeepRuntimePreparation({ create } as unknown as Pick<typeof PbrRenderer, "create">,
    canvas, gpu, controller.signal, { advancedMaterials: true });
  return { first, replacement, resolve, create, controller, canvas, gpu, owner };
}
it("starts before packet availability and transfers the runtime exactly once", async () => {
  const f = fixture();
  expect(f.create).toHaveBeenCalledTimes(1);
  f.resolve(f.first);
  expect(await f.owner.create(f.canvas, f.gpu, f.controller.signal, { advancedMaterials: true })).toBe(f.first);
  f.owner.dispose(); f.controller.abort();
  expect(f.first.dispose).not.toHaveBeenCalled();
  expect(f.create).toHaveBeenCalledTimes(1);
});
it("disposes a late GPU owner after cancellation", async () => {
  const f = fixture(); f.controller.abort(); f.owner.dispose(); f.resolve(f.first);
  await Promise.resolve(); await Promise.resolve();
  expect(f.first.dispose).toHaveBeenCalledTimes(1);
});
it("rebuilds when the actual material capability differs from the hint", async () => {
  const f = fixture();
  expect(await f.owner.create(f.canvas, f.gpu, f.controller.signal, {})).toBe(f.replacement);
  f.resolve(f.first); await Promise.resolve();
  expect(f.first.dispose).toHaveBeenCalledTimes(1);
  expect(f.create).toHaveBeenCalledTimes(2);
});
it("does not transfer an already cancelled runtime", async () => {
  const f = fixture();
  const taking = f.owner.create(f.canvas, f.gpu, f.controller.signal, { advancedMaterials: true });
  f.controller.abort(); f.resolve(f.first);
  await expect(taking).rejects.toThrow();
  expect(f.first.dispose).toHaveBeenCalledTimes(1);
});
