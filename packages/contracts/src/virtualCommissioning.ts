/** 虚拟调试只接受可序列化的控制信号，确保 Worker、API 与证据文件行为一致。 */
export type VirtualDebugSignalValue = number | boolean | string;

export interface VirtualDebugCommand {
  atMs: number;
  type: "start" | "stop" | "reset" | "set";
  key?: string;
  value?: VirtualDebugSignalValue;
}

export interface VirtualDebugFault {
  atMs: number;
  code: string;
  signal?: string;
  value?: VirtualDebugSignalValue;
}

export interface VirtualDebugAssertion {
  id: string;
  atMs?: number;
  expression: "running-implies-motor" | "fault-implies-alarm" | "signal-equals";
  signal?: string;
  value?: VirtualDebugSignalValue;
}

export interface VirtualDebugObjectTarget {
  sceneId: string;
  objectId: string;
  objectKind: "model" | "primitive";
}

/** 将控制 I/O 映射到已有三维对象；映射不复制模型，也不进入 BIM 编辑职责。 */
export interface VirtualDebugSignalBinding {
  id: string;
  signal: string;
  label?: string;
  presentation: "running" | "alarm" | "value";
  target: VirtualDebugObjectTarget;
}

export interface VirtualDebugScenario {
  id: string;
  durationMs: number;
  tickMs?: number;
  initialSignals?: Record<string, VirtualDebugSignalValue>;
  commands?: VirtualDebugCommand[];
  faults?: VirtualDebugFault[];
  assertions?: VirtualDebugAssertion[];
  bindings?: VirtualDebugSignalBinding[];
}

export interface VirtualDebugTrace {
  atMs: number;
  state: "idle" | "running" | "faulted";
  signals: Record<string, VirtualDebugSignalValue>;
  events: string[];
}

export interface VirtualDebugFailure {
  assertionId: string;
  atMs: number;
  message: string;
  signal?: string;
  bindingId?: string;
  target?: VirtualDebugObjectTarget;
}

export interface VirtualDebugResult {
  status: "passed" | "failed";
  scenarioId: string;
  tickMs: number;
  durationMs: number;
  trace: VirtualDebugTrace[];
  bindings: VirtualDebugSignalBinding[];
  failures: VirtualDebugFailure[];
  evidenceFingerprint: string;
}

export interface VirtualDebugSuiteCase {
  id: string;
  label: string;
  expectedStatus: VirtualDebugResult["status"];
  scenario: VirtualDebugScenario;
}

/** 批量黄金测试只判断实际结果是否符合预期，故障被正确检出同样属于验收通过。 */
export interface VirtualDebugSuite {
  id: string;
  label: string;
  cases: VirtualDebugSuiteCase[];
}

export interface VirtualDebugSuiteCaseResult {
  id: string;
  label: string;
  expectedStatus: VirtualDebugResult["status"];
  expectationMatched: boolean;
  result: VirtualDebugResult;
}

export interface VirtualDebugSuiteResult {
  status: "passed" | "failed";
  suiteId: string;
  label: string;
  totalCases: number;
  matchedCases: number;
  cases: VirtualDebugSuiteCaseResult[];
  evidenceFingerprint: string;
}
