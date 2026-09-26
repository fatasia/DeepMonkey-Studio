/**
 * ps-schema-probe CLI 测试夹具：模拟 CLI 的 --json 输出契约，
 * 让 Node 桥与 conversion 三档接线在无真实二进制/copyright catalog 的环境可测。
 * 环境开关：
 * - PROBE_MOCK_FAILURE=1 → 以退出码 1 失败（验证回落语义）；
 * - PROBE_MOCK_FACES=N → 覆盖 brep.faces（默认 153，对齐 AS-2059 真实样本实测）。
 */
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const file = option("file");
if (!file) {
  console.error("mock: missing --file");
  process.exit(2);
}
if (process.env.PROBE_MOCK_FAILURE === "1") {
  console.error("mock: injected probe failure");
  process.exit(1);
}

const isXb = file.endsWith(".x_b");
const wantsBrep = args.includes("--brep");
const faces = Number(process.env.PROBE_MOCK_FACES ?? 153);
const report = {
  tool: "ps-schema-probe",
  version: "0.0.0-mock",
  sourceFormat: isXb ? "x_b" : "x_t",
  mode: "census",
  fileSize: 1234,
  schemaKey: isXb ? "SCH_3000000_30000" : "SCH_2100263_20000_13006",
  modellerVersion: ": TRANSMIT FILE created by modeller version mock",
  note: "census 模式（未提供 schema catalog）：仅头部结构验证；trim 拓扑未解码",
};
if (wantsBrep) {
  delete report.note;
  report.mode = "schema-aware";
  report.catalog = { schemaId: "13006", modellerVersion: "1300120", definitionCount: 142 };
  report.census = { recordCount: 2998, nodeTypeCounts: { "14": 153, "17": 694, "82": 7 } };
  report.brep = {
    complete: true,
    bodies: 2,
    regions: 4,
    shells: 4,
    faces,
    loops: 185,
    halfEdges: 694,
    edges: 347,
    vertices: 194,
    points: 194,
    curves: 353,
    surfaces: 159,
    surfaceKinds: { cylinder: 77, plane: 26, torus: 40 },
    boundingBox: { min: [-0.03, -0.005, -0.019], max: [0.03, 0.0015, 0.019] },
    diagnostics: 0,
    topologyValid: true,
    eulerCharacteristic: 0,
  };
}
process.stdout.write(JSON.stringify(report));
