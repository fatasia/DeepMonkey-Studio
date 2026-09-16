import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { PbrPostProcessChain, DEFAULT_PBR_BLOOM_OPTIONS, type PbrPostProcessInput } from "./pbrPostProcessChain.js";
import { resolvePbrPostProcessOverrides, validatePbrPostProcessOverrides } from "./pbrPostProcessOverrides.js";

const mocks = vi.hoisted(() => ({ create: vi.fn(), author: vi.fn(), legacy: vi.fn(),
  disposeAuthor: vi.fn(), disposeLegacy: vi.fn() }));
vi.mock("../postprocess/authorBloom.js", () => ({ AuthorBloomPass: class {
  constructor() { mocks.create(); }
  encode = mocks.author; dispose = mocks.disposeAuthor;
} }));
vi.mock("../postprocess/bloom.js", () => ({ BloomPass: class {
  encode = mocks.legacy; dispose = mocks.disposeLegacy;
} }));

const color = {} as GPUTexture, authorColor = {} as GPUTexture, legacyColor = {} as GPUTexture;
const input = { encoder: {}, targets: {}, revision: 3, extent: 1, cameraCut: false,
  currentJitter: [0, 0], previousJitter: [0, 0] } as PbrPostProcessInput;
function chain(bloom = true) { return new PbrPostProcessChain({} as DeviceSession,
  { ambientOcclusion: false, temporalAa: false, occlusionCulling: false, bloom }); }
const enabled = (strength = 1, threshold = 0.9) => ({ ...input, postProcess: { bloom: true, authorBloom: { strength, threshold } } });
beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.author.mockReturnValue({ texture: authorColor, passCount: 12 });
  mocks.legacy.mockReturnValue({ texture: legacyColor, passCount: 20 });
});

describe("author bloom frame profile", () => {
  it("selects author bloom only for explicit profiles, retaining legacy and disabled behavior", () => {
    const target = chain();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(target.encodeFinal(input, color)).toEqual({ color: legacyColor, passCount: 20 });
    expect(mocks.legacy).toHaveBeenLastCalledWith(input.encoder,
      { color, revision: 3, colorEncoding: "linear-hdr" }, DEFAULT_PBR_BLOOM_OPTIONS);
    expect(target.encodeFinal(enabled(), color)).toEqual({ color: authorColor, passCount: 12 });
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(target.encodeFinal({ ...input, postProcess: { bloom: false } }, color)).toEqual({ color, passCount: 0 });
    target.encodeFinal(input, color);
    expect(mocks.author).toHaveBeenCalledOnce(); expect(mocks.legacy).toHaveBeenCalledTimes(2);
    target.dispose(); target.dispose();
    expect(mocks.disposeAuthor).toHaveBeenCalledOnce(); expect(mocks.disposeLegacy).toHaveBeenCalledOnce();
  });
  it("reuses one pass while forwarding changed strength/threshold as an immutable snapshot", () => {
    const target = chain(), request = enabled();
    target.encodeFinal(request, color);
    request.postProcess.authorBloom.strength = 3;
    const original = mocks.author.mock.calls[0]![2];
    expect(original).toEqual({ strength: 1, threshold: 0.9 }); expect(Object.isFrozen(original)).toBe(true);
    target.encodeFinal(enabled(0, 1), color);
    expect(mocks.author.mock.calls.at(-1)![2]).toEqual({ strength: 0, threshold: 1 });
    expect(mocks.create).toHaveBeenCalledOnce(); target.dispose();
  });
  it("rejects unallocated bloom and disabled profiles rather than silently dropping them", () => {
    const target = chain(false);
    expect(() => target.encodeFinal(enabled(), color)).toThrow("not allocated");
    expect(() => target.encodeFinal({ ...enabled(), postProcess: { authorBloom: { strength: 1, threshold: 0 } } }, color))
      .toThrow("requires enabled");
    expect(() => resolvePbrPostProcessOverrides({ bloom: false, authorBloom: { strength: 1, threshold: 0 } },
      { ambientOcclusion: false, bloom: true })).toThrow("requires enabled");
    expect(mocks.create).not.toHaveBeenCalled(); target.dispose();
  });
  it.each([undefined, null, [], {}, { strength: 1 }, { strength: "1", threshold: 0 },
    { strength: -1, threshold: 0 }, { strength: 3.1, threshold: 0 }, { strength: 1, threshold: 1.1 },
    { strength: Infinity, threshold: 0 }, { strength: 1, threshold: NaN }, { strength: 1, threshold: 0, radius: 0.5 }])
  ("rejects malformed profile %j", authorBloom => {
    expect(() => validatePbrPostProcessOverrides({ authorBloom } as never)).toThrow();
  });
  it("retries constructor failure and propagates encode failure without allocating another pass", () => {
    const target = chain();
    mocks.create.mockImplementationOnce(() => { throw new Error("construction failed"); });
    expect(() => target.encodeFinal(enabled(), color)).toThrow("construction failed");
    mocks.author.mockImplementationOnce(() => { throw new Error("allocation failed"); });
    expect(() => target.encodeFinal(enabled(), color)).toThrow("allocation failed");
    expect(target.encodeFinal(enabled(), color).color).toBe(authorColor);
    expect(mocks.create).toHaveBeenCalledTimes(2); target.dispose();
  });
  it("releases legacy resources despite author disposal failure and rejects work after disposal", () => {
    const target = chain(); target.encodeFinal(enabled(), color);
    mocks.disposeAuthor.mockImplementationOnce(() => { throw new Error("release failed"); });
    expect(() => target.dispose()).toThrow("Post-process disposal failed");
    expect(mocks.disposeLegacy).toHaveBeenCalledOnce();
    expect(() => target.encodeFinal(enabled(), color)).toThrow("disposed");
    expect(() => target.encodeOpaque(input)).toThrow("disposed");
    target.dispose(); expect(mocks.disposeAuthor).toHaveBeenCalledOnce();
  });
});
