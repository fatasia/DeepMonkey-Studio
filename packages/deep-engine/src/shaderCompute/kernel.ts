import { sha256Hex } from "../shader/canonical.js";
import type { DcirBufferElementType, DcirKernel, DcirNode, DcirUniformType, DcirValueType } from "./types.js";

const NODE_ID_PATTERN = /^[A-Za-z0-9_]+$/u;
const UNIFORM_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/u;
const U32_MAX = 0xFFFF_FFFF;

export interface DcirIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class KernelBuilder {
  private readonly entries: DcirNode[] = [];
  private readonly ids = new Set<string>();

  /** 追加一个节点并返回其 id；引用只允许指向更早节点（依赖序即展开序）。 */
  push(node: DcirNode): string {
    if (!NODE_ID_PATTERN.test(node.id)) throw new Error(`Invalid DCIR node id "${node.id}".`);
    if (this.ids.has(node.id)) throw new Error(`Duplicate DCIR node id "${node.id}".`);
    this.entries.push(node);
    this.ids.add(node.id);
    return node.id;
  }

  /** 冻结为最终节点表（保持插入顺序 = 依赖序 = 确定性展开序）。 */
  nodes(): readonly DcirNode[] { return [...this.entries]; }
}


function issue(diagnostics: DcirIssue[], code: string, path: string, message: string): void {
  diagnostics.push({ code, path, message });
}

function literalIssues(node: Extract<DcirNode, { op: "literal" }>, diagnostics: DcirIssue[]): void {
  if (node.type === "bool") {
    if (typeof node.value !== "boolean") issue(diagnostics, "invalid-literal", node.id, "bool literals must be true/false.");
    return;
  }
  if (typeof node.value !== "number") {
    issue(diagnostics, "invalid-literal", node.id, "Literals must be numbers.");
    return;
  }
  // f32 ±Infinity 是合法字面量：subgroup 归约的 inactive-lane 吸收值合同（min 用 +Inf、
  // max 用 -Inf，见 subgroup-min 合同注释）。NaN 任何类型都禁入（确定性合同 §4）。
  if (node.value === Number.POSITIVE_INFINITY || node.value === Number.NEGATIVE_INFINITY) {
    if (node.type !== "f32") issue(diagnostics, "invalid-literal", node.id, "Infinity literals are only legal for f32 (subgroup absorber).");
    return;
  }
  if (!Number.isFinite(node.value)) {
    issue(diagnostics, "invalid-literal", node.id, "Literals must be finite numbers.");
    return;
  }
  if (node.type === "u32" && (!Number.isInteger(node.value) || node.value < 0 || node.value > U32_MAX)) {
    issue(diagnostics, "invalid-literal", node.id, "u32 literals must be integers in [0, 2^32).");
  }
  if (node.type === "f32" && Math.fround(node.value) !== node.value) {
    issue(diagnostics, "invalid-literal", node.id, "f32 literals must be exactly representable.");
  }
}

