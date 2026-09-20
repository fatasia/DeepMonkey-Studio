import { kernelIrSha256, kernelUsesSubgroupOps, validateKernel } from "./kernel.js";
import type { DcirKernel, DcirNode } from "./types.js";

/**
 * WGSL 后端：WebGPU compute 与 Native wgpu 消费同一文本。
 * 每个节点展开为一条 `let`，展开顺序 = IR 依赖序（确定性合同 §4.2）。
 */

const varName = (id: string): string => `n_${id}`;

function literal(node: Extract<DcirNode, { op: "literal" }>): string {
  if (node.type === "bool") return node.value ? "true" : "false";
  if (node.type === "u32") return `${node.value}u`;
  // ±Infinity 字面量（subgroup 吸收值）走 u32 bitcast：WGSL float 字面量不允许无穷
  // （shader-creation error），bitcast 是逐位精确且双端（Dawn/wgpu）一致的表达。
  if (node.value === Number.POSITIVE_INFINITY) return "bitcast<f32>(0x7f800000u)";
  if (node.value === Number.NEGATIVE_INFINITY) return "bitcast<f32>(0xff800000u)";
  const text = String(node.value);
  return text.includes(".") || text.includes("e") ? text : `${text}.0`;
}

function expression(node: DcirNode): string {
  switch (node.op) {
    case "literal": return literal(node);
    case "global-invocation-id": return "deepGlobalId.xy";
    case "kernel-uniform": return `deepUniforms.${node.uniform}`;
    case "loop-index": return `l_${node.loopId}`;
    case "iadd": case "isub": case "imul": case "idiv": {
      const [lhs, rhs] = node.inputs;
      const symbol = { iadd: "+", isub: "-", imul: "*", idiv: "/" }[node.op];
      return `${varName(lhs)} ${symbol} ${varName(rhs)}`;
    }
    case "imin": case "imax": {
      const [lhs, rhs] = node.inputs;
      return `${node.op === "imin" ? "min" : "max"}(${varName(lhs)}, ${varName(rhs)})`;
    }
    case "ieq": case "ult": {
      const [lhs, rhs] = node.inputs;
      return `(${varName(lhs)} ${node.op === "ieq" ? "==" : "<"} ${varName(rhs)})`;
    }
    case "make-vec2u": {
      const [x, y] = node.inputs;
      return `vec2u(${varName(x)}, ${varName(y)})`;
    }
    case "component": return `${varName(node.input)}.${node.component === 0 ? "x" : "y"}`;
    case "fmin": case "fmax": {
      const [lhs, rhs] = node.inputs;
      return `${node.op === "fmin" ? "min" : "max"}(${varName(lhs)}, ${varName(rhs)})`;
    }
    case "canonicalize-f32": {
      // 等价于 v+(+0.0) 的单次舍入折叠（-0→+0，其余位型不变）；select 形式防止编译器把
      // `x + 0.0` 代数化简回 x（真机实测 ANGLE 会折叠，导致 -0 存活）。
      const x = varName(node.input);
      return `select(${x}, 0.0, ${x} == 0.0)`;
    }
    case "select": {
      const [falseValue, trueValue, condition] = node.inputs;
      return `select(${varName(falseValue)}, ${varName(trueValue)}, ${varName(condition)})`;
    }
    case "texel-load": return `textureLoad(deepSource, vec2i(${varName(node.coords)}), 0).x`;
    case "buffer-load": {
      const value = `${varName(node.index)} >= arrayLength(&deep_${node.buffer}) ? 0${node.type === "u32" ? "u" : ".0"} : deep_${node.buffer}[${varName(node.index)}]`;
      // 越界回零：WebGPU 规范越界读返回 0，此处显式表达同一合同（WGSL 与 Native wgpu 同语义）。
      return value;
    }
    case "atomic-load": return `atomicLoad(&deep_${node.buffer}[${varName(node.index)}])`;
    case "buffer-store":
      // 语句化副作用在 emitKernelWgsl 的节点行后追加;此处求值为被存值(pass-through),
      // 保持"每节点一条 let"的确定性展开序。
      return varName(node.value);
    case "hash-rng":
      // PCG 整数哈希(设计合同 §2):纯 u32 移位/乘加/异或,双端逐位一致。
      return `deepPcg(${varName(node.seed)} ^ ${varName(node.salt)})`;
    case "subgroup-invocation-id":
      // subgroup 内 lane 序号（由入口 @builtin(subgroup_invocation_id) 参数注入）。
      return "deepSubgroupLane";
    case "subgroup-min": case "subgroup-max":
      // 整体 subgroup 归约（WGSL subgroups feature 内建）。uniformity 合同：节点全部以
      // 直线 let 展开、先于 guard return，subgroup 内所有 lane 必然同序执行（合同见
      // hiZReduceSubgroup.ts 头注释）。requires subgroups 由 emitKernelWgsl 入口声明。
      return `${node.op === "subgroup-min" ? "subgroupMin" : "subgroupMax"}(${varName(node.input)})`;
  }
  node satisfies never; // op 集合扩展时编译失败，强制补全两个后端
}

