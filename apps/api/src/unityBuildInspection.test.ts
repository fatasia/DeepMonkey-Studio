import { describe, expect, it } from "vitest";
import { inspectUnityWebBuild, unityBuildDiagnostics } from "./unityBuildInspection.js";

const complete = (suffix: "" | ".br" | ".gz" | ".unityweb") => [
  { path: "Build/factory.loader.js", size: 10 },
  { path: `Build/factory.framework.js${suffix}`, size: 20 },
  { path: `Build/factory.wasm${suffix}`, size: 30 },
  { path: `Build/factory.data${suffix}`, size: 40 },
];

describe("Unity Web build inspection", () => {
  it("records Brotli runtime payload evidence", () => {
    expect(inspectUnityWebBuild(complete(".br"))).toMatchObject({
      compression: "brotli",
      runtimePayloadBytes: 100,
      wasmBytes: 30,
      dataBytes: 40,
      debugSymbols: false,
    });
  });

  it("rejects an archive that cannot boot a player", () => {
    expect(() => inspectUnityWebBuild([{ path: "index.html", size: 10 }])).toThrow("Loader、Framework、WASM、Data");
  });

  it("reports expensive browser-side decompression", () => {
    const profile = inspectUnityWebBuild(complete(".unityweb"));
    expect(unityBuildDiagnostics(profile)).toContain("Unity 使用浏览器端解压回退，会增加启动期 CPU 与内存开销");
  });
});
