/**
 * T31 受限行为图运行时(切片一)。
 *
 * 纯逻辑确定性运行时:事件进 → 条件表达式求值 → 白名单动作裁决,
 * 输出结构化命令 + 轨迹日志。运行时**零 DOM/Three/audio 触碰**——命令由宿主
 * 适配器映射到既有引擎通道(interaction 动作/scene-sdk 命令),保证:
 * 1. 确定性:同图 + 同初始值 + 同事件序列 + 同注入时钟 → 同命令序列 + 同轨迹。
 *    变量空间、tick 调度、遍历顺序(邻接表插入序)全部显式;表达式求值来自
 *    restrictedEvaluator(无时间/随机源,严格类型语义)。
 * 2. 有界:单次 dispatch 总步数预算、动作数上限、emit-event 重入深度上限、
 *    tick 追赶上限——任何超限都落 rejected 轨迹并可审计中断点。
 * 3. 可审计:条件判假落一条 skipped 轨迹(规则级),动作逐条落 applied/rejected
 *    轨迹(带前后值摘要)。
 */
import type { CompiledBehaviorGraph } from "./behaviorGraph";
import {
  BehaviorTraceLog,
  MonotonicBehaviorClock,
  summarizeTraceValue,
  type BehaviorTraceClock,
  type BehaviorTraceEntry,
} from "./behaviorTraceLog";
import {
  compileExpression,
  evaluateCompiledExpressionDetailed,
  RestrictedExpressionBudgetError,
  type BehaviorExpressionEnvironment,
  type RestrictedAst,
} from "./restrictedEvaluator";

/** 运行时限制(默认值即切片口径;宿主只能收紧,硬上限由求值器与图限制兜底)。 */
export interface BehaviorGraphRuntimeLimits {
  /** 单次 dispatch 允许执行的动作数上限。 */
  readonly maxActionsPerDispatch: number;
  /** emit-event 动作的重入深度上限(1 = 不允许经 emit-event 再触发)。 */
  readonly maxEventReentryDepth: number;
  /** 单次 dispatch 求值总步数预算(跨条件与动作表达式精确累计)。 */
  readonly maxStepsPerDispatch: number;
  /** advance 单次调用内,单个 tick 节点最多补触发次数(防大 delta 长循环)。 */
  readonly maxTickCatchUp: number;
}

export const BEHAVIOR_GRAPH_RUNTIME_LIMITS: BehaviorGraphRuntimeLimits = {
  maxActionsPerDispatch: 64,
  maxEventReentryDepth: 4,
  maxStepsPerDispatch: 20_000,
  maxTickCatchUp: 16,
} as const;

/** 运行时输出的结构化命令:与 BehaviorAction 白名单一一对应(emit-event 除外——重入在运行时内部消化)。 */
export type BehaviorCommandOut =
  | { readonly kind: "set-value"; readonly key: string; readonly value: unknown }
  | { readonly kind: "animate"; readonly target?: string; readonly command: "play" | "pause" | "stop" | "toggle" }
  | { readonly kind: "set-visibility"; readonly target: string; readonly mode: "show" | "hide" | "toggle" }
  | { readonly kind: "set-color"; readonly target: string; readonly color: string }
  | { readonly kind: "set-opacity"; readonly target: string; readonly value: number }
  | { readonly kind: "audio"; readonly target?: string; readonly command: "play" | "pause" | "stop" }
  | { readonly kind: "trace"; readonly message: string; readonly value?: unknown }
  | { readonly kind: "engine-command"; readonly command: string; readonly params: Record<string, unknown> };

/** 表达式可见的事件面(命名空间 event.*):场景事件 / 数据键变化 / tick。 */
export type BehaviorExpressionEvent =
  | { readonly kind: "scene-event"; readonly name: string; readonly payload?: unknown }
  | { readonly kind: "data-change"; readonly key: string; readonly value?: unknown }
  | { readonly kind: "tick"; readonly intervalMs: number };

export interface BehaviorDispatchResult {
  readonly status: "completed" | "no-match" | "budget-exceeded";
  readonly commands: readonly BehaviorCommandOut[];
  readonly entries: readonly Omit<BehaviorTraceEntry, "seq" | "atMs">[];
  /** budget-exceeded 时的机器可读原因。 */
  readonly reason?: string;
}

/** 注入只读输入(如实时数据快照);表达式经 inputs 命名空间只读访问。 */
export type BehaviorRuntimeInputs = Readonly<Record<string, unknown>>;

