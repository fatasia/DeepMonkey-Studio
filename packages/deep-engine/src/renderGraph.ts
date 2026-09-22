export interface RenderResourceDescriptor {
  readonly id: string;
  readonly descriptor: string;
  readonly external?: boolean;
  /** Explicit complete compatibility key (format, size, sample count, usage); omission disables alias reuse. */
  readonly aliasKey?: string;
}

export interface RenderPassDescriptor {
  readonly id: string;
  readonly kind: string;
  readonly inputs?: readonly string[];
  readonly outputs?: readonly string[];
  readonly dependencies?: readonly string[];
}

export interface RenderGraphIssue {
  readonly code:
    | "invalid-id"
    | "duplicate-resource"
    | "duplicate-pass"
    | "missing-resource"
    | "missing-dependency"
    | "empty-outputs"
    | "unread-resource"
    | "uninitialized-resource"
    | "read-write-feedback"
    | "cycle";
  readonly path: string;
  readonly message: string;
}

export interface RenderGraphCompileResult {
  readonly valid: boolean;
  readonly order: readonly string[];
  /** Stable transient-allocation plan. External resources never receive a transient slot. */
  readonly resources: readonly RenderResourceLifetime[];
  readonly issues: readonly RenderGraphIssue[];
  /** Passes removed by dead-pass culling (`compile({ cullUnusedPasses: true })`); sorted deterministically. */
  readonly culledPasses?: readonly string[];
  /** Independent pass groups (same longest-path depth ⇒ no ordering path either way); each group is deterministically sorted. Passes inside one group may encode concurrently. */
  readonly parallelGroups?: readonly (readonly string[])[];
  /** Deterministic hash of the compiled plan (order + resources + culling + groups) for plan memoization. */
  readonly planHash?: string;
}

export interface RenderGraphCompileOptions {
  /**
   * Cull passes whose outputs are never read by a live pass (transitively).
   * Without this option a never-read non-external resource keeps failing with `unread-resource`.
   */
  readonly cullUnusedPasses?: boolean;
}

export interface RenderResourceLifetime {
  readonly id: string;
  readonly descriptor: string;
  readonly external: boolean;
  readonly aliasKey?: string;
  /** Inclusive pass indices in `order`; -1 means the declared external resource is unused. */
  readonly firstUse: number;
  readonly lastUse: number;
  /** Compatible, non-overlapping transient resources share this deterministic slot. */
  readonly transientSlot?: number;
}

function validId(id: string): boolean {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id !== "__proto__" &&
    id !== "constructor" &&
    id !== "prototype" &&
    /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(id)
  );
}

function graphIssue(
  code: RenderGraphIssue["code"],
  path: string,
  message: string,
): RenderGraphIssue {
  return { code, path, message };
}

export class RenderGraphBuilder {
  private readonly resources = new Map<string, RenderResourceDescriptor>();
  private readonly passes = new Map<string, RenderPassDescriptor>();
  private compiled: RenderGraphCompileResult | undefined;

  addResource(resource: RenderResourceDescriptor): this {
    if (!validId(resource?.id)) {
      throw new Error("Render resource id is invalid.");
    }
    if (this.resources.has(resource.id)) {
      throw new Error(`Render resource already exists: ${resource.id}.`);
    }
    if (typeof resource.descriptor !== "string" || resource.descriptor.length === 0) {
      throw new Error(`Render resource descriptor is empty: ${resource.id}.`);
    }
    if (resource.aliasKey !== undefined
      && (typeof resource.aliasKey !== "string" || resource.aliasKey.length === 0 || resource.aliasKey.length > 256)) {
      throw new Error(`Render resource alias key is invalid: ${resource.id}.`);
    }
    if (resource.external && resource.aliasKey !== undefined) {
      throw new Error(`External render resource cannot declare a transient alias key: ${resource.id}.`);
    }
    this.resources.set(resource.id, Object.freeze({ ...resource }));
    this.compiled = undefined;
    return this;
  }

