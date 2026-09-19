import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";

// R6-2 基线驱动(用户 2026-09-19 立卡):构造 BIM 型万级实例运行包,交给
// Native `--smoke-telemetry` 采集 CPU 帧准备分段(Acquire/SceneResources/
// Shadow/Opaque/Transparent/Deep2d/Postprocess/SubmitPresent)。测量主体
// 由 Native 遥测承担;本脚本只负责生成确定性场景与落盘证据。

const repo = resolve(import.meta.dirname, "..", "..");
const requireWeb = createRequire(resolve(repo, "apps/web/package.json"));
const outDir = resolve(repo, "test-output/r6-2-cpu-prepare-20260919-r1");
await mkdir(outDir, { recursive: true });

const entry = resolve(outDir, "gen-entry.ts");
await writeFile(entry, `export { compileSceneRuntimePackage, serializeDeepRuntimePackage } from ${JSON.stringify(resolve(repo, "apps/web/src/delivery/compileSceneRuntimePackage.ts").replaceAll("\\", "/"))};
`);
const { build } = createRequire(resolve(repo, "apps/web/package.json"))("esbuild");
const compiledModule = resolve(outDir, "gen-compiler.mjs");
await build({ entryPoints: [entry], outfile: compiledModule, bundle: true, platform: "node", format: "esm", conditions: ["development"], logLevel: "error" });
const compiler = await import(`file://${compiledModule.replaceAll("\\", "/")}`);

const INSTANCE_TARGET = Number(process.env.R62_INSTANCES ?? 5000);
const kinds = ["box", "cylinder"] as const;
const primitives = Array.from({ length: INSTANCE_TARGET }, (_, index) => {
  const kind = kinds[index % 2];
  const grid = Math.ceil(Math.sqrt(INSTANCE_TARGET));
  const gx = index % grid;
  const gz = Math.floor(index / grid);
  const angle = (index % 97) * 0.0649;
  return {
    modelId: `m${index}`,
    name: `构件-${index}`,
    kind,
    color: index % 3 === 0 ? "#9aa7b0" : index % 3 === 1 ? "#7f8c99" : "#b0a79a",
    visible: true,
    opacity: 1,
    transform: {
      position: { x: (gx - grid / 2) * 2.2, y: index % 7 === 0 ? 1.5 : 0.4, z: (gz - grid / 2) * 2.2 },
      rotation: { x: 0, y: angle, z: 0 },
      scale: { x: 1 + (index % 5) * 0.1, y: 1 + (index % 3) * 0.2, z: 1 },
    },
  };
});

const snapshot = {
  schemaVersion: 1,
  id: "r62-cpu-prepare",
  projectId: "r62",
  name: "R6-2 CPU prepare baseline",
  primitives,
  models: [],
  measurements: [],
  camera: { mode: "orbit", position: { x: 0, y: 220, z: 340 }, target: { x: 0, y: 0, z: 0 } },
  environment: { skybox: "none", gridVisible: false, backgroundColor: "#172126" },
  createdAt: "2026-09-19T00:00:00Z",
  updatedAt: "2026-09-19T00:00:00Z",
};

const compiled = await compiler.compileSceneRuntimePackage(snapshot, {
  packageId: "scene.r62-cpu-prepare",
  packageVersion: "1.0.0",
  loadModel: async () => { throw new Error("primitives only"); },
});
const packageFile = resolve(outDir, "r62-bim-scene.runtime.json");
await writeFile(packageFile, compiled.packageJson);
// --smoke-telemetry 吃 v6 RenderPacket:从运行包资源节提取 scene.main 落盘。
const parsedPackage = JSON.parse(compiled.packageJson);
const packetEntry = parsedPackage.entrypoints?.renderPacket ?? parsedPackage.entrypoints?.packet;
const packetValue = packetEntry
  ? parsedPackage.payloads[packetEntry]
  : parsedPackage.resources?.find((r: { kind: string }) => r.kind === "render-packet")?.value;
if (!packetValue) throw new Error("render packet not found in compiled package");
const packetFile = resolve(outDir, "r62-bim-scene.packet.json");
await writeFile(packetFile, JSON.stringify(packetValue));
await writeFile(
  resolve(outDir, "gen-manifest.json"),
  `${JSON.stringify({ instances: INSTANCE_TARGET, packageShaNote: "see rvt discipline: record hash at measurement time" }, null, 2)}\n`,
);
console.log(JSON.stringify({ packageFile, packetFile, instances: INSTANCE_TARGET, bytes: compiled.packageJson.length }));