function validateNode(node: DcirNode, known: Map<string, DcirValueType>, diagnostics: DcirIssue[]): void {
  const expect = (id: string, type: DcirValueType, field: string): void => {
    const actual = known.get(id);
    if (actual === undefined) issue(diagnostics, "unknown-node", `${node.id}.${field}`, `Reference "${id}" is missing or out of order.`);
    else if (actual !== type) issue(diagnostics, "type-mismatch", `${node.id}.${field}`, `Expected ${type}, got ${actual}.`);
  };
  switch (node.op) {
    case "literal": literalIssues(node, diagnostics); return;
    case "global-invocation-id": case "kernel-uniform": case "loop-index": return; // 引用由对应合同校验
    case "iadd": case "isub": case "imul": case "idiv": case "imin": case "imax":
      expect(node.inputs[0], "u32", "lhs"); expect(node.inputs[1], "u32", "rhs"); return;
    case "ieq": case "ult":
      expect(node.inputs[0], "u32", "lhs"); expect(node.inputs[1], "u32", "rhs"); return;
    case "make-vec2u": expect(node.inputs[0], "u32", "x"); expect(node.inputs[1], "u32", "y"); return;
    case "component": expect(node.input, "vec2u", "input"); return;
    case "fmin": case "fmax":
      expect(node.inputs[0], "f32", "lhs"); expect(node.inputs[1], "f32", "rhs"); return;
    case "canonicalize-f32": expect(node.input, "f32", "input"); return;
    case "select": {
      const [falseValue, trueValue, condition] = node.inputs;
      expect(falseValue, node.type, "falseValue"); expect(trueValue, node.type, "trueValue");
      expect(condition, "bool", "condition");
      return;
    }
    // 坐标必须为界内 vec2u（越界由 IR 内 clamp/select 前置屏蔽）。
    case "texel-load": expect(node.coords, "vec2u", "coords"); return;
    case "buffer-load": case "atomic-load":
      expect(node.index, "u32", "index");
      return; // buffer 声明存在性与 access 合法性由 bufferIssues 校验。
    case "buffer-store":
      expect(node.index, "u32", "index"); expect(node.value, node.type, "value");
      return;
    case "hash-rng":
      expect(node.seed, "u32", "seed"); expect(node.salt, "u32", "salt");
      return;
    case "subgroup-invocation-id": {
      // subgroupInvocationId 是 subgroup 内 lane 序号（u32）；发射层仅 WGSL 提供。
      const { id } = node;
      if (node.type !== "u32") issue(diagnostics, "type-mismatch", id, "subgroup-invocation-id must be u32.");
      return;
    }
    case "subgroup-min": case "subgroup-max": {
      // f32-only 合同：整型 subgroup 归约未收录（避免 i32 溢出语义分歧）。运行时也校验
      // 元数与类型（持久化 IR 可能来自不受信 JSON，编译期元组不构成防线）。
      const { id, op } = node;
      if (node.type !== "f32") issue(diagnostics, "type-mismatch", id, `${op} must be f32.`);
      if (typeof node.input !== "string") {
        issue(diagnostics, "invalid-input", id, `${op} requires exactly one input reference.`);
        return;
      }
      expect(node.input, "f32", "input");
      return;
    }
  }
  node satisfies never; // op 集合扩展时编译失败，强制补全校验
}

function uniformIssues(kernel: DcirKernel, diagnostics: DcirIssue[]): Map<string, DcirUniformType> {
  const types = new Map<string, DcirUniformType>();
  const seen = new Set<string>();
  for (const uniform of kernel.uniforms) {
    if (!UNIFORM_NAME_PATTERN.test(uniform.name)) {
      issue(diagnostics, "invalid-uniform", uniform.name, "Uniform names must be identifiers.");
      continue;
    }
    if (seen.has(uniform.name)) issue(diagnostics, "duplicate-uniform", uniform.name, "Uniform names must be unique.");
    seen.add(uniform.name);
    types.set(uniform.name, uniform.type);
  }
  for (const node of kernel.nodes) {
    if (node.op !== "kernel-uniform") continue;
    const type = types.get(node.uniform);
    if (type === undefined) issue(diagnostics, "unknown-uniform", node.id, `Uniform "${node.uniform}" is not declared.`);
    else if (type !== node.type) issue(diagnostics, "type-mismatch", node.id, `Uniform "${node.uniform}" is ${type}.`);
  }
  return types;
}

