export type FrameStageStatus = "completed" | "skipped" | "failed" | "blocked";

export interface FrameStageTrace {
  readonly stage: string;
  readonly status: FrameStageStatus;
  readonly order: number;
  readonly error?: string;
}

export interface FrameRunResult {
  readonly status: "completed" | "partial" | "invalid";
  readonly trace: readonly FrameStageTrace[];
  readonly issues: readonly string[];
}

export interface FrameStageDescriptor<TContext> {
  readonly id: string;
  readonly dependencies?: readonly string[];
  readonly shouldRun?: (context: TContext) => boolean;
  readonly execute?: (context: TContext) => void | Promise<void>;
}

interface CompiledStage<TContext> {
  readonly descriptor: FrameStageDescriptor<TContext>;
  readonly dependencies: ReadonlySet<string>;
}

export class FrameSchedulerError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Frame scheduler configuration is invalid: ${issues.join("; ")}`);
    this.name = "FrameSchedulerError";
  }
}

export class FrameScheduler<TContext> {
  private readonly stages = new Map<string, CompiledStage<TContext>>();
  private readonly order: readonly string[];

  constructor(stages: readonly FrameStageDescriptor<TContext>[]) {
    const issues: string[] = [];
    const working = new Map<string, CompiledStage<TContext>>();
    const ids = new Set(stages.map((stage) => stage?.id));

    for (const stage of stages) {
      if (typeof stage?.id !== "string" || stage.id.length === 0) {
        issues.push("Stage id must be a non-empty string.");
        continue;
      }
      if (working.has(stage.id)) issues.push(`Duplicate stage: ${stage.id}.`);
      const dependencies = new Set<string>();
      for (const dependency of stage.dependencies ?? []) {
        if (!ids.has(dependency)) {
          issues.push(`Stage ${stage.id} depends on missing stage ${dependency}.`);
        } else if (dependency === stage.id) {
          issues.push(`Stage ${stage.id} cannot depend on itself.`);
        } else {
          dependencies.add(dependency);
        }
      }
      working.set(stage.id, { descriptor: Object.freeze({ ...stage }), dependencies });
    }

    const ordered = topologicalOrder(working, issues);
    if (issues.length > 0) throw new FrameSchedulerError(issues);
    this.stages = working;
    this.order = ordered;
  }

  compiledOrder(): readonly string[] {
    return [...this.order];
  }

  async run(context: TContext): Promise<FrameRunResult> {
    const trace: FrameStageTrace[] = [];
    const statuses = new Map<string, FrameStageStatus>();
    let order = 0;

    for (const id of this.order) {
      const stage = this.stages.get(id);
      if (!stage) continue;
      // blocked 本身也必须继续传播，不能让孙级节点在输入失效后执行。
      let blocked = false;
      for (const dependency of stage.dependencies) {
        if (statuses.get(dependency) !== "completed") { blocked = true; break; }
      }
      if (blocked) {
        statuses.set(id, "blocked");
        trace.push({ stage: id, status: "blocked", order: order++ });
        continue;
      }

      try {
        if (stage.descriptor.shouldRun && !stage.descriptor.shouldRun(context)) {
          statuses.set(id, "skipped");
          trace.push({ stage: id, status: "skipped", order: order++ });
          continue;
        }
        const pending = stage.descriptor.execute?.(context);
        if (pending) await pending;
        statuses.set(id, "completed");
        trace.push({ stage: id, status: "completed", order: order++ });
      } catch (error: unknown) {
        statuses.set(id, "failed");
        trace.push({
          stage: id,
          status: "failed",
          order: order++,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const failed = trace.some((entry) => entry.status === "failed");
    return { status: failed ? "partial" : "completed", trace, issues: [] };
  }
}

function topologicalOrder<TContext>(
  stages: Map<string, CompiledStage<TContext>>,
  issues: string[],
): string[] {
  const state = new Map<string, "visiting" | "done">();
  const order: string[] = [];

  const visit = (id: string, path: readonly string[]): void => {
    const status = state.get(id);
    if (status === "done") return;
    if (status === "visiting") {
      const cycle = [...path.slice(path.indexOf(id)), id].join(" -> ");
      issues.push(`Frame stage cycle: ${cycle}.`);
      return;
    }
    state.set(id, "visiting");
    for (const dependency of stages.get(id)?.dependencies ?? []) {
      visit(dependency, [...path, id]);
    }
    state.set(id, "done");
    order.push(id);
  };

  for (const id of stages.keys()) visit(id, []);
  return order;
}
