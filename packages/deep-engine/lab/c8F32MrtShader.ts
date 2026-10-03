import { sceneShader } from "../src/webgpu/pbrShader.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { observeDeepFragment } from "./c8FragmentObservablesShader.js";

export type F32WitnessMode = "single" | "multi" | "full";
export const F32_WITNESS_ENTRY = "deepC8F32FragmentMainColor";
const single = "  var color = brdfWithDielectricF0(n, view, l, base, metal, rough, dielectric) * frame.sunColor.rgb * frame.sunColor.w * visibility;";
const multi = "  color += deepDirectMultiscatteringFromView(n, l, base, metal, rough, dielectric, directDfg)\n    * frame.sunColor.rgb * frame.sunColor.w * visibility;";
const full = "  return select(color, deepApplySceneFog(select(color, baseInput, flag(materialFlags, 64u)), world, materialFlags), applyFog);";
/** Captures an actual shade value before attachment conversion; the original color output survives. */
export function observeDeepF32Mrt(mode: F32WitnessMode, source = sceneShader) {
  if (!["single", "multi", "full"].includes(mode)) throw Error("Unknown F32 witness mode");
  const guarded = observeDeepFragment("single", source);
  const start = source.indexOf("fn shade("), end = source.indexOf("\n}\nfn clipUv", start) + 2;
  const shade = source.slice(start, end);
  const entries = [...source.matchAll(/@fragment fn fragmentMainColor\([^]*?\n\}/g)];
  const entry = entries[0]?.[0];
  if (entries.length !== 1 || !entry || [single, multi, full].some(seam => shade.split(seam).length !== 2)) throw Error("F32 witness canonical seam drifted");
  const output = "return vec4f(color, coverage(v.emissiveAlpha.w, v.material));";
  if (entry.split(output).length !== 2) throw Error("F32 witness color output seam drifted");
  const observedShade = mode === "single" ? shade.replace(single, `${single}\n  deepC8F32Witness = color;`)
    : mode === "multi" ? shade.replace(multi, `${multi.replace("color +=", "let deepC8Multi =")}\n  color += deepC8Multi;\n  deepC8F32Witness = deepC8Multi;`)
      : shade.replace(full, `${full.replace("return", "let deepC8Full =")}\n  deepC8F32Witness = deepC8Full;\n  return deepC8Full;`);
  const observed = source.slice(0, start) + observedShade + source.slice(end);
  const mrtEntry = entry.replace("fn fragmentMainColor", `fn ${F32_WITNESS_ENTRY}`)
    .replace("-> @location(0) vec4f", "-> DeepC8F32Output")
    .replace(output, "var out: DeepC8F32Output;\n  out.color = vec4f(color, coverage(v.emissiveAlpha.w, v.material));\n  out.witness = vec4f(deepC8F32Witness, out.color.a);\n  return out;");
  const code = `// C8 isolated same-pass F32 witness\nvar<private> deepC8F32Witness: vec3f;\n${observed}\nstruct DeepC8F32Output { @location(0) color: vec4f, @location(1) witness: vec4f };\n${mrtEntry}`;
  return { code, originalHash: guarded.originalHash, instrumentedHash: sha256Utf8(code), mode };
}

/** Only the audited canonical pipeline may write the added attachment. */
export function f32WitnessPipeline(descriptor: GPURenderPipelineDescriptor, modules: WeakSet<GPUShaderModule>): GPURenderPipelineDescriptor {
  const targets = descriptor.fragment ? Array.from(descriptor.fragment.targets) : [];
  if (descriptor.label !== "Deep forward PBR plain/depth/ccw" || descriptor.vertex.entryPoint !== "vertexMain"
    || descriptor.fragment?.entryPoint !== "fragmentMainColor" || descriptor.vertex.module !== descriptor.fragment.module
    || !modules.has(descriptor.vertex.module) || targets.length !== 1 || targets[0]?.format !== "rgba16float"
    || targets[0]?.blend || (targets[0]?.writeMask !== undefined && targets[0].writeMask !== 15)
    || (descriptor.multisample?.count ?? 1) !== 1 || descriptor.multisample?.alphaToCoverageEnabled
    || (descriptor.multisample?.mask !== undefined && descriptor.multisample.mask !== 0xffffffff)
    || descriptor.primitive?.topology !== "triangle-list" || descriptor.primitive.cullMode !== "back" || descriptor.primitive.frontFace !== "ccw"
    || descriptor.depthStencil?.format !== "depth32float" || descriptor.depthStencil.depthWriteEnabled !== true || descriptor.depthStencil.depthCompare !== "less") {
    throw Error("F32 witness requires canonical plain/depth/ccw sample1 pipeline");
  }
  return { ...descriptor, fragment: { ...descriptor.fragment, entryPoint: F32_WITNESS_ENTRY, targets: [...targets, { format: "rgba32float" }] } };
}
