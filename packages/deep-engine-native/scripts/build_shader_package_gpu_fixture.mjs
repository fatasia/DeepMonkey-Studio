import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildDeepShaderPackage } from "../../deep-engine/dist/shaderPackage/index.js";

const source = /* wgsl */ `
struct VertexOutput { @builtin(position) position: vec4f }

fn probePosition(index: u32) -> vec4f {
  let positions = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(positions[index], 0.25, 1.0);
}

@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {
  return VertexOutput(probePosition(index));
}

@fragment fn fragmentMain() -> @location(0) vec4f {
  return vec4f(0.25, 0.5, 0.75, 1.0);
}

@vertex fn shadowMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  return probePosition(index);
}
`;

function module(code = source) {
  return { label: "Native package GPU probe", code };
}

const built = buildDeepShaderPackage({
  packageId: "deep.native.gpu-probe",
  packageVersion: "2.0.0",
  compilerVersion: "0.2.0",
  passes: [
    {
      techniqueId: "pbr",
      passId: "forward",
      kind: "forward",
      module: module(),
      entryPoints: { vertex: "vertexMain", fragment: "fragmentMain" },
      pipeline: {
        passVariantId: "forward-plain",
        attachmentProfileId: "forward-opaque",
        alphaMode: "OPAQUE",
        rasterMode: "double",
      },
    },
    {
      techniqueId: "pbr",
      passId: "shadow",
      kind: "shadow",
      module: module(),
      entryPoints: { vertex: "shadowMain", fragment: null },
      pipeline: {
        passVariantId: "shadow-solid",
        attachmentProfileId: "shadow",
        alphaMode: "OPAQUE",
        rasterMode: "double",
      },
    },
  ],
});

if (!built.success || !built.value) {
  throw new Error(built.diagnostics.map((entry) => entry.message).join("; "));
}
const output = fileURLToPath(new URL("../tests/fixtures/deep_shader_package_gpu_v2.json", import.meta.url));
await writeFile(output, `${JSON.stringify(built.value)}\n`, "utf8");
console.log(`wrote ${output} (${built.value.packageCacheKey})`);

const invalidSource = source.replace(
  "return vec4f(0.25, 0.5, 0.75, 1.0);",
  "return missingSymbol;",
);
const invalidBuilt = buildDeepShaderPackage({
  packageId: "deep.native.invalid-gpu-probe",
  packageVersion: "2.0.0",
  compilerVersion: "0.2.0",
  passes: [{
    techniqueId: "pbr",
    passId: "forward",
    kind: "forward",
    module: module(invalidSource),
    entryPoints: { vertex: "vertexMain", fragment: "fragmentMain" },
    pipeline: {
      passVariantId: "forward-plain",
      attachmentProfileId: "forward-opaque",
      alphaMode: "OPAQUE",
      rasterMode: "double",
    },
  }],
});
if (!invalidBuilt.success || !invalidBuilt.value) {
  throw new Error(invalidBuilt.diagnostics.map((entry) => entry.message).join("; "));
}
const invalidOutput = fileURLToPath(new URL("../tests/fixtures/deep_shader_package_invalid_wgsl_v2.json", import.meta.url));
await writeFile(invalidOutput, `${JSON.stringify(invalidBuilt.value)}\n`, "utf8");
console.log(`wrote ${invalidOutput} (${invalidBuilt.value.packageCacheKey})`);