const wgslType: Readonly<Record<string, string>> = { u32: "u32", f32: "f32", vec2u: "vec2u", bool: "bool" };

export interface EmittedKernelWgsl {
  readonly code: string;
  readonly irSha256: string;
  /**
   * 内核依赖的可选 WGSL feature（当前只有 "subgroups"）。消费侧合同：device.features
   * 必须覆盖全部条目才可 createShaderModule；缺失时必须拒绝该 kernel（可探测拒绝），
   * 不允许把带 `requires` 的文本交给不支持的设备编译。
   */
  readonly features: readonly string[];
  readonly bindings: readonly Readonly<{
    binding: number;
    kind: "texture-input" | "texture-output" | "uniform" | "storage-buffer";
    name: string;
  }>[];
}

export function emitKernelWgsl(kernel: DcirKernel): EmittedKernelWgsl {
  const diagnostics = validateKernel(kernel);
  if (diagnostics.length > 0) {
    throw new Error(`Invalid DCIR kernel "${kernel.name}": ${diagnostics.map((d) => `${d.code} ${d.path}: ${d.message}`).join("; ")}`);
  }
  const buffers = kernel.buffers ?? [];
  const reserved = new Set<number>();
  const usesTextureIo = kernel.textureIo !== undefined || kernel.output !== undefined;
  if (usesTextureIo) { reserved.add(0); reserved.add(1); }
  if (kernel.uniformBinding !== undefined) reserved.add(kernel.uniformBinding);
  for (const buffer of buffers) if (buffer.binding !== undefined) reserved.add(buffer.binding);
  let nextBinding = 0;
  const allocateBinding = (explicit?: number): number => {
    if (explicit !== undefined) return explicit;
    while (reserved.has(nextBinding)) nextBinding++;
    const binding = nextBinding++; reserved.add(binding); return binding;
  };
  const bindings: Array<{ binding: number; kind: "texture-input" | "texture-output" | "uniform" | "storage-buffer"; name: string }> = [];
  const textureBindings = usesTextureIo ? { source: 0, target: 1 } : undefined;
  if (textureBindings) {
    bindings.push({ binding: textureBindings.source, kind: "texture-input", name: "source" },
      { binding: textureBindings.target, kind: "texture-output", name: "target" });
  }
  const uniformBinding = kernel.uniforms.length > 0 ? allocateBinding(kernel.uniformBinding) : undefined;
  if (uniformBinding !== undefined) bindings.push({ binding: uniformBinding, kind: "uniform", name: "uniforms" });
  const bufferLines = buffers.map((buffer) => {
    const binding = allocateBinding(buffer.binding);
    const elementType = buffer.atomic ? "atomic<u32>" : buffer.elementType === "u32" ? "u32" : "f32";
    const access = buffer.access === "read_write" ? "read_write" : "read";
    bindings.push({ binding, kind: "storage-buffer", name: buffer.name });
    return `@group(0) @binding(${binding}) var<storage, ${access}> deep_${buffer.name}: array<${elementType}>;`;
  });
  const usesHashRng = kernel.nodes.some((node) => node.op === "hash-rng")
    || (kernel.loops ?? []).some((loop) => loop.body.some((node) => node.op === "hash-rng"));
  // subgroup 能力探测合同：requires 指令 + 入口参数 + features 元数据三者同源
  // （kernelUsesSubgroupOps），不支持 subgroups 的设备由消费侧凭 features 拒绝。
  const usesSubgroup = kernelUsesSubgroupOps(kernel);
  const lines: string[] = [
    `// Deep Compute IR v0 (schema 1); generated deterministically. Kernel: ${kernel.name}`,
    `// IR sha256: ${kernelIrSha256(kernel)}`,
    // `requires` 是 module 级 global directive，必须先于一切 module-scope 声明（WGSL §8）。
    ...(usesSubgroup ? ["requires subgroups;"] : []),
    ...(kernel.uniforms.length > 0 ? ["struct DeepKernelUniforms {",
      ...kernel.uniforms.map((uniform) => `  ${uniform.name}: ${uniform.type},`), "};", ""] : []),
    ...(usesHashRng ? [
      "// PCG round of the hash (u32 exact ops only; bitwise-identical on every backend).",
      "fn deepPcg(state: u32) -> u32 {",
      "  let x = state * 747796405u + 2891336453u;",
      "  let word = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;",
      "  return (word >> 22u) ^ word;",
      "}", "",
    ] : []),
    ...(textureBindings ? [
      `@group(0) @binding(${textureBindings.source}) var deepSource: texture_2d<f32>;`,
      `@group(0) @binding(${textureBindings.target}) var deepTarget: texture_storage_2d<r32float, write>;`,
    ] : []),
    ...(uniformBinding === undefined ? [] : [
      `@group(0) @binding(${uniformBinding}) var<uniform> deepUniforms: DeepKernelUniforms;`,
    ]),
    ...bufferLines,
    "",
    `@compute @workgroup_size(${kernel.workgroupSize[0]}, ${kernel.workgroupSize[1]}, 1)`,
    `fn ${kernel.name}(@builtin(global_invocation_id) deepGlobalId: vec3u${usesSubgroup ? ", @builtin(subgroup_invocation_id) deepSubgroupLane: u32" : ""}) {`,
  ];
  for (const node of kernel.nodes) {
    lines.push(`  let ${varName(node.id)}: ${wgslType[node.type]} = ${expression(node)};`);
  }
  lines.push(`  if (!(${varName(kernel.guard)})) { return; }`);
  for (const node of kernel.nodes) if (node.op === "buffer-store") {
    lines.push(`  deep_${node.buffer}[${varName(node.index)}] = ${varName(node.value)};`);
  }
  for (const loop of kernel.loops ?? []) {
    lines.push(`  for (var l_${loop.id}: u32 = ${loop.start}u; l_${loop.id} < ${loop.end}u; l_${loop.id} = l_${loop.id} + ${loop.step}u) {`);
    for (const node of loop.body) {
      lines.push(`    let ${varName(node.id)}: ${wgslType[node.type]} = ${expression(node)};`);
      if (node.op === "buffer-store") {
        lines.push(`    deep_${node.buffer}[${varName(node.index)}] = ${varName(node.value)};`);
      }
    }
    lines.push("  }");
  }
  lines.push(
    ...(kernel.output ? [`  textureStore(deepTarget, vec2i(${varName(kernel.output.coords)}), vec4f(${varName(kernel.output.value)}, 0.0, 0.0, 0.0));`] : []),
    "}",
  );
  return { code: `${lines.join("\n")}\n`, irSha256: kernelIrSha256(kernel), features: usesSubgroup ? ["subgroups"] : [], bindings };
}
