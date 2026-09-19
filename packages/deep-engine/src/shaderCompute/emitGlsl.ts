import { kernelIrSha256, validateKernel } from "./kernel.js";
import type { DcirKernel, DcirNode } from "./types.js";

/**
 * GLSL ES 3.0 后端：WebGL2 无 compute（compute 属 ES 3.1，WebGL 从未暴露），
 * 把数据并行内核降级为"全屏 fragment pass + 浮点纹理 I/O"：
 * - 一次调用 = 一个像素：dispatch 尺寸即 viewport；
 * - global-invocation-id = uvec2(gl_FragCoord.xy)（Y 方向与 compute 相反，v0 内核须方向无关）；
 * - texel-load → texelFetch；store → R32F FBO 输出（需 EXT_color_buffer_float）。
 */

const varName = (id: string): string => `n_${id}`;
const uniformName = (name: string): string => `deep_u_${name}`;

function literal(node: Extract<DcirNode, { op: "literal" }>): string {
  if (node.type === "bool") return node.value ? "true" : "false";
  if (node.type === "u32") return `${node.value}u`;
  const text = String(node.value);
  return text.includes(".") || text.includes("e") ? text : `${text}.0`;
}

function expression(node: DcirNode): string {
  switch (node.op) {
    case "literal": return literal(node);
    case "global-invocation-id": return "uvec2(gl_FragCoord.xy)";
    case "kernel-uniform": return uniformName(node.uniform);
    case "iadd": case "isub": case "imul": case "idiv": {
      const [lhs, rhs] = node.inputs;
      const symbol = { iadd: "+", isub: "-", imul: "*", idiv: "/" }[node.op];
      return `(${varName(lhs)} ${symbol} ${varName(rhs)})`;
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
      return `uvec2(${varName(x)}, ${varName(y)})`;
    }
    case "component": return `${varName(node.input)}.${node.component === 0 ? "x" : "y"}`;
    case "fmin": case "fmax": {
      const [lhs, rhs] = node.inputs;
      return `${node.op === "fmin" ? "min" : "max"}(${varName(lhs)}, ${varName(rhs)})`;
    }
    case "canonicalize-f32": {
      // 等价于 v+(+0.0) 的单次舍入折叠（-0→+0，其余位型不变）；三目形式防止 ANGLE 把
      // `x + 0.0` 代数化简回 x（真机实测会折叠，导致 -0 存活）。
      const x = varName(node.input);
      return `(${x} == 0.0 ? 0.0 : ${x})`;
    }
    case "select": {
      const [falseValue, trueValue, condition] = node.inputs;
      return `(${varName(condition)} ? ${varName(trueValue)} : ${varName(falseValue)})`;
    }
    case "texel-load": return `texelFetch(deepSource, ivec2(${varName(node.coords)}), 0).r`;
  }
  node satisfies never; // op 集合扩展时编译失败，强制补全两个后端
}

const glslType: Readonly<Record<string, string>> = { u32: "uint", f32: "float", vec2u: "uvec2", bool: "bool" };

/** 三个顶点的全屏三角（gl_VertexID 生成，无 VBO），覆盖任意 viewport。 */
export const DCIR_GLSL_VERTEX = `#version 300 es
// Deep Compute IR v0 shared fullscreen triangle; generated deterministically.
void main() {
  vec2 deepCorner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(deepCorner * 2.0 - 1.0, 0.0, 1.0);
}
`;

export interface EmittedKernelGlsl {
  readonly fragment: string;
  readonly vertex: string;
  readonly irSha256: string;
}

export function emitKernelGlsl(kernel: DcirKernel): EmittedKernelGlsl {
  const diagnostics = validateKernel(kernel);
  if (diagnostics.length > 0) {
    throw new Error(`Invalid DCIR kernel "${kernel.name}": ${diagnostics.map((d) => `${d.code} ${d.path}: ${d.message}`).join("; ")}`);
  }
  const lines: string[] = [
    "#version 300 es",
    `// Deep Compute IR v0 (schema 1); generated deterministically. Kernel: ${kernel.name}`,
    `// IR sha256: ${kernelIrSha256(kernel)}`,
    "precision highp float;",
    "precision highp int;",
    "uniform highp sampler2D deepSource;",
    ...kernel.uniforms.map((uniform) => `uniform ${uniform.type === "u32" ? "uint" : "uvec2"} ${uniformName(uniform.name)};`),
    "out vec4 deepTargetOut;",
    "",
    "void main() {",
  ];
  for (const node of kernel.nodes) {
    lines.push(`  ${glslType[node.type]} ${varName(node.id)} = ${expression(node)};`);
  }
  lines.push(
    `  if (!(${varName(kernel.guard)})) { discard; }`,
    `  deepTargetOut = vec4(${varName(kernel.output.value)}, 0.0, 0.0, 0.0);`,
    "}",
  );
  return { fragment: `${lines.join("\n")}\n`, vertex: DCIR_GLSL_VERTEX, irSha256: kernelIrSha256(kernel) };
}
