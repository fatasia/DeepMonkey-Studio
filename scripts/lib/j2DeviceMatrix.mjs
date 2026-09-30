/**
 * J2-B4 多物理设备矩阵 —— CPU 侧骨架（声明校验 + 矩阵展开 + 证据校验），无 GPU 依赖。
 *
 * 职责边界（对齐 j2-csm-timing 既有证据口径）：
 * - 矩阵 fixture 声明"物理设备行 × API 宿主"；展开按 timing plan 生成每格的期望结构；
 * - 证据校验只做纯 CPU 判定：身份一致、样本完整性、正确性阈值、矩阵完整性；
 * - GPU 实跑（Chrome/`cargo test --ignored`）由主线程串行执行，本文件不启动任何进程；
 * - 单机双 API 宿主（WebGPU + wgpu/Vulkan）按声明归入同一设备行，不得据此宣称跨设备完成。
 */

export const DEVICE_MATRIX_SCHEMA = "deep-engine.j2-b4-device-matrix.v1";
const CSM_FAMILIES = ["ts-built-in", "ts-deepsl-package", "native-production-wgsl"];
const CORRECTNESS_MAX_ERROR = 2e-6;

/** 校验矩阵 fixture 形状；非法即抛错（不猜、不静默降级）。 */
export function parseDeviceMatrix(matrix) {
  if (!matrix || matrix.schema !== DEVICE_MATRIX_SCHEMA) throw Error("Device matrix schema mismatch");
  if (!Array.isArray(matrix.hosts) || !matrix.hosts.length) throw Error("Device matrix hosts must not be empty");
  if (!Array.isArray(matrix.families) || matrix.families.length !== CSM_FAMILIES.length
    || !CSM_FAMILIES.every(family => matrix.families.includes(family)))
    throw Error("Device matrix must declare the three CSM sampling families");
  const hostIds = new Set();
  for (const host of matrix.hosts) {
    if (!host?.id || hostIds.has(host.id)) throw Error(`Device matrix host id invalid or duplicated: ${String(host?.id)}`);
    if (!Array.isArray(host.backendTokens) || !host.backendTokens.length) throw Error(`Host ${host.id} lacks backend tokens`);
    if (!Array.isArray(host.identityFields) || !host.identityFields.length) throw Error(`Host ${host.id} lacks identity fields`);
    hostIds.add(host.id);
  }
  if (!Array.isArray(matrix.devices) || !matrix.devices.length) throw Error("Device matrix must declare at least one device row");
  const deviceIds = new Set();
  for (const device of matrix.devices) {
    if (!device?.id || deviceIds.has(device.id)) throw Error(`Device row id invalid or duplicated: ${String(device?.id)}`);
    if (!device.declared || typeof device.declared !== "object") throw Error(`Device ${device.id} lacks declared identity`);
    if (!device.declared.vendor) throw Error(`Device ${device.id} must declare vendor`);
    if (!Array.isArray(device.hosts) || !device.hosts.length) throw Error(`Device ${device.id} must cover at least one host`);
    for (const host of device.hosts) if (!hostIds.has(host)) throw Error(`Device ${device.id} references unknown host ${String(host)}`);
    deviceIds.add(device.id);
  }
  return matrix;
}

/** 矩阵展开：每行 × 该行宿主 → 期望证据格（样本量/窗口/点数来自 timing plan）。 */
export function expandDeviceMatrix(matrix, plan) {
  parseDeviceMatrix(matrix);
  if (!plan || !Array.isArray(plan.cases) || !plan.cases.length) throw Error("Timing plan cases missing");
  if (!Number.isSafeInteger(plan.pairedRounds) || plan.pairedRounds < 5) throw Error("Timing plan needs at least five paired windows");
  if (!Number.isSafeInteger(plan.sampleFrames) || plan.sampleFrames < 1) throw Error("Timing plan sample frames missing");
  const cells = [];
  for (const device of matrix.devices) {
    for (const hostId of device.hosts) {
      const host = matrix.hosts.find(entry => entry.id === hostId);
      cells.push({
        rowId: device.id, host: hostId, api: host.api, backendTokens: host.backendTokens,
        declared: device.declared,
        expect: {
          families: matrix.families,
          cases: plan.cases.length,
          caseIds: plan.cases.map(item => item.id),
          pointsPerSample: 21,
          pairedWindows: plan.pairedRounds,
          sampleFramesPerWindow: plan.sampleFrames,
        },
      });
    }
  }
  return Object.freeze({ schema: DEVICE_MATRIX_SCHEMA, cells,
    scope: "same-physical-device-per-row-two-API-hosts-CSM-receiver-function-timing" });
}

