import { kernelIrSha256, validateKernel } from "./kernel.js";
import type { DcirKernel, DcirNode } from "./types.js";

/**
 * WGSL 后端：WebGPU compute 与 Native wgpu 消费同一文本。
 * 每个节点展开为一条 `let`，展开顺序 = IR 依赖序（确定性合同 §4.2）。
 */

const varName = (id: string): string => `n_${id}`;

function literal(node: Extract<DcirNode, { op: "literal" }>): string {
  if (node.type === "bool") return node.value ? "true" : "false";
  if (node.type === "u32") return `${node.value}u`;
  const text = String(node.value);
  return text.includes(".") || text.includes("e") ? text : `${text}.0`;
}

function expression(node: DcirNode): string {
  switch (node.op) {
    case "literal": return literal(node);
    case "global-invocation-id": return "deepGlobalId.xy";
    case "kernel-uniform": return `deepUniforms.${node.uniform}`;
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
  }
  node satisfies never; // op 集合扩展时编译失败，强制补全两个后端
}

const wgslType: Readonly<Record<string, string>> = { u32: "u32", f32: "f32", vec2u: "vec2u", bool: "bool" };

export interface EmittedKernelWgsl {
  readonly code: string;
  readonly irSha256: string;
}

export function emitKernelWgsl(kernel: DcirKernel): EmittedKernelWgsl {
  const diagnostics = validateKernel(kernel);
  if (diagnostics.length > 0) {
    throw new Error(`Invalid DCIR kernel "${kernel.name}": ${diagnostics.map((d) => `${d.code} ${d.path}: ${d.message}`).join("; ")}`);
  }
  const buffers = kernel.buffers ?? [];
  const bufferLines = buffers.map((buffer, index) => {
    const elementType = buffer.elementType === "u32" ? "u32" : "f32";
    return `@group(0) @binding(${3 + index}) var<storage, read> deep_${buffer.name}: array<${elementType}>;`;
  });
  const lines: string[] = [
    `// Deep Compute IR v0 (schema 1); generated deterministically. Kernel: ${kernel.name}`,
    `// IR sha256: ${kernelIrSha256(kernel)}`,
    "struct DeepKernelUniforms {",
    ...kernel.uniforms.map((uniform) => `  ${uniform.name}: ${uniform.type},`),
    "};",
    "",
    "@group(0) @binding(0) var deepSource: texture_2d<f32>;",
    "@group(0) @binding(1) var deepTarget: texture_storage_2d<r32float, write>;",
    "@group(0) @binding(2) var<uniform> deepUniforms: DeepKernelUniforms;",
    ...bufferLines,
    "",
    `@compute @workgroup_size(${kernel.workgroupSize[0]}, ${kernel.workgroupSize[1]}, 1)`,
    `fn ${kernel.name}(@builtin(global_invocation_id) deepGlobalId: vec3u) {`,
  ];
  for (const node of kernel.nodes) {
    lines.push(`  let ${varName(node.id)}: ${wgslType[node.type]} = ${expression(node)};`);
  }
  lines.push(
    `  if (!(${varName(kernel.guard)})) { return; }`,
    `  textureStore(deepTarget, vec2i(${varName(kernel.output.coords)}), vec4f(${varName(kernel.output.value)}, 0.0, 0.0, 0.0));`,
    "}",
  );
  return { code: `${lines.join("\n")}\n`, irSha256: kernelIrSha256(kernel) };
}
