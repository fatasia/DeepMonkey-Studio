import { expect, it, vi } from "vitest";
import type { DeepWebGpuBackend } from "@bim-studio/deep-engine/three-bridge";
import { trimInactiveDeepCandidate } from "./trimInactiveDeepCandidate";
import { STUDIO_DEEP_INACTIVE_MAX_BYTES } from "./StudioDeepInactiveCandidate";

it("trims only oversized hidden scenes and reports measured remaining GPU memory", () => {
  const evict = vi.fn(() => true), release = vi.fn();
  const backend = { evictSceneResources: evict, runtime: { releaseIdleResources: release,
    session: { resourceMemory: { estimatedBytes: 64, unknownResources: 0 } } } } as unknown as DeepWebGpuBackend;
  const candidate = { backend, sceneResourcesEvicted: false };
  expect(trimInactiveDeepCandidate(candidate, 100)).toBe(100); expect(evict).not.toHaveBeenCalled();
  expect(trimInactiveDeepCandidate(candidate, STUDIO_DEEP_INACTIVE_MAX_BYTES + 1)).toBe(64);
  expect(candidate.sceneResourcesEvicted).toBe(true); expect(release).toHaveBeenCalledOnce();
  expect(trimInactiveDeepCandidate(candidate, NaN)).toBeNaN(); expect(evict).toHaveBeenCalledOnce();
});