/** 从 wgpu `AdapterInfo` 调试串提取结构化身份；解析不出 name 时返回 undefined 交由校验拒绝。 */
export function parseNativeAdapterInfo(text) {
  if (typeof text !== "string") return undefined;
  const match = key => text.match(new RegExp(`${key}: ("?)([^,}]+)\\1`))?.[2]?.trim();
  const name = match("name");
  if (!name) return undefined;
  return { name, vendor: match("vendor"), device: match("device"), deviceType: match("device_type"),
    pciBus: match("device_pci_bus_id"), driver: match("driver"), driverInfo: match("driver_info"),
    backend: match("backend") };
}

function adapterIdentity(host, receipt) {
  const adapter = host.startsWith("native") ? parseNativeAdapterInfo(receipt.adapter) : receipt.adapter;
  if (!adapter || typeof adapter !== "object") return { error: "adapter identity missing or unparseable" };
  return { adapter };
}

function cellReasons(receipt, cell, identity) {
  if (!receipt) return ["receipt missing"];
  if (receipt.status === "unavailable") return [`unavailable: ${receipt.reason ?? "unstated"}`];
  if (receipt.status !== "measured") return [`unknown receipt status ${String(receipt.status)}`];
  const reasons = [];
  const { adapter, error } = adapterIdentity(cell.host, receipt);
  if (error) return [error];
  if (adapter.isFallbackAdapter === true) reasons.push("fallback adapter rejected as software rendering");
  if (cell.host.startsWith("native")) {
    if (!cell.backendTokens.includes(adapter.backend)) reasons.push(`backend ${String(adapter.backend)} does not match host tokens ${cell.backendTokens.join("/")}`);
    if (!adapter.name || !adapter.pciBus) reasons.push("native adapter identity incomplete (name/pciBus)");
  } else {
    if (String(adapter.vendor ?? "").toLowerCase() !== String(cell.declared.vendor).toLowerCase())
      reasons.push(`adapter vendor ${String(adapter.vendor)} does not match declared ${cell.declared.vendor}`);
    if (cell.declared.architecture && String(adapter.architecture ?? "").toLowerCase() !== String(cell.declared.architecture).toLowerCase())
      reasons.push(`adapter architecture ${String(adapter.architecture)} does not match declared ${cell.declared.architecture}`);
  }
  if (receipt.fixtureHash !== identity.fixtureHash) reasons.push("fixture identity changed");
  if (receipt.planHash !== identity.planHash) reasons.push("plan identity changed");
  if (receipt.errors?.length) reasons.push(`host errors: ${receipt.errors.length}`);
  if (receipt.passed !== true) reasons.push("host correctness not passed");
  if (receipt.results?.length !== cell.expect.cases) reasons.push(`case matrix changed (${receipt.results?.length ?? 0} != ${cell.expect.cases})`);
  else for (const result of receipt.results) {
    if (!cell.expect.caseIds.includes(result.id)) { reasons.push(`unexpected case ${result.id}`); break; }
    for (const variant of ["reference", "candidate"]) {
      const item = result.correctness?.find(entry => entry.id === variant);
      if (!item || item.values?.length !== cell.expect.pointsPerSample
        || !Number.isFinite(item.maxError) || item.maxError > CORRECTNESS_MAX_ERROR) {
        reasons.push(`case ${result.id} ${variant} correctness invalid`); break;
      }
    }
    if (reasons.length) break;
    if (result.pairs?.length !== cell.expect.pairedWindows) { reasons.push(`case ${result.id} paired windows incomplete`); break; }
    for (const pair of result.pairs) {
      for (const variant of ["reference", "candidate"]) {
        const channel = pair[variant]?.channels?.find(entry => entry.channel === "gpu-timestamp");
        if (!channel || channel.availability !== "measured" || channel.sampleCount !== cell.expect.sampleFramesPerWindow
          || channel.samplesMs.some(value => !Number.isFinite(value) || value <= 0)) {
          reasons.push(`case ${result.id} timing window incomplete or zero quantization`); break;
        }
      }
      if (reasons.length) break;
    }
    if (reasons.length) break;
  }
  return reasons;
}