  addPass(pass: RenderPassDescriptor): this {
    if (!validId(pass?.id)) throw new Error("Render pass id is invalid.");
    if (this.passes.has(pass.id)) throw new Error(`Render pass already exists: ${pass.id}.`);
    if (typeof pass.kind !== "string" || pass.kind.length === 0) {
      throw new Error(`Render pass kind is empty: ${pass.id}.`);
    }
    this.passes.set(pass.id, Object.freeze({
      ...pass,
      inputs: Object.freeze([...(pass.inputs ?? [])]),
      outputs: Object.freeze([...(pass.outputs ?? [])]),
      dependencies: Object.freeze([...(pass.dependencies ?? [])]),
    }));
    this.compiled = undefined;
    return this;
  }

  /** 只读快照:编译结果只含拓扑序与资源生命周期;执行计划还需每个 pass 的读写声明。
   *  命名避开私有字段 `passes`(实例字段会遮蔽同名原型方法)。 */
  declaredPasses(): readonly RenderPassDescriptor[] {
    return Object.freeze([...this.passes.values()]);
  }

  compile(options: RenderGraphCompileOptions = {}): RenderGraphCompileResult {
    if (this.compiled) return this.compiled;
    const issues: RenderGraphIssue[] = [];
    const writtenBy = new Map<string, string>();
    const readResources = new Set<string>();
    const readers = new Map<string, Set<string>>();

    for (const pass of this.passes.values()) {
      const passPath = `passes.${pass.id}`;
      for (const input of pass.inputs ?? []) {
        if (!this.resources.has(input)) {
          issues.push(
            graphIssue("missing-resource", `${passPath}.inputs`, `Unknown input resource: ${input}.`),
          );
          continue;
        }
        readResources.add(input);
        const readersOfResource = readers.get(input) ?? new Set<string>();
        readersOfResource.add(pass.id);
        readers.set(input, readersOfResource);
      }
      const outputs = pass.outputs ?? [];
      if (outputs.length === 0) {
        issues.push(graphIssue("empty-outputs", `${passPath}.outputs`, "Render pass must declare outputs."));
      }
      for (const output of outputs) {
        if (!this.resources.has(output)) {
          issues.push(
            graphIssue("missing-resource", `${passPath}.outputs`, `Unknown output resource: ${output}.`),
          );
          continue;
        }
        const producer = writtenBy.get(output);
        if (producer !== undefined && producer !== pass.id) {
          issues.push(
            graphIssue(
              "duplicate-resource",
              `${passPath}.outputs`,
              `Resource ${output} is written by both ${producer} and ${pass.id}.`,
            ),
          );
        } else {
          writtenBy.set(output, pass.id);
        }
      }
      for (const dependency of pass.dependencies ?? []) {
        if (!this.passes.has(dependency)) {
          issues.push(
            graphIssue("missing-dependency", `${passPath}.dependencies`, `Unknown pass: ${dependency}.`),
          );
        }
      }
    }

    // 死 pass 剔除(culling):活跃集 = 有 external 产出的 pass,沿"被活跃 pass 读取的
    // 产出者"与"显式依赖"闭包传播。被剔除 pass 的未读产出不再报 unread-resource。
    let livePasses: Set<string> | undefined;
    let culledPasses: string[] | undefined;
    if (options.cullUnusedPasses === true) {
      livePasses = new Set<string>();
      const stack: string[] = [];
      for (const pass of this.passes.values()) {
        if ((pass.outputs ?? []).some((id) => this.resources.get(id)?.external === true)) {
          livePasses.add(pass.id);
          stack.push(pass.id);
        }
      }
      while (stack.length > 0) {
        const id = stack.pop()!;
        const pass = this.passes.get(id);
        if (!pass) continue;
        for (const input of pass.inputs ?? []) {
          const producer = writtenBy.get(input);
          if (producer !== undefined && !livePasses.has(producer)) {
            livePasses.add(producer);
            stack.push(producer);
          }
        }
        for (const dependency of pass.dependencies ?? []) {
          if (this.passes.has(dependency) && !livePasses.has(dependency)) {
            livePasses.add(dependency);
            stack.push(dependency);
          }
        }
      }
      culledPasses = [...this.passes.keys()].filter((id) => !livePasses?.has(id));
    } else {
      for (const [resourceId, producer] of writtenBy) {
        if (!readResources.has(resourceId) && !this.resources.get(resourceId)?.external) {
          issues.push(
            graphIssue(
              "unread-resource",
              `resources.${resourceId}`,
              `Resource written by ${producer} is never read.`,
            ),
          );
        }
      }
    }

    for (const pass of this.passes.values()) {
      if (livePasses && !livePasses.has(pass.id)) continue; // 被剔除 pass 不参与合同检查。
      for (const input of pass.inputs ?? []) {
        const resource = this.resources.get(input);
        if (!resource) continue;
        if (!resource.external && !writtenBy.has(input)) {
          issues.push(graphIssue("uninitialized-resource", `passes.${pass.id}.inputs`, `Resource ${input} has no producer.`));
        }
        // 目前合同是单赋值资源；原地 storage 写入需另建显式访问合同。
        if (pass.outputs?.includes(input)) {
          issues.push(graphIssue("read-write-feedback", `passes.${pass.id}`, `Resource ${input} is both read and written; use separate resource versions.`));
        }
      }
    }

    const { order, hasCycle } = this.topologicalOrder(writtenBy, livePasses);
    if (hasCycle) {
      issues.push(graphIssue("cycle", "graph", "Render graph contains a cycle."));
    }
    const resourcePlan = issues.length > 0 ? [] : this.resourceLifetimes(order, livePasses);
    // 并行子树分析:同最长路径深度的 pass 两两无序(任一方向都无路径),
    // 可并发 encode;组内按拓扑序索引稳定排序(确定性)。
    const parallelGroups: string[][] = [];
    if (issues.length === 0 && order.length > 0) {
      const depth = new Map<string, number>();
      const producersOf = (pass: RenderPassDescriptor): string[] => {
        const preds: string[] = [];
        for (const input of pass.inputs ?? []) {
          const producer = writtenBy.get(input);
          if (producer !== undefined && producer !== pass.id) preds.push(producer);
        }
        for (const dependency of pass.dependencies ?? []) {
          if (this.passes.has(dependency)) preds.push(dependency);
        }
        return preds;
      };
      const passIndex = new Map(order.map((id, index) => [id, index]));
      for (const id of order) {
        const pass = this.passes.get(id);
        if (!pass) continue;
        let level = 0;
        for (const pred of producersOf(pass)) level = Math.max(level, (depth.get(pred) ?? 0) + 1);
        depth.set(id, level);
      }
      const byLevel = new Map<number, { id: string; index: number }[]>();
      for (const id of order) {
        const level = depth.get(id)!;
        const bucket = byLevel.get(level) ?? [];
        bucket.push({ id, index: passIndex.get(id)! });
        byLevel.set(level, bucket);
      }
      for (const level of [...byLevel.keys()].sort((a, b) => a - b)) {
        const bucket = byLevel.get(level)!.sort((a, b) => a.index - b.index);
        parallelGroups.push(bucket.map((entry) => entry.id));
      }
    }
    const planHashValue = issues.length === 0
      ? planHashOf({ order, resources: resourcePlan, culledPasses, parallelGroups })
      : undefined;
    this.compiled = Object.freeze({
      valid: issues.length === 0,
      order: Object.freeze(issues.length > 0 ? [] : order),
      resources: Object.freeze(resourcePlan),
      issues: Object.freeze(issues.map((issue) => Object.freeze(issue))),
      ...(culledPasses === undefined ? {} : { culledPasses: Object.freeze(culledPasses) }),
      ...(parallelGroups.length === 0 ? {} : { parallelGroups: Object.freeze(parallelGroups.map((group) => Object.freeze(group))) }),
      ...(planHashValue === undefined ? {} : { planHash: planHashValue }),
    });
    return this.compiled;
  }