/** 仿真时钟:宿主推进(如 Play 驱动帧累计),求值链路绝不自取墙钟。 */
export interface BehaviorSimulationClock extends BehaviorTraceClock {
  /** 推进仿真时刻(毫秒);非正/非有限值应被实现忽略。 */
  advance(deltaMs: number): void;
}

export interface BehaviorGraphRuntimeOptions {
  readonly graph: CompiledBehaviorGraph;
  /** 轨迹日志;缺省内部创建(容量 512)。 */
  readonly trace?: BehaviorTraceLog;
  /** 注入仿真时钟;缺省单调零起时钟(与内部轨迹日志共享同一实例)。 */
  readonly clock?: BehaviorSimulationClock;
  readonly limits?: Partial<BehaviorGraphRuntimeLimits>;
}

interface DispatchSession {
  readonly commands: BehaviorCommandOut[];
  readonly entries: Omit<BehaviorTraceEntry, "seq" | "atMs">[];
  steps: number;
  actions: number;
  budgetAborted: boolean;
}

export class BehaviorGraphRuntime {
  private readonly graph: CompiledBehaviorGraph;
  private readonly trace: BehaviorTraceLog;
  private readonly clock: BehaviorSimulationClock;
  private readonly limits: BehaviorGraphRuntimeLimits;
  private readonly values = new Map<string, unknown>();
  /** tick 节点下次应触发的仿真时刻(毫秒)。 */
  private readonly tickDue = new Map<string, number>();
  private readonly actionAstCache = new Map<string, RestrictedAst>();

  constructor(options: BehaviorGraphRuntimeOptions) {
    this.graph = options.graph;
    this.clock = options.clock ?? new MonotonicBehaviorClock();
    this.trace = options.trace ?? new BehaviorTraceLog({ clock: this.clock });
    this.limits = { ...BEHAVIOR_GRAPH_RUNTIME_LIMITS, ...(options.limits ?? {}) };
    for (const node of this.graph.eventNodes) {
      if (node.event.kind === "tick") this.tickDue.set(node.id, node.event.intervalMs);
    }
  }

  /** 只读轨迹日志引用(供宿主面板消费快照)。 */
  get traceLog(): BehaviorTraceLog {
    return this.trace;
  }

  /** 注入仿真时钟当前时刻(毫秒)。 */
  nowMs(): number {
    return this.clock.nowMs();
  }

  /** 变量空间快照(键字典序;确定性序列化口径)。 */
  getValues(): Record<string, unknown> {
    const snapshot: Record<string, unknown> = {};
    for (const key of [...this.values.keys()].sort()) snapshot[key] = this.values.get(key);
    return snapshot;
  }

  getValue(key: string): unknown {
    return this.values.get(key);
  }

  /** 重置到初始态(变量空间清零;tick 调度按当前仿真时刻重新锚定;轨迹保留——审计不随重置丢失)。 */
  reset(): void {
    this.values.clear();
    this.tickDue.clear();
    const now = this.clock.nowMs();
    for (const node of this.graph.eventNodes) {
      if (node.event.kind === "tick") this.tickDue.set(node.id, now + node.event.intervalMs);
    }
  }

  /**
   * 推进仿真时钟并触发到点的 tick 事件节点。
   * 追赶上限内逐次触发;超出部分快进调度并落 rejected 轨迹(可审计的丢弃)。
   */
  advance(deltaMs: number, inputs: BehaviorRuntimeInputs = {}): BehaviorDispatchResult {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return { status: "no-match", commands: [], entries: [] };
    this.clock.advance(deltaMs);
    const commands: BehaviorCommandOut[] = [];
    const entries: Omit<BehaviorTraceEntry, "seq" | "atMs">[] = [];
    let matched = false;
    let budgetAborted = false;
    let reason: string | undefined;
    for (const node of this.graph.eventNodes) {
      if (node.event.kind !== "tick" || budgetAborted) continue;
      const intervalMs = node.event.intervalMs;
      let fired = 0;
      while (this.clock.nowMs() >= (this.tickDue.get(node.id) ?? Number.POSITIVE_INFINITY)) {
        if (fired >= this.limits.maxTickCatchUp) {
          // 快进越过积压周期并留痕:确定性丢弃,不是静默吞掉。
          let due = this.tickDue.get(node.id)!;
          while (this.clock.nowMs() >= due) due += intervalMs;
          this.tickDue.set(node.id, due);
          entries.push({
            graphId: this.graph.id,
            eventNodeId: node.id,
            outcome: "rejected",
            reason: `tick 积压超过单次追赶上限 ${this.limits.maxTickCatchUp},已快进丢弃`,
          });
          break;
        }
        const due = this.tickDue.get(node.id)!;
        this.tickDue.set(node.id, due + intervalMs);
        fired += 1;
        const session = this.createSession();
        this.walkNode(node.id, { kind: "tick", intervalMs }, inputs, session, 1);
        this.flushTrace(session);
        commands.push(...session.commands);
        entries.push(...session.entries);
        matched = true;
        if (session.budgetAborted) {
          budgetAborted = true;
          reason = `单次派发求值超过步数预算 ${this.limits.maxStepsPerDispatch},已中止`;
          break;
        }
      }
    }
    if (budgetAborted) return { status: "budget-exceeded", commands, entries, ...(reason !== undefined ? { reason } : {}) };
    return { status: matched ? "completed" : "no-match", commands, entries };
  }