function bufferIssues(kernel: DcirKernel, diagnostics: DcirIssue[]): Map<string, DcirBufferElementType> {
  const declared = new Map<string, DcirBufferElementType>();
  for (const buffer of kernel.buffers ?? []) {
    if (!UNIFORM_NAME_PATTERN.test(buffer.name)) {
      issue(diagnostics, "invalid-buffer", buffer.name, "Buffer names must be identifiers.");
      continue;
    }
    if (declared.has(buffer.name)) issue(diagnostics, "duplicate-buffer", buffer.name, "Buffer names must be unique.");
    if (buffer.atomic && (buffer.elementType !== "u32" || buffer.access !== "read_write")) {
      issue(diagnostics, "invalid-atomic-buffer", buffer.name, "Atomic buffers must be read_write u32 arrays.");
    }
    declared.set(buffer.name, buffer.elementType);
  }
  for (const node of kernel.nodes) {
    if (node.op !== "buffer-load" && node.op !== "buffer-store" && node.op !== "atomic-load") continue;
    const elementType = declared.get(node.buffer);
    if (elementType === undefined) issue(diagnostics, "unknown-buffer", node.id, `Buffer "${node.buffer}" is not declared.`);
    else if (elementType !== node.type) issue(diagnostics, "type-mismatch", node.id, `Buffer "${node.buffer}" carries ${elementType}.`);
    if (node.op === "buffer-store" && kernel.buffers?.find((buffer) => buffer.name === node.buffer)?.access !== "read_write") {
      issue(diagnostics, "buffer-not-writable", node.id, `Buffer "${node.buffer}" must be declared read_write for buffer-store.`);
    }
    const atomic = kernel.buffers?.find((buffer) => buffer.name === node.buffer)?.atomic === true;
    if (node.op === "atomic-load" && !atomic) {
      issue(diagnostics, "buffer-not-atomic", node.id, `Buffer "${node.buffer}" must be declared atomic for atomic-load.`);
    } else if ((node.op === "buffer-load" || node.op === "buffer-store") && atomic) {
      issue(diagnostics, "atomic-buffer-access", node.id, `Atomic buffer "${node.buffer}" requires atomic operations.`);
    }
  }
  validateLoops(kernel, diagnostics);
  return declared;
}

function bindingIssues(kernel: DcirKernel, diagnostics: DcirIssue[]): void {
  const occupied = new Map<number, string>();
  const claim = (binding: number | undefined, path: string): void => {
    if (binding === undefined) return;
    if (!Number.isSafeInteger(binding) || binding < 0) {
      issue(diagnostics, "invalid-binding", path, "Bindings must be non-negative safe integers."); return;
    }
    const previous = occupied.get(binding);
    if (previous) issue(diagnostics, "duplicate-binding", path, `Binding ${binding} is already used by ${previous}.`);
    else occupied.set(binding, path);
  };
  // `output` is the schema-1 texture-kernel marker. `textureIo` was added later
  // to make buffer-only kernels explicit without invalidating persisted v1 IR.
  if (kernel.textureIo || kernel.output) { claim(0, "textureInput"); claim(1, "textureOutput"); }
  if (kernel.uniforms.length === 0 && kernel.uniformBinding !== undefined) {
    issue(diagnostics, "invalid-binding", "uniformBinding", "A kernel without uniforms cannot declare uniformBinding.");
  } else if (kernel.uniforms.length > 0) claim(kernel.uniformBinding, "uniformBinding");
  for (const buffer of kernel.buffers ?? []) claim(buffer.binding, `buffers.${buffer.name}`);
}

function validateLoops(kernel: DcirKernel, diagnostics: DcirIssue[]): void {
  const seen = new Set<string>();
  for (const loop of kernel.loops ?? []) {
    if (!NODE_ID_PATTERN.test(loop.id) || !NODE_ID_PATTERN.test(loop.indexId)) issue(diagnostics, "invalid-loop", loop.id, "Loop ids must be identifiers.");
    if (seen.has(loop.id)) issue(diagnostics, "duplicate-loop", loop.id, "Loop ids must be unique.");
    seen.add(loop.id);
    if (!Number.isSafeInteger(loop.start) || !Number.isSafeInteger(loop.end) || !Number.isSafeInteger(loop.step)
      || loop.step <= 0 || loop.end < loop.start || loop.end - loop.start > 4096) {
      issue(diagnostics, "invalid-loop", loop.id, "Loop range must be a static safe range with step > 0 and at most 4096 iterations.");
    }
    const known = new Map<string, DcirValueType>([[loop.indexId, "u32"]]);
    for (const node of loop.body) {
      if (known.has(node.id)) issue(diagnostics, "duplicate-node", node.id, "Loop body node ids must be unique.");
      else { validateNode(node, known, diagnostics); known.set(node.id, node.type); }
    }
  }
}