  private resourceLifetimes(order: readonly string[], livePasses?: ReadonlySet<string>): readonly RenderResourceLifetime[] {
    const passIndex = new Map(order.map((id, index) => [id, index]));
    const producerByResource = new Map<string, string>();
    for (const pass of this.passes.values()) {
      if (livePasses && !livePasses.has(pass.id)) continue;
      for (const output of pass.outputs ?? []) producerByResource.set(output, pass.id);
    }
    const orderedAfter = (later: string, earlier: string): boolean => {
      const visited = new Set<string>();
      const visit = (passId: string): boolean => {
        if (passId === earlier) return true;
        if (visited.has(passId)) return false;
        visited.add(passId);
        const pass = this.passes.get(passId);
        if (!pass) return false;
        const predecessors = [...pass.dependencies ?? [], ...(pass.inputs ?? [])
          .map(input => producerByResource.get(input)).filter((id): id is string => id !== undefined)];
        return predecessors.some(visit);
      };
      return visit(later);
    };
    const uses = new Map<string, { first: number; last: number }>();
    for (const pass of this.passes.values()) {
      const index = passIndex.get(pass.id);
      if (index === undefined) continue;
      if (livePasses && !livePasses.has(pass.id)) continue;
      for (const id of new Set([...(pass.inputs ?? []), ...(pass.outputs ?? [])])) {
        const current = uses.get(id);
        if (current) current.last = Math.max(current.last, index);
        else uses.set(id, { first: index, last: index });
      }
    }

    const declared = Array.from(this.resources.values());
    const transientSlots = new Map<string, number>();
    const slots: Array<{ aliasKey?: string; lastUse: number }> = [];
    declared.map((resource, declaration) => ({ resource, use: uses.get(resource.id), declaration }))
      .filter((entry): entry is typeof entry & { use: { first: number; last: number } } =>
        entry.resource.external !== true && entry.use !== undefined)
      .sort((a, b) => a.use.first - b.use.first || a.declaration - b.declaration)
      .forEach(({ resource, use }) => {
      let transientSlot = resource.aliasKey === undefined ? -1 : slots.findIndex((slot) =>
        slot.aliasKey === resource.aliasKey && slot.lastUse < use.first
          && orderedAfter(order[use.first]!, order[slot.lastUse]!));
      if (transientSlot < 0) {
        transientSlot = slots.length;
        slots.push({ ...(resource.aliasKey === undefined ? {} : { aliasKey: resource.aliasKey }), lastUse: use.last });
      } else {
        slots[transientSlot]!.lastUse = use.last;
      }
      transientSlots.set(resource.id, transientSlot);
    });
    return declared
      .filter((resource) => {
        if (!livePasses) return true; // 非剔除模式:声明即入计划(既有合同)。
        return resource.external === true || uses.has(resource.id); // 剔除模式:死产出不入计划。
      })
      .map((resource) => {
      const use = uses.get(resource.id);
      const transientSlot = transientSlots.get(resource.id);
      return Object.freeze({
        id: resource.id,
        descriptor: resource.descriptor,
        external: resource.external === true,
        ...(resource.aliasKey === undefined ? {} : { aliasKey: resource.aliasKey }),
        firstUse: use?.first ?? -1,
        lastUse: use?.last ?? -1,
        ...(transientSlot === undefined ? {} : { transientSlot }),
      });
    });
  }