/**
 * 证据校验（纯 CPU）：receipts = [{rowId, host, status, reason?, adapter?, fixtureHash?, planHash?, passed?, errors?, results?}]。
 * 行完成 = 该行全部声明宿主均 measured；矩阵完成 = 全部声明行完成。
 * 同机双 API 宿主归同一行：countedPhysicalDevices 按 receipt 实际身份去重，不被同机双宿主灌水。
 */
export function validateDeviceMatrixEvidence(matrix, plan, identity, receipts) {
  const cells = expandDeviceMatrix(matrix, plan).cells;
  if (!identity?.fixtureHash || !identity?.planHash) throw Error("Matrix evidence identity missing");
  const cellReceipts = new Map();
  for (const receipt of receipts ?? []) {
    const key = `${receipt.rowId}\n${receipt.host}`;
    if (cellReceipts.has(key)) throw Error(`Duplicate receipt for ${String(receipt.rowId)}/${String(receipt.host)}`);
    const device = matrix.devices.find(entry => entry.id === receipt.rowId);
    if (!device) throw Error(`Receipt references undeclared device row ${String(receipt.rowId)}`);
    if (!device.hosts.includes(receipt.host)) throw Error(`Receipt host ${String(receipt.host)} not covered by row ${receipt.rowId}`);
    cellReceipts.set(key, receipt);
  }
  const rows = matrix.devices.map(device => {
    const rowCells = cells.filter(cell => cell.rowId === device.id);
    const hostStatus = {};
    const reasons = [];
    for (const cell of rowCells) {
      const found = cellReasons(cellReceipts.get(`${cell.rowId}\n${cell.host}`), cell, identity);
      const missing = found.length === 1 && found[0] === "receipt missing";
      hostStatus[cell.host] = found.length ? (missing ? "missing" : "invalid") : "measured";
      for (const reason of found) reasons.push(`${cell.host}: ${reason}`);
    }
    const statuses = Object.values(hostStatus);
    return { rowId: device.id,
      status: statuses.every(status => status === "measured") ? "measured"
        : (statuses.includes("invalid") ? "invalid" : "missing"),
      hosts: hostStatus, reasons };
  });
  // 物理身份只能按宿主命名空间去重：native = name@pciBus；web = vendor/architecture。
  // CPU 无法跨 API 证明两宿主同物理设备——同机双宿主归同一设备行是声明事实，不是推导事实。
  const nativeKeys = new Set(), webKeys = new Set();
  for (const receipt of cellReceipts.values()) {
    const { adapter, error } = adapterIdentity(receipt.host, receipt);
    if (error) continue;
    (receipt.host.startsWith("native") ? nativeKeys : webKeys)
      .add(receipt.host.startsWith("native")
        ? `${adapter.name}@${adapter.pciBus ?? "?"}`
        : `${String(adapter.vendor ?? "?").toLowerCase()}/${String(adapter.architecture ?? "?").toLowerCase()}`);
  }
  return {
    matrixComplete: rows.every(row => row.status === "measured"),
    rows,
    physicalIdentity: { nativeKeys: [...nativeKeys], webKeys: [...webKeys],
      note: "cross-API physical identity is declared per row, not CPU-provable" },
    countedDeviceRows: rows.filter(row => row.status === "measured").length,
    declaredDeviceRows: rows.length,
    scope: "multi-physical-device CSM receiver function timing matrix",
    excluded: ["full production frame FPS", "shadow-map draw timing", "claiming cross-device completion from one physical GPU"],
  };
}
