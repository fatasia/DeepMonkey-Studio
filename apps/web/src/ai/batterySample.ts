export type BatteryExampleTask = "soc" | "soh" | "rul";
export type BatteryExampleGroup = "validation" | "engineering" | "risk";

export interface BatteryExample {
  id: string;
  name: string;
  detail: string;
  group: BatteryExampleGroup;
  fileName: string;
  chemistry: "lfp" | "ncm";
  nominalCapacityAh: number;
  tasks: readonly BatteryExampleTask[];
  defaultTask: BatteryExampleTask;
  headers: readonly string[];
  url?: string;
  generated?: true;
}

const MULTISCALE_HEADERS = [
  "cellId", "cycle", "time", "current", "voltage", "capacityAh",
  "chargeCapacityAh", "referenceSoc", "soh", "nominalCapacityAh",
  "sourceDataset", "sourceFile", "dataProvenance",
] as const;

const TEMPEST_HEADERS = [
  "cellId", "cycle", "time", "current", "voltage", "temperature",
  "temperatureEdgeC", "capacityAh", "chargeCapacityAh", "referenceSoc",
  "soh", "rptCapacityAh", "ohmicResistanceOhm", "nominalCapacityAh",
  "phase", "sourceDataset", "sourceFile", "dataProvenance",
  "measurementScope", "rulEventObserved", "observedSurvivalCycles",
  "lifetimeLowerBoundCycles", "rulTargetSemantics",
] as const;

const PACK_HEADERS = [
  "cellId", "moduleId", "topology", "seriesCount", "parallelCount",
  "cycle", "time", "current", "voltage", "temperature",
  "internalResistanceMOhm", "capacityAh", "referenceSoc", "soh",
  "nominalCapacityAh", "sourceDataset", "dataProvenance", "measurementScope",
] as const;

const OOD_HEADERS = [
  "cellId", "cycle", "time", "current", "voltage", "temperature",
  "capacityAh", "referenceSoc", "soh", "nominalCapacityAh", "sensorMask",
  "dataProvenance", "measurementScope",
] as const;

const SOC_HEADERS = ["time_s", "current_a", "voltage_v", "temperature_c", "reference_soc_pct"] as const;
const ALL_TASKS = ["soc", "soh", "rul"] as const;
const STATE_TASKS = ["soc", "soh"] as const;

export const BATTERY_EXAMPLES: readonly BatteryExample[] = [
  {
    id: "nca-validation", name: "NCA 公开验证", group: "validation",
    detail: "SNL · 3.2 Ah · 隔离测试 · 参考 EOL 378 圈",
    fileName: "multiscale-battery-assessment-demo.csv", url: "/samples/multiscale-battery-assessment-demo.csv",
    chemistry: "ncm", nominalCapacityAh: 3.2, tasks: ALL_TASKS, defaultTask: "rul", headers: MULTISCALE_HEADERS,
  },
  {
    id: "lfp-validation", name: "LFP 公开验证", group: "validation",
    detail: "SNL · 1.1 Ah · 隔离测试 · 参考 EOL 3139 圈",
    fileName: "multiscale-battery-assessment-lfp-demo.csv", url: "/samples/multiscale-battery-assessment-lfp-demo.csv",
    chemistry: "lfp", nominalCapacityAh: 1.1, tasks: ALL_TASKS, defaultTask: "rul", headers: MULTISCALE_HEADERS,
  },
  {
    id: "ncm-engineering", name: "NMC 大容量工程", group: "engineering",
    detail: "CALB 方形电芯 · 58 Ah · 公开实测",
    fileName: "multiscale-battery-assessment-engineering-nmc-demo.csv", url: "/samples/multiscale-battery-assessment-engineering-nmc-demo.csv",
    chemistry: "ncm", nominalCapacityAh: 58, tasks: ALL_TASKS, defaultTask: "soh", headers: MULTISCALE_HEADERS,
  },
  {
    id: "lfp-engineering", name: "LFP 大容量工程", group: "engineering",
    detail: "100 Ah · HUST 实测轨迹同倍率工程等效",
    fileName: "multiscale-battery-assessment-engineering-lfp-demo.csv", url: "/samples/multiscale-battery-assessment-engineering-lfp-demo.csv",
    chemistry: "lfp", nominalCapacityAh: 100, tasks: ALL_TASKS, defaultTask: "rul", headers: MULTISCALE_HEADERS,
  },
  {
    id: "lfp-tempest-280ah", name: "LFP 280 Ah 老化", group: "engineering",
    detail: "TEMPEST · 700 圈公开实测 · 寿命右删失",
    fileName: "multiscale-battery-assessment-tempest-lfp-280ah-700cycle.csv", url: "/samples/multiscale-battery-assessment-tempest-lfp-280ah-700cycle.csv",
    chemistry: "lfp", nominalCapacityAh: 280, tasks: ALL_TASKS, defaultTask: "soh", headers: TEMPEST_HEADERS,
  },
  {
    id: "soc-operating-window", name: "SOC 连续工况", group: "engineering",
    detail: "电流、电压、温度与参考 SOC 连续窗口",
    fileName: "soc-estimation-demo.csv", url: "/samples/soc-estimation-demo.csv",
    chemistry: "ncm", nominalCapacityAh: 100, tasks: ["soc"], defaultTask: "soc", headers: SOC_HEADERS,
  },
  {
    id: "pack-multicell", name: "96 电芯 Pack", group: "risk",
    detail: "96S1P · 30 圈 · 一致性与弱电芯工况",
    fileName: "multiscale-battery-assessment-pack-demo.csv", url: "/samples/multiscale-battery-assessment-pack-demo.csv",
    chemistry: "lfp", nominalCapacityAh: 100, tasks: STATE_TASKS, defaultTask: "soh", headers: PACK_HEADERS,
  },
  {
    id: "lfp-out-of-domain", name: "LFP 域外脉冲", group: "risk",
    detail: "160 Ah · -20–63°C · 2.4C 脉冲 · 传感器间歇",
    fileName: "generated-out-of-domain-lfp-160ah.csv", generated: true,
    chemistry: "lfp", nominalCapacityAh: 160, tasks: STATE_TASKS, defaultTask: "soh", headers: OOD_HEADERS,
  },
] as const;

