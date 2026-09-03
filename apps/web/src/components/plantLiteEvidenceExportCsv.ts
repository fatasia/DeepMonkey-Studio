import type { PlantLiteConfidenceInterval } from "@bim-studio/contracts";
import type { PlantLiteEvidencePackage } from "./plantLiteEvidenceExport";

interface MetricRow {
  category: string;
  entityId: string;
  entityName: string;
  metric: string;
  unit: string;
  mean?: number;
  sampleStandardDeviation?: number;
  lower95?: number;
  upper95?: number;
  samples?: number;
  value?: string | number | boolean;
  evidenceStatus: string;
}

const HEADERS = [
  "schema", "package_id", "package_fingerprint", "study_id", "study_name", "category",
  "entity_id", "entity_name", "metric", "unit", "mean", "sample_standard_deviation",
  "lower_95", "upper_95", "samples", "value", "evidence_status",
] as const;

/** 表格版只展平可比较指标；JSON 证据包仍是完整交付与复现依据。 */
export function plantLiteEvidenceMetricsCsv(value: PlantLiteEvidencePackage): string {
  const prefix = [
    value.schema,
    value.packageId,
    value.traceability.packageFingerprint,
    value.lineage.study.id,
    value.lineage.study.name,
  ];
  const rows = metricRows(value).map((row) => [
    ...prefix,
    row.category,
    row.entityId,
    row.entityName,
    row.metric,
    row.unit,
    row.mean ?? "",
    row.sampleStandardDeviation ?? "",
    row.lower95 ?? "",
    row.upper95 ?? "",
    row.samples ?? "",
    row.value ?? "",
    row.evidenceStatus,
  ]);
  return `\uFEFF${[HEADERS, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function metricRows(value: PlantLiteEvidencePackage): MetricRow[] {
  const rows: MetricRow[] = [];
  const system = value.statistics.system;
  rows.push(
    intervalRow("system", value.lineage.study.id, value.lineage.study.name, "throughput_per_hour", "item/hour", system.throughputPerHour),
    intervalRow("system", value.lineage.study.id, value.lineage.study.name, "average_wip", "item", system.averageWip),
    intervalRow("system", value.lineage.study.id, value.lineage.study.name, "average_lead_time", "minute", system.averageLeadTimeMinutes),
  );
  rows.push(...runRows(value), ...acceptanceRows(value), ...nodeRows(value), ...resourceRows(value));
  rows.push(...productRows(value), ...productionOrderRows(value), ...changeoverRows(value), ...qualityRows(value), ...energyRows(value), ...bottleneckRows(value), ...traceRows(value));
  return rows;
}

function runRows(value: PlantLiteEvidencePackage): MetricRow[] {
  const run = value.run;
  const scalar = (metric: string, unit: string, scalarValue: string | number | boolean): MetricRow => ({
    category: "run", entityId: value.lineage.study.id, entityName: value.lineage.study.name,
    metric, unit, value: scalarValue, evidenceStatus: "recorded-run-setting",
  });
  return [
    scalar("template_id", "", run.templateId),
    scalar("seed", "", String(run.seed)),
    scalar("requested_replications", "count", run.requestedReplications),
    scalar("completed_replications", "count", run.completedReplications),
    scalar("duration", "minute", run.window.totalMinutes),
    scalar("warmup_window", "minute", run.window.warmupMinutes),
    scalar("measurement_window", "minute", run.window.measuredMinutes),
    ...(run.legacyTemplateParameters.agvCount !== null ? [scalar("legacy_agv_count", "count", run.legacyTemplateParameters.agvCount)] : []),
    ...(run.legacyTemplateParameters.bufferCapacity !== null ? [scalar("legacy_buffer_capacity", "item", run.legacyTemplateParameters.bufferCapacity)] : []),
  ];
}

function acceptanceRows(value: PlantLiteEvidencePackage): MetricRow[] {
  const targets = value.acceptanceTargets;
  if (!targets) return [];
  const rows: MetricRow[] = [];
  if (targets.basis) rows.push(scalarRow("acceptance", "targets", "方案验收目标", "basis", "", targets.basis, "declared-target"));
  const mappings: Array<[keyof typeof targets, string, string]> = [
    ["minimumThroughputPerHour", "minimum_throughput_per_hour", "item/hour"],
    ["maximumAverageWip", "maximum_average_wip", "item"],
    ["maximumAverageLeadTimeMinutes", "maximum_average_lead_time", "minute"],
    ["maximumEnergyPerCompletedItemKwh", "maximum_energy_per_completed_item", "kWh/item"],
    ["maximumElectricityCostPerCompletedItem", "maximum_electricity_cost_per_completed_item", "CNY/item"],
    ["maximumCarbonEmissionPerCompletedItemKg", "maximum_carbon_per_completed_item", "kgCO2e/item"],
  ];
  for (const [key, metric, unit] of mappings) {
    const target = targets[key];
    if (typeof target === "number") rows.push(scalarRow("acceptance", "targets", "方案验收目标", metric, unit, target, "declared-target"));
  }
  return rows;
}

function nodeRows(value: PlantLiteEvidencePackage): MetricRow[] {
  return sortedEntries(value.statistics.nodeMetrics95 ?? {}).flatMap(([nodeId, metric]) => {
    const name = value.modelSnapshot?.nodes.find((node) => node.id === nodeId)?.name ?? nodeId;
    const rows = [
      intervalRow("node", nodeId, name, "utilization", "ratio", metric.utilization),
      intervalRow("node", nodeId, name, "average_queue_length", "item", metric.averageQueueLength),
      intervalRow("node", nodeId, name, "blocked_time", "minute", metric.blockedMinutes),
      intervalRow("node", nodeId, name, "starved_time", "minute", metric.starvedMinutes),
    ];
    if (metric.changeoverCount) rows.push(intervalRow("node", nodeId, name, "changeover_count", "count", metric.changeoverCount));
    if (metric.changeoverMinutes) rows.push(intervalRow("node", nodeId, name, "changeover_time", "minute", metric.changeoverMinutes));
    return rows;
  });
}

function resourceRows(value: PlantLiteEvidencePackage): MetricRow[] {
  const rows = sortedEntries(value.statistics.resourceUtilization95).map(([id, interval]) => {
    const name = value.modelSnapshot?.resources?.find((item) => item.id === id)?.name ?? id;
    return intervalRow("resource", id, name, "utilization", "ratio", interval);
  });
  for (const [id, interval] of sortedEntries(value.statistics.resourceFailedMinutes95 ?? {})) {
    const name = value.modelSnapshot?.resources?.find((item) => item.id === id)?.name ?? id;
    rows.push(intervalRow("resource", id, name, "failed_capacity_time", "resource-minute", interval));
  }
  return rows;
}

function productRows(value: PlantLiteEvidencePackage): MetricRow[] {
  return sortedEntries(value.statistics.productTypeMetrics95 ?? {}).flatMap(([id, metric]) => {
    const name = value.modelSnapshot?.productTypes?.find((item) => item.id === id)?.name ?? id;
    return [
      intervalRow("product", id, name, "completed_items", "item", metric.completedItems),
      intervalRow("product", id, name, "completion_share", "ratio", metric.completionShare),
      intervalRow("product", id, name, "throughput_per_hour", "item/hour", metric.throughputPerHour),
    ];
  });
}

function productionOrderRows(value: PlantLiteEvidencePackage): MetricRow[] {
  return sortedEntries(value.statistics.productionOrderMetrics95 ?? {}).flatMap(([id, metric]) => {
    const name = value.modelSnapshot?.productionOrders?.find((item) => item.id === id)?.name ?? id;
    return [
      intervalRow("production-order", id, name, "completed_items", "item", metric.completedItems),
      intervalRow("production-order", id, name, "completion_rate", "ratio", metric.completionRate),
      intervalRow("production-order", id, name, "on_time_fulfillment_rate", "ratio", metric.onTimeFulfillmentRate),
      intervalRow("production-order", id, name, "fully_completed_rate", "ratio", metric.fullyCompletedRate),
      intervalRow("production-order", id, name, "observed_tardiness", "minute", metric.observedTardinessMinutes),
    ];
  });
}

function changeoverRows(value: PlantLiteEvidencePackage): MetricRow[] {
  return [...value.statistics.changeovers.configuredRules]
    .sort((left, right) => `${left.stationId}:${left.fromProductTypeId}:${left.toProductTypeId}`.localeCompare(`${right.stationId}:${right.fromProductTypeId}:${right.toProductTypeId}`, "en"))
    .map((rule) => scalarRow(
      "changeover",
      `${rule.stationId}:${rule.fromProductTypeId}->${rule.toProductTypeId}`,
      rule.stationName,
      "configured_changeover_time",
      "minute",
      rule.minutes,
      "configured-input",
    ));
}

function qualityRows(value: PlantLiteEvidencePackage): MetricRow[] {
  const quality = value.statistics.quality;
  const rows = quality.configuredStations.map((station) => scalarRow(
    "quality-config", station.stationId, station.stationName, "configured_yield_rate", "ratio",
    station.yieldRate, "configured-input",
  ));
  if (!quality.metrics95) return rows;
  rows.push(
    intervalRow("quality-system", "study-total", value.lineage.study.name, "good_output_items", "item", quality.metrics95.goodOutputItems),
    intervalRow("quality-system", "study-total", value.lineage.study.name, "scrap_items", "item", quality.metrics95.scrapItems),
    intervalRow("quality-system", "study-total", value.lineage.study.name, "first_pass_yield", "ratio", quality.metrics95.firstPassYield),
  );
  for (const [nodeId, metric] of sortedEntries(quality.metrics95.stationMetrics95)) {
    const name = value.modelSnapshot?.nodes.find((node) => node.id === nodeId)?.name ?? nodeId;
    rows.push(
      intervalRow("quality-station", nodeId, name, "inspected_items", "item", metric.inspectedItems),
      intervalRow("quality-station", nodeId, name, "good_items", "item", metric.goodItems),
      intervalRow("quality-station", nodeId, name, "scrap_items", "item", metric.scrapItems),
      intervalRow("quality-station", nodeId, name, "first_pass_yield", "ratio", metric.firstPassYield),
    );
  }
  return rows;
}

function energyRows(value: PlantLiteEvidencePackage): MetricRow[] {
  const energy = value.statistics.energy;
  if (!energy) return [];
  const entries: Array<[string, string, PlantLiteConfidenceInterval]> = [
    ["active_energy", "kWh", energy.activeEnergyKwh],
    ["idle_energy", "kWh", energy.idleEnergyKwh],
    ["total_energy", "kWh", energy.totalEnergyKwh],
    ["energy_per_completed_item", "kWh/item", energy.energyPerCompletedItemKwh],
    ["electricity_cost", "CNY", energy.electricityCost],
    ["electricity_cost_per_completed_item", "CNY/item", energy.electricityCostPerCompletedItem],
    ["carbon_emission", "kgCO2e", energy.carbonEmissionKg],
    ["carbon_emission_per_completed_item", "kgCO2e/item", energy.carbonEmissionPerCompletedItemKg],
    ["peak_demand", "kW", energy.peakDemandKw],
  ];
  const rows = entries.map(([metric, unit, interval]) => intervalRow("energy", "study-total", value.lineage.study.name, metric, unit, interval));
  for (const [id, interval] of sortedEntries(energy.consumerEnergyKwh)) {
    const name = value.modelSnapshot?.resources?.find((item) => item.id === id)?.name
      ?? value.modelSnapshot?.nodes.find((item) => item.id === id)?.name
      ?? id;
    rows.push(intervalRow("energy-consumer", id, name, "total_energy", "kWh", interval));
  }
  return rows;
}

function bottleneckRows(value: PlantLiteEvidencePackage): MetricRow[] {
  return [...value.statistics.bottlenecks]
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId, "en"))
    .flatMap((item) => {
      const name = value.modelSnapshot?.nodes.find((node) => node.id === item.nodeId)?.name ?? item.nodeId;
      return [
        scalarRow("bottleneck", item.nodeId, name, "occurrences", "count", item.occurrences, "replication-frequency"),
        scalarRow("bottleneck", item.nodeId, name, "probability", "ratio", item.probability, "replication-frequency"),
      ];
    });
}

function traceRows(value: PlantLiteEvidencePackage): MetricRow[] {
  const integrity = value.trace.integrity;
  return [
    scalarRow("trace", "representative-replication", "代表性重复轨迹", "integrity_status", "", integrity.status, "bounded-capture"),
    scalarRow("trace", "representative-replication", "代表性重复轨迹", "captured_event_count", "count", integrity.capturedEventCount, "bounded-capture"),
    scalarRow("trace", "representative-replication", "代表性重复轨迹", "captured_item_count", "count", integrity.capturedItemCount, "bounded-capture"),
    scalarRow("trace", "representative-replication", "代表性重复轨迹", "omitted_event_count", "count", integrity.omittedEventCount, "bounded-capture"),
  ];
}

function intervalRow(category: string, entityId: string, entityName: string, metric: string, unit: string, interval: PlantLiteConfidenceInterval): MetricRow {
  return { category, entityId, entityName, metric, unit, mean: interval.mean, sampleStandardDeviation: interval.sampleStandardDeviation, lower95: interval.lower95, upper95: interval.upper95, samples: interval.samples, evidenceStatus: "statistical-95-ci" };
}

function scalarRow(category: string, entityId: string, entityName: string, metric: string, unit: string, value: string | number | boolean, evidenceStatus: string): MetricRow {
  return { category, entityId, entityName, metric, unit, value, evidenceStatus };
}

function sortedEntries<T>(value: Record<string, T>): Array<[string, T]> {
  return Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en"));
}

function csvCell(value: unknown): string {
  const raw = String(value ?? "");
  // Excel 等表格工具会把这些前缀解释为公式；数值类型保持原始负号，文本统一显式转义。
  const text = typeof value === "string" && (/^[=+\-@\t\r]/.test(raw) || /^\s+[=+\-@]/.test(raw)) ? `'${raw}` : raw;
  return /[\t",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
