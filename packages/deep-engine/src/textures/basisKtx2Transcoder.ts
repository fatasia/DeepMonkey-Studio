import type {
  Ktx2SourceProfile,
  Ktx2TranscodeRequest,
  Ktx2TranscodeResult,
  Ktx2Transcoder,
} from "./ktx2Transcode.js";

export interface BasisImageLevelInfo {
  readonly origWidth: number;
  readonly origHeight: number;
}

export interface BasisKtx2File {
  isValid(): boolean;
  isUASTC(): boolean;
  isETC1S(): boolean;
  isHDR(): boolean;
  getWidth(): number;
  getHeight(): number;
  getLayers(): number;
  getLevels(): number;
  getFaces(): number;
  getHasAlpha(): boolean;
  startTranscoding(): boolean;
  getImageLevelInfo(level: number, layer: number, face: number): BasisImageLevelInfo;
  getImageTranscodedSizeInBytes(level: number, layer: number, face: number, target: number): number;
  transcodeImage(output: Uint8Array, level: number, layer: number, face: number, target: number,
    decodeFlags: number, channel0: number, channel1: number): boolean;
  close(): void;
  delete(): void;
}

export interface BasisKtx2Module {
  initializeBasis(): void;
  readonly KTX2File: new (data: Uint8Array) => BasisKtx2File;
}

export interface BasisKtx2TranscoderOptions {
  /** Caps allocations made inside the adapter before the outer texture boundary validates the result. */
  readonly maxOutputBytes?: number;
}

const TARGET = Object.freeze({
  "bc1-rgba": 2,
  "bc7-rgba": 7,
  "etc2-rgba8": 1,
  "astc-4x4-rgba": 10,
  rgba8: 13,
} as const);
const initializedModules = new WeakSet<object>();

function positiveInteger(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid Basis KTX2 ${name}.`);
  return value;
}

function sourceProfile(file: BasisKtx2File): Ktx2SourceProfile {
  if (file.isHDR()) throw new Error("HDR Basis KTX2 is not supported by the current 8-bit texture targets.");
  if (file.isUASTC()) return "uastc";
  if (file.isETC1S()) return "etc1s";
  throw new Error("Unknown Basis KTX2 source profile.");
}

function checkRequest(actualProfile: Ktx2SourceProfile, actualAlpha: boolean,
  request: Readonly<Ktx2TranscodeRequest>): void {
  if (!Object.prototype.hasOwnProperty.call(TARGET, request.target)) throw new Error("Unsupported Basis KTX2 transcode target.");
  if (typeof request.hasAlpha !== "boolean" || (request.colorSpace !== "srgb" && request.colorSpace !== "linear")) {
    throw new Error("Invalid Basis KTX2 transcode request.");
  }
  if (request.sourceProfile !== "unknown" && request.sourceProfile !== actualProfile) {
    throw new Error("Basis KTX2 source profile does not match its declaration.");
  }
  if (!request.hasAlpha && actualAlpha) throw new Error("Basis KTX2 alpha cannot be discarded by this request.");
  if (request.target === "bc1-rgba" && (request.hasAlpha || actualAlpha)) {
    throw new Error("BC1 cannot preserve Basis KTX2 alpha.");
  }
}

/**
 * Adapts the official Basis Universal module to the engine's host-neutral KTX2 boundary.
 * It accepts only 2D, one-layer, one-face assets; arrays, volume textures and cubemaps require distinct engine resources.
 */
export function createBasisKtx2Transcoder(module: BasisKtx2Module,
  options: BasisKtx2TranscoderOptions = {}): Ktx2Transcoder {
  if (!module || typeof module !== "object" || typeof module.initializeBasis !== "function"
    || typeof module.KTX2File !== "function") throw new Error("Invalid Basis KTX2 module.");
  if (!options || typeof options !== "object") throw new Error("Invalid Basis KTX2 transcoder options.");
  const maxOutputBytes = positiveInteger(options.maxOutputBytes ?? 128 * 1024 * 1024,
    128 * 1024 * 1024, "output byte limit");
  if (!initializedModules.has(module)) {
    module.initializeBasis();
    initializedModules.add(module);
  }

  return Object.freeze<Ktx2Transcoder>({
    async transcode(data, request, signal): Promise<Ktx2TranscodeResult> {
      signal?.throwIfAborted();
      if (!(data instanceof Uint8Array) || !(data.buffer instanceof ArrayBuffer) || data.byteLength < 12) {
        throw new Error("Basis KTX2 input requires owned container bytes.");
      }
      if (!request || typeof request !== "object") throw new Error("Invalid Basis KTX2 transcode request.");
      const file = new module.KTX2File(data);
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        try { file.close(); }
        finally { file.delete(); }
      };
      try {
        if (!file.isValid()) throw new Error("Invalid or unsupported Basis KTX2 container.");
        const profile = sourceProfile(file), actualAlpha = file.getHasAlpha();
        checkRequest(profile, actualAlpha, request);
        positiveInteger(file.getWidth(), 16_384, "width");
        positiveInteger(file.getHeight(), 16_384, "height");
        if ((file.getLayers() || 1) !== 1 || file.getFaces() !== 1) {
          throw new Error("Basis KTX2 arrays and cubemaps are not valid 2D textures.");
        }
        const levelCount = positiveInteger(file.getLevels(), 32, "mip count");
        if (!file.startTranscoding()) throw new Error("Basis KTX2 transcoder failed to start.");
        const target = TARGET[request.target], levels = [];
        let totalBytes = 0;
        for (let level = 0; level < levelCount; level++) {
          signal?.throwIfAborted();
          const info = file.getImageLevelInfo(level, 0, 0);
          if (!info || typeof info !== "object") throw new Error("Invalid Basis KTX2 mip metadata.");
          const width = positiveInteger(info.origWidth, 16_384, "mip width");
          const height = positiveInteger(info.origHeight, 16_384, "mip height");
          const byteLength = positiveInteger(file.getImageTranscodedSizeInBytes(level, 0, 0, target),
            maxOutputBytes, "mip byte length");
          totalBytes += byteLength;
          if (!Number.isSafeInteger(totalBytes) || totalBytes > maxOutputBytes) {
            throw new Error("Basis KTX2 output byte budget exceeded.");
          }
          const output = new Uint8Array(byteLength);
          if (!file.transcodeImage(output, level, 0, 0, target, 0, -1, -1)) {
            throw new Error(`Basis KTX2 mip ${level} transcode failed.`);
          }
          levels.push(Object.freeze({ width, height, data: output }));
        }
        signal?.throwIfAborted();
        return Object.freeze({ target: request.target, levels: Object.freeze(levels) });
      } finally {
        close();
      }
    },
  });
}