export const BATTERY_EXAMPLE_GROUPS: ReadonlyArray<{ id: BatteryExampleGroup; label: string }> = [
  { id: "validation", label: "公开验证" },
  { id: "engineering", label: "工程工况" },
  { id: "risk", label: "Pack 与风险" },
];

export function batteryExampleById(id: string): BatteryExample {
  return BATTERY_EXAMPLES.find((example) => example.id === id) ?? BATTERY_EXAMPLES[0]!;
}

export async function batteryExampleFile(example: BatteryExample, signal?: AbortSignal): Promise<File> {
  if (example.generated) {
    return new File([batteryOutOfDomainCsv()], example.fileName, { type: "text/csv" });
  }
  const response = await fetch(example.url!, { cache: "no-store", ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error(`样例加载失败（${response.status}）`);
  return new File([await response.blob()], example.fileName, { type: "text/csv" });
}

/** 小型同步循环样本仅供跨包的预处理单元测试；产品页面使用上面的真实静态样例。 */
export function batterySampleCsv(): string {
  const rows = [MULTISCALE_HEADERS.join(",")];
  for (let cycle = 1; cycle <= 100; cycle += 1) {
    const soh = 1 - (cycle - 1) * 0.0015;
    const capacity = 100 * soh;
    for (let step = 0; step < 12; step += 1) {
      const charging = step < 6;
      const phaseStep = charging ? step : step - 6;
      const fraction = phaseStep / 5;
      const current = charging ? 50 : -50;
      const chargeCapacity = charging ? capacity * fraction : capacity;
      const dischargeCapacity = charging ? 0 : capacity * fraction;
      const soc = charging ? fraction * 100 : (1 - fraction) * 100;
      const voltage = charging ? 3 + fraction * 0.55 : 3.55 - fraction * 0.65;
      rows.push([
        "LFP_TEST_100Ah", cycle, step * 60, current, voltage.toFixed(4),
        dischargeCapacity.toFixed(4), chargeCapacity.toFixed(4), soc.toFixed(2),
        soh.toFixed(6), 100, "generated-test-fixture", "batterySampleCsv", "unit-test-only",
      ].join(","));
    }
  }
  return rows.join("\n");
}

/** 原项目的确定性域外场景；用于触发适用域、传感器缺失与风险路由检查。 */
export function batteryOutOfDomainCsv(): string {
  const rows = [OOD_HEADERS.join(",")];
  const elapsedSeconds = [0, 600, 900, 1500, 1800, 2400];
  for (let cycle = 1; cycle <= 24; cycle += 1) {
    const capacityAh = 160 * (1 - 0.0018 * (cycle - 1));
    const soh = capacityAh / 160;
    for (let step = 0; step <= 5; step += 1) {
      const fraction = step / 5;
      const referenceSoc = 1 - fraction;
      const currentCRate = step % 2 === 0 ? -2.4 : -1.2;
      const temperature = step < 3 ? -20 + step * 2 : 55 + (step - 3) * 4;
      const ocv = 3.28 + 0.035 * Math.tanh((referenceSoc - 0.5) * 8) + 0.08 * (referenceSoc - 0.5);
      const residual = 0.035 * (currentCRate / 3) + 0.025 * ((temperature - 25) / 40) + 0.02 * (referenceSoc - 0.5);
      rows.push([
        "OOD_LFP_160Ah_01", cycle, elapsedSeconds[step], currentCRate * 160,
        (ocv + residual - 0.01 * (1 - soh)).toFixed(4), temperature,
        capacityAh.toFixed(4), (referenceSoc * 100).toFixed(2), soh.toFixed(6), 160,
        step === 2 || step === 4 ? "temperature-intermittent" : "complete",
        "generated-out-of-domain-demo", "lfp-extreme-temperature-pulse-adaptation-demo",
      ].join(","));
    }
  }
  return rows.join("\n");
}
