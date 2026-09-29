// J2-B1 迁移证据(临时):迁移前后各跑一次,逐字节 diff 组合产物证明"换来源不改内容"。
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "vitest";
import { MATERIAL_DIELECTRIC_WGSL } from "../src/materialDielectric.js";
import { PBR_DIRECT_LIGHTING_WGSL } from "../src/webgpu/pbrDirectLightingWgsl.js";
import { FORWARD_PLUS_PBR_WGSL } from "../src/lighting/clusterLightingPbrWgsl.js";
import { EXTENDED_MATERIAL_EVALUATION_WGSL } from "../src/shader/materialEvaluateWgsl.js";
import { sceneShader } from "../src/webgpu/pbrShader.js";

const phase = process.env.J2B1_PHASE ?? "before";
const outDir = resolve(import.meta.dirname, "../../test-output/j2b1-wgsl-single-source", phase);

describe("J2-B1 composed product dump", () => {
  it("dumps composed WGSL products byte-exactly", () => {
    mkdirSync(outDir, { recursive: true });
    const products: Record<string, string> = {
      "materialDielectric.wgsl": MATERIAL_DIELECTRIC_WGSL,
      "pbrDirectLighting.wgsl": PBR_DIRECT_LIGHTING_WGSL,
      "forwardPlusPbr.wgsl": FORWARD_PLUS_PBR_WGSL,
      "extendedMaterialEvaluation.wgsl": EXTENDED_MATERIAL_EVALUATION_WGSL,
      "sceneShader.wgsl": sceneShader,
    };
    for (const [name, text] of Object.entries(products)) {
      writeFileSync(resolve(outDir, name), text, "utf8");
    }
    writeFileSync(resolve(outDir, "manifest.txt"),
      Object.entries(products).map(([name, text]) => `${name}\t${text.length} chars`).join("\n") + "\n", "utf8");
  });
});
