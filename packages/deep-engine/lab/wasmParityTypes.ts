/** Wasm 桥黄金样例对等验收探针的报告形状(浏览器与 Node driver 共用)。 */

export interface WasmParityCamera {
  position: readonly [number, number, number];
  target: readonly [number, number, number];
  verticalFovDegrees: number;
  near: number;
  far: number;
  focal: number;
}

export interface WasmParityReport {
  schema: "wasm-parity-probe.v1";
  startedAt: string;
  instances: number;
  orbitDegrees: number;
  asset: "FactoryMachine" | "procedural";
  fixture: {
    id: string;
    assetIdentity: { sha256: string; sourceSha256: string } | null;
    counts: { instances: number; geometries: number; materials: number; textures: number };
    triangles: number;
    camera: WasmParityCamera;
    view: { width: number; height: number };
  } | null;
  package: {
    sha256: string;
    byteLength: number;
    packetCounts: { instances: number; geometries: number; materials: number; textures: number } | null;
    documentKeys: string[];
  } | null;
  webgpu: {
    drawCalls: number;
    triangles: number;
    capture: { width: number; height: number; sha256: string;
      meanLuminance: number; geometryDetailFraction: number };
    repeatCapture: { sha256: string; meanLuminance: number; identical: boolean };
    errors: readonly string[];
  } | null;
  wasm: {
    handle: number;
    readyGeneration: number;
    failureMessage: string | null;
    timingsMs: { moduleLoad: number; rendererReady: number };
  } | null;
  webgpuError: string | null;
  wasmError: string | null;
  fatal?: string;
  consoleErrors: string[];
  wallMs?: number;
  startedAtPerformance?: number;
}