  /** 批量写数据:仅对发生变化的键(按字典序)派发 data-change 事件(严格不等判定,确定)。 */
  applyData(record: Readonly<Record<string, unknown>>, inputs: BehaviorRuntimeInputs = {}): BehaviorDispatchResult {
    const changed: { key: string; value: unknown }[] = [];
    for (const key of Object.keys(record).sort()) {
      const next = record[key];
      if (!Object.is(this.values.get(key), next)) {
        this.values.set(key, next);
        changed.push({ key, value: next });
      }
    }
    const commands: BehaviorCommandOut[] = [];
    const entries: Omit<BehaviorTraceEntry, "seq" | "atMs">[] = [];
    let budgetAborted = false;
    let reason: string | undefined;
    for (const change of changed) {
      const session = this.createSession();
      this.routeAndWalk({ kind: "data-change", key: change.key, value: change.value }, inputs, session);
      this.flushTrace(session);
      commands.push(...session.commands);
      entries.push(...session.entries);
      if (session.budgetAborted) {
        budgetAborted = true;
        reason = `单次派发求值超过步数预算 ${this.limits.maxStepsPerDispatch},已中止`;
        break;
      }
    }
    if (budgetAborted) return { status: "budget-exceeded", commands, entries, ...(reason !== undefined ? { reason } : {}) };
    return { status: changed.length > 0 ? "completed" : "no-match", commands, entries };
  }

  /** 派发场景事件(外部入口):按事件名路由到匹配的事件节点。 */
  dispatchEvent(name: string, payload?: unknown, inputs: BehaviorRuntimeInputs = {}): BehaviorDispatchResult {
    const session = this.createSession();
    const matched = this.routeAndWalk({ kind: "scene-event", name, ...(payload !== undefined ? { payload } : {}) }, inputs, session);
    this.flushTrace(session);
    if (session.budgetAborted) {
      return {
        status: "budget-exceeded",
        commands: session.commands,
        entries: session.entries,
        reason: `单次派发求值超过步数预算 ${this.limits.maxStepsPerDispatch},已中止`,
      };
    }
    return { status: matched ? "completed" : "no-match", commands: session.commands, entries: session.entries };
  }

  /* ------------------------------ 内部遍历 ------------------------------ */

  private createSession(): DispatchSession {
    return { commands: [], entries: [], steps: 0, actions: 0, budgetAborted: false };
  }

  /** 事件路由:找到匹配的事件节点并从各自起遍历;返回是否有节点匹配。 */
  private routeAndWalk(event: BehaviorExpressionEvent, inputs: BehaviorRuntimeInputs, session: DispatchSession): boolean {
    const targets = this.graph.eventNodes
      .filter((node) => eventMatches(node.event, event))
      .map((node) => node.id);
    for (const nodeId of targets) this.walkNode(nodeId, event, inputs, session, 1);
    return targets.length > 0;
  }

  private walkNode(
    nodeId: string,
    event: BehaviorExpressionEvent,
    inputs: BehaviorRuntimeInputs,
    session: DispatchSession,
    depth: number,
  ): void {
    if (session.budgetAborted) return;
    const kind = this.graph.nodeKinds.get(nodeId);
    if (kind === "condition") {
      this.evaluateCondition(nodeId, event, inputs, session, depth);
      return;
    }
    if (kind === "action") {
      this.executeAction(nodeId, event, inputs, session, depth);
      return;
    }
    // event 节点:沿出边继续(入口节点本身不落轨迹,条件/动作才落)。
    for (const next of this.graph.outgoing.get(nodeId) ?? []) this.walkNode(next, event, inputs, session, depth);
  }

