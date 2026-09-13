import { describe, expect, it, vi } from "vitest";
import { createBasisKtx2Transcoder, type BasisKtx2Module } from "./basisKtx2Transcoder.js";
import type { Ktx2TranscodeRequest } from "./ktx2Transcode.js";

interface FixtureOptions {
  readonly valid?: boolean;
  readonly profile?: "uastc" | "etc1s" | "hdr";
  readonly alpha?: boolean;
  readonly layers?: number;
  readonly faces?: number;
  readonly started?: boolean;
  readonly failLevel?: number;
  readonly levels?: readonly { readonly width: number; readonly height: number; readonly bytes: number }[];
}

function fixture(options: FixtureOptions = {}) {
  const levels = options.levels ?? [{ width: 4, height: 4, bytes: 64 }];
  const calls: { close: number; delete: number; targets: number[]; inputs: number[][] } = {
    close: 0, delete: 0, targets: [], inputs: [],
  };
  const initializeBasis = vi.fn();
  class KTX2File {
    constructor(data: Uint8Array) { calls.inputs.push([...data]); }
    isValid() { return options.valid ?? true; }
    isUASTC() { return (options.profile ?? "uastc") === "uastc"; }
    isETC1S() { return options.profile === "etc1s"; }
    isHDR() { return options.profile === "hdr"; }
    getWidth() { return levels[0]!.width; }
    getHeight() { return levels[0]!.height; }
    getLayers() { return options.layers ?? 1; }
    getLevels() { return levels.length; }
    getFaces() { return options.faces ?? 1; }
    getHasAlpha() { return options.alpha ?? false; }
    startTranscoding() { return options.started ?? true; }
    getImageLevelInfo(level: number) {
      const value = levels[level]!;
      return { origWidth: value.width, origHeight: value.height };
    }
    getImageTranscodedSizeInBytes(level: number, _layer: number, _face: number, target: number) {
      calls.targets.push(target);
      return levels[level]!.bytes;
    }
    transcodeImage(output: Uint8Array, level: number, _layer: number, _face: number, target: number) {
      if (level === options.failLevel) return false;
      output.fill(target + level);
      return true;
    }
    close() { calls.close++; }
    delete() { calls.delete++; }
  }
  return { module: { initializeBasis, KTX2File } satisfies BasisKtx2Module, calls, initializeBasis };
}

const data = (): Uint8Array<ArrayBuffer> => new Uint8Array(12).fill(0xab);
const request = (changes: Partial<Ktx2TranscodeRequest> = {}): Ktx2TranscodeRequest => ({
  target: "rgba8", sourceProfile: "unknown", hasAlpha: false, colorSpace: "linear", ...changes,
});

describe("Basis KTX2 adapter", () => {
  it("initializes one module once and transcodes an owned complete mip chain", async () => {
    const f = fixture({ profile: "etc1s", levels: [
      { width: 4, height: 4, bytes: 64 }, { width: 2, height: 2, bytes: 16 }, { width: 1, height: 1, bytes: 4 },
    ] });
    const first = createBasisKtx2Transcoder(f.module), second = createBasisKtx2Transcoder(f.module);
    expect(f.initializeBasis).toHaveBeenCalledTimes(1);
    const result = await first.transcode(data(), request());
    expect(result.target).toBe("rgba8");
    expect(result.levels.map(level => [level.width, level.height, level.data.byteLength])).toEqual([
      [4, 4, 64], [2, 2, 16], [1, 1, 4],
    ]);
    expect(result.levels[0]!.data).toEqual(new Uint8Array(64).fill(13));
    await second.transcode(data(), request({ sourceProfile: "etc1s" }));
    expect(f.initializeBasis).toHaveBeenCalledTimes(1);
    expect(f.calls).toMatchObject({ close: 2, delete: 2, targets: [13, 13, 13, 13, 13, 13] });
  });

  it("maps every engine target to the official Basis transcoder enum", async () => {
    const expectations = [["bc1-rgba", 2], ["bc7-rgba", 7], ["etc2-rgba8", 1], ["astc-4x4-rgba", 10], ["rgba8", 13]] as const;
    for (const [target, code] of expectations) {
      const f = fixture({ profile: target === "astc-4x4-rgba" ? "uastc" : "etc1s" });
      const transcoder = createBasisKtx2Transcoder(f.module);
      const result = await transcoder.transcode(data(), request({ target, sourceProfile: target === "astc-4x4-rgba" ? "uastc" : "unknown" }));
      expect(f.calls.targets).toEqual([code]);
      expect(result.levels[0]!.data[0]).toBe(code);
    }
  });

  it("fails closed for profile, alpha, HDR and non-2D mismatches", async () => {
    const alpha = fixture({ alpha: true });
    await expect(createBasisKtx2Transcoder(alpha.module).transcode(data(), request({ target: "bc1-rgba", hasAlpha: true })))
      .rejects.toThrow("BC1");
    const mismatch = fixture({ profile: "etc1s" });
    await expect(createBasisKtx2Transcoder(mismatch.module).transcode(data(), request({ sourceProfile: "uastc" })))
      .rejects.toThrow("profile");
    const hdr = fixture({ profile: "hdr" });
    await expect(createBasisKtx2Transcoder(hdr.module).transcode(data(), request())).rejects.toThrow("HDR");
    const array = fixture({ layers: 2 });
    await expect(createBasisKtx2Transcoder(array.module).transcode(data(), request())).rejects.toThrow("arrays");
    for (const f of [alpha, mismatch, hdr, array]) expect(f.calls).toMatchObject({ close: 1, delete: 1 });
  });

  it("releases WASM objects after invalid input, start failure, mip failure and budget failure", async () => {
    const cases = [
      { value: fixture({ valid: false }), error: "Invalid or unsupported" },
      { value: fixture({ started: false }), error: "failed to start" },
      { value: fixture({ failLevel: 0 }), error: "mip 0" },
      { value: fixture({ levels: [{ width: 4, height: 4, bytes: 65 }] }), error: "byte length", maxOutputBytes: 64 },
    ];
    for (const item of cases) {
      const transcoder = createBasisKtx2Transcoder(item.value.module,
        item.maxOutputBytes === undefined ? {} : { maxOutputBytes: item.maxOutputBytes });
      await expect(transcoder.transcode(data(), request())).rejects.toThrow(item.error);
      expect(item.value.calls).toMatchObject({ close: 1, delete: 1 });
    }
  });

  it("honors cancellation before work and between mip levels", async () => {
    const pre = fixture(), already = new AbortController(); already.abort(new DOMException("stop", "AbortError"));
    await expect(createBasisKtx2Transcoder(pre.module).transcode(data(), request(), already.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(pre.calls.inputs).toHaveLength(0);

    const during = fixture({ levels: [{ width: 4, height: 4, bytes: 64 }, { width: 2, height: 2, bytes: 16 }] });
    const controller = new AbortController();
    const Original = during.module.KTX2File;
    class AbortingFile extends Original {
      override transcodeImage(output: Uint8Array, level: number, layer: number, face: number, target: number) {
        const result = super.transcodeImage(output, level, layer, face, target);
        controller.abort(new DOMException("stop", "AbortError"));
        return result;
      }
    }
    const module = { initializeBasis: during.module.initializeBasis, KTX2File: AbortingFile } satisfies BasisKtx2Module;
    await expect(createBasisKtx2Transcoder(module).transcode(data(), request(), controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(during.calls).toMatchObject({ close: 1, delete: 1, targets: [13] });
  });
});