/** 校验内核合同：依赖序、类型正确、guard/output 指向存在且类型正确的节点。 */
export function validateKernel(kernel: DcirKernel): readonly DcirIssue[] {
  const diagnostics: DcirIssue[] = [];
  if (!/^[a-z][a-z0-9_]*$/u.test(kernel.name)) issue(diagnostics, "invalid-name", "kernel", "Kernel name must be snake_case.");
  if (kernel.workgroupSize.length !== 2 || kernel.workgroupSize.some((size) => !Number.isInteger(size) || size < 1)) {
    issue(diagnostics, "invalid-workgroup", "kernel", "workgroupSize must be two positive integers.");
  }
  uniformIssues(kernel, diagnostics);
  bufferIssues(kernel, diagnostics);
  bindingIssues(kernel, diagnostics);
  const known = new Map<string, DcirValueType>();
  for (const node of kernel.nodes) {
    if (!NODE_ID_PATTERN.test(node.id)) { issue(diagnostics, "invalid-id", "kernel", `Bad node id "${node.id}".`); continue; }
    if (known.has(node.id)) issue(diagnostics, "duplicate-node", node.id, "Node ids must be unique.");
    else { validateNode(node, known, diagnostics); known.set(node.id, node.type); }
  }
  if (known.get(kernel.guard) !== "bool") issue(diagnostics, "invalid-guard", "kernel", "guard must reference a bool node.");
  if (kernel.textureIo || kernel.output) {
    if (!kernel.output) issue(diagnostics, "invalid-output", "kernel", "texture kernels require an output.");
    else {
      if (known.get(kernel.output.coords) !== "vec2u") issue(diagnostics, "invalid-output", "kernel", "output.coords must reference a vec2u node.");
      if (known.get(kernel.output.value) !== "f32") issue(diagnostics, "invalid-output", "kernel", "output.value must reference an f32 node.");
    }
  } else {
    if (kernel.output) issue(diagnostics, "invalid-output", "kernel", "buffer-only kernels cannot declare a texture output.");
    if (kernel.nodes.some((node) => node.op === "texel-load")) {
      issue(diagnostics, "missing-texture-io", "kernel", "texel-load requires textureIo.");
    }
  }
  return diagnostics;
}

/** IR 内容哈希：canonical JSON（码点序键排序）+ 纯 TS sha256；同 IR 必同哈希。 */
export function kernelIrSha256(kernel: DcirKernel): string {
  return sha256Hex({ schema: 1, kernel });
}

const SUBGROUP_OPS: ReadonlySet<string> = new Set(["subgroup-min", "subgroup-max", "subgroup-invocation-id"]);

/**
 * 内核是否使用 subgroup 能力（含 loop 体）。发射 WGSL 时据此声明 `requires subgroups;` 与
 * `@builtin(subgroup_invocation_id)` 参数；消费侧据此在 device 上探测 `subgroups` feature——
 * 不支持的环境必须走该探测拒绝，而不是让 createShaderModule 产出坏 shader。
 */
export function kernelUsesSubgroupOps(kernel: DcirKernel): boolean {
  const hit = (node: DcirNode): boolean => SUBGROUP_OPS.has(node.op);
  return kernel.nodes.some(hit) || (kernel.loops ?? []).some((loop) => loop.body.some(hit));
}