  private evaluateCondition(
    nodeId: string,
    event: BehaviorExpressionEvent,
    inputs: BehaviorRuntimeInputs,
    session: DispatchSession,
    depth: number,
  ): void {
    const expression = this.graph.conditionExpressions.get(nodeId);
    if (!expression) return;
    let passed: unknown;
    try {
      const detailed = evaluateCompiledExpressionDetailed(
        expression.ast,
        this.environment(event, inputs),
        Math.max(1, this.limits.maxStepsPerDispatch - session.steps),
      );
      session.steps += detailed.steps;
      passed = detailed.value;
    } catch (error) {
      if (handleBudget(error, session, this.graph.id, event, nodeId, "condition")) return;
      // 条件求值语义错误:本分支按判假处理并留痕,不终止兄弟分支(遍历序固定,确定)。
      session.entries.push({
        graphId: this.graph.id,
        eventNodeId: eventNodeIdOf(event),
        actionNodeId: nodeId,
        action: "condition",
        outcome: "skipped",
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!passed) {
      session.entries.push({
        graphId: this.graph.id,
        eventNodeId: eventNodeIdOf(event),
        actionNodeId: nodeId,
        action: "condition",
        outcome: "skipped",
        reason: "condition-false",
      });
      return;
    }
    for (const next of this.graph.outgoing.get(nodeId) ?? []) this.walkNode(next, event, inputs, session, depth);
  }

  private executeAction(
    nodeId: string,
    event: BehaviorExpressionEvent,
    inputs: BehaviorRuntimeInputs,
    session: DispatchSession,
    depth: number,
  ): void {
    if (session.budgetAborted) return;
    const action = this.graph.actionNodes.get(nodeId);
    if (!action) return;
    if (session.actions >= this.limits.maxActionsPerDispatch) {
      session.entries.push({
        graphId: this.graph.id,
        eventNodeId: eventNodeIdOf(event),
        actionNodeId: nodeId,
        action: action.type,
        outcome: "rejected",
        reason: `单次派发动作数超过上限 ${this.limits.maxActionsPerDispatch}`,
      });
      return;
    }
    if (depth > this.limits.maxEventReentryDepth) {
      session.entries.push({
        graphId: this.graph.id,
        eventNodeId: eventNodeIdOf(event),
        actionNodeId: nodeId,
        action: action.type,
        outcome: "rejected",
        reason: `事件重入深度超过上限 ${this.limits.maxEventReentryDepth}`,
      });
      return;
    }
    session.actions += 1;
    // emit-event:重入派发内部消化,不产生外部命令。
    if (action.type === "emit-event") {
      const nested: BehaviorExpressionEvent = { kind: "scene-event", name: action.name, ...(action.payload !== undefined ? { payload: action.payload } : {}) };
      const matched = this.graph.eventNodes.filter((node) => eventMatches(node.event, nested)).map((node) => node.id);
      session.entries.push({
        graphId: this.graph.id,
        eventNodeId: eventNodeIdOf(event),
        actionNodeId: nodeId,
        action: action.type,
        target: action.name,
        outcome: matched.length > 0 ? "applied" : "rejected",
        ...(matched.length === 0 ? { reason: `事件 “${action.name}” 没有匹配的事件节点` } : {}),
      });
      for (const target of matched) this.walkNode(target, nested, inputs, session, depth + 1);
      return;
    }
    const record = (
      detail: { target?: string; before?: string; after?: string; outcome: "applied" | "rejected"; reason?: string },
      command?: BehaviorCommandOut,
    ): void => {
      session.entries.push({
        graphId: this.graph.id,
        eventNodeId: eventNodeIdOf(event),
        actionNodeId: nodeId,
        action: action.type,
        ...detail,
      });
      if (command) session.commands.push(command);
    };
    const evaluate = (expression: string): { ok: true; value: unknown } | { ok: false } => {
      try {
        const detailed = evaluateCompiledExpressionDetailed(
          this.actionAst(expression),
          this.environment(event, inputs),
          Math.max(1, this.limits.maxStepsPerDispatch - session.steps),
        );
        session.steps += detailed.steps;
        return { ok: true, value: detailed.value };
      } catch (error) {
        if (error instanceof RestrictedExpressionBudgetError) {
          session.budgetAborted = true;
          session.entries.push({
            graphId: this.graph.id,
            eventNodeId: eventNodeIdOf(event),
            actionNodeId: nodeId,
            action: action.type,
            outcome: "rejected",
            reason: error.message,
          });
          return { ok: false };
        }
        record({ outcome: "rejected", reason: error instanceof Error ? error.message : String(error) });
        return { ok: false };
      }
    };
    switch (action.type) {
      case "set-value": {
        const outcome = evaluate(action.expression);
        if (!outcome.ok) return;
        const before = this.values.get(action.key);
        this.values.set(action.key, outcome.value);
        record(
          { target: action.key, before: summarizeTraceValue(before), after: summarizeTraceValue(outcome.value), outcome: "applied" },
          { kind: "set-value", key: action.key, value: outcome.value },
        );
        return;
      }
      case "animate":
        record(
          { outcome: "applied", ...(action.target !== undefined ? { target: action.target } : {}) },
          { kind: "animate", ...(action.target !== undefined ? { target: action.target } : {}), command: action.command },
        );
        return;
      case "set-visibility":
        record({ target: action.target, after: action.mode, outcome: "applied" }, { kind: "set-visibility", target: action.target, mode: action.mode });
        return;
      case "set-color":
        record({ target: action.target, after: action.color, outcome: "applied" }, { kind: "set-color", target: action.target, color: action.color });
        return;
      case "set-opacity": {
        const outcome = evaluate(action.expression);
        if (!outcome.ok) return;
        // set-opacity 语义要求 number(适配器负责 0..1 夹取);类型不符按拒绝留痕。
        if (typeof outcome.value !== "number") {
          record({ target: action.target, after: summarizeTraceValue(outcome.value), outcome: "rejected", reason: `set-opacity 表达式结果须为 number,得到 ${summarizeTraceValue(typeof outcome.value)}` });
          return;
        }
        record(
          { target: action.target, after: summarizeTraceValue(outcome.value), outcome: "applied" },
          { kind: "set-opacity", target: action.target, value: outcome.value },
        );
        return;
      }
      case "audio":
        record(
          { after: action.command, outcome: "applied", ...(action.target !== undefined ? { target: action.target } : {}) },
          { kind: "audio", ...(action.target !== undefined ? { target: action.target } : {}), command: action.command },
        );
        return;
      case "trace": {
        if (action.valueExpression === undefined) {
          record({ outcome: "applied" }, { kind: "trace", message: action.message });
          return;
        }
        const outcome = evaluate(action.valueExpression);
        if (!outcome.ok) return;
        record(
          { after: summarizeTraceValue(outcome.value), outcome: "applied" },
          { kind: "trace", message: action.message, value: outcome.value },
        );
        return;
      }
      case "engine-command":
        record(
          { target: action.command, outcome: "applied" },
          { kind: "engine-command", command: action.command, params: structuredClone(action.params) as Record<string, unknown> },
        );
        return;
    }
  }

  private actionAst(expression: string): RestrictedAst {
    const cached = this.actionAstCache.get(expression);
    if (cached) return cached;
    const ast = compileExpression(expression).ast;
    this.actionAstCache.set(expression, ast);
    return ast;
  }

  /** 表达式环境(显式命名空间,避免跨源同名冲突):values=变量空间;event=事件面;inputs=注入只读输入。 */
  private environment(event: BehaviorExpressionEvent, inputs: BehaviorRuntimeInputs): BehaviorExpressionEnvironment {
    return {
      values: this.getValues(),
      event:
        event.kind === "scene-event"
          ? { kind: event.kind, name: event.name, ...(event.payload !== undefined ? { payload: event.payload } : {}) }
          : event.kind === "data-change"
            ? { kind: event.kind, key: event.key, ...(event.value !== undefined ? { value: event.value } : {}) }
            : { kind: event.kind, intervalMs: event.intervalMs },
      inputs,
    };
  }

  private flushTrace(session: DispatchSession): void {
    const atMs = this.trace.nowMs();
    for (const entry of session.entries) this.trace.append({ ...entry, atMs });
  }
}

function handleBudget(
  error: unknown,
  session: DispatchSession,
  graphId: string,
  event: BehaviorExpressionEvent,
  nodeId: string,
  action: string,
): boolean {
  if (!(error instanceof RestrictedExpressionBudgetError)) return false;
  session.budgetAborted = true;
  session.entries.push({
    graphId,
    eventNodeId: eventNodeIdOf(event),
    actionNodeId: nodeId,
    action,
    outcome: "rejected",
    reason: error.message,
  });
  return true;
}

function eventNodeIdOf(event: BehaviorExpressionEvent): string {
  if (event.kind === "scene-event") return `scene-event:${event.name}`;
  if (event.kind === "data-change") return `data-change:${event.key}`;
  return `tick:${event.intervalMs}`;
}

function eventMatches(source: CompiledBehaviorGraph["eventNodes"][number]["event"], event: BehaviorExpressionEvent): boolean {
  if (source.kind === "scene-event" && event.kind === "scene-event") return source.name === event.name;
  if (source.kind === "data-change" && event.kind === "data-change") return source.key === event.key;
  return false;
}