  private topologicalOrder(producers: ReadonlyMap<string, string>, livePasses?: ReadonlySet<string>): { order: string[]; hasCycle: boolean } {
    const dependencies = new Map<string, Set<string>>();
    for (const pass of this.passes.values()) {
      if (livePasses && !livePasses.has(pass.id)) continue;
      const edges = new Set<string>();
      for (const dependency of pass.dependencies ?? []) {
        if (this.passes.has(dependency)) edges.add(dependency);
      }
      for (const input of pass.inputs ?? []) {
        const producer = producers.get(input);
        if (producer !== undefined && producer !== pass.id) edges.add(producer);
      }
      dependencies.set(pass.id, edges);
    }

    const state = new Map<string, "visiting" | "done">();
    const order: string[] = [];
    let hasCycle = false;
    const visit = (id: string): void => {
      if (hasCycle) return;
      const status = state.get(id);
      if (status === "done") return;
      if (status === "visiting") {
        hasCycle = true;
        return;
      }
      state.set(id, "visiting");
      for (const dependency of dependencies.get(id) ?? []) visit(dependency);
      state.set(id, "done");
      order.push(id);
    };
    for (const id of livePasses ? livePasses : this.passes.keys()) {
      visit(id);
      if (hasCycle) break;
    }
    return { order, hasCycle };
  }

}


/** 计划指纹:FNV-1a 32 位对规范化 JSON;仅作变更检测键,不作安全摘要。 */
function planHashOf(payload: unknown): string {
  const text = JSON.stringify(payload);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
