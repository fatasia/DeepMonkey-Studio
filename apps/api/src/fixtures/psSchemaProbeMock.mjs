/**
 * ps-schema-probe CLI 测试夹具：模拟 CLI 的 --json 输出契约，
 * 让 Node 桥与 conversion 三档接线在无真实二进制/copyright catalog 的环境可测。
 * 环境开关：
 * - PROBE_MOCK_FAILURE=1 → 以退出码 1 失败（验证回落语义）；
 * - PROBE_MOCK_FACES=N → 覆盖 brep.faces（默认 153，对齐 AS-2059 真实样本实测）；
 * - PROBE_MOCK_GEOMETRY=1 → 收到 --geometry 时输出 faces（默认不输出，
 *   模拟旧版 CLI,让 waiting 语义回归保持逐字节不变）；
 * - PROBE_MOCK_GEOMETRY_FACES=N → 几何导出的面数（默认 4）。
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
const wantsGeometry = args.includes("--geometry");
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
if (wantsBrep || wantsGeometry) {
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
if (wantsGeometry && process.env.PROBE_MOCK_GEOMETRY === "1") {
  const geometryFaces = Number(process.env.PROBE_MOCK_GEOMETRY_FACES ?? 4);
  report.geometry = {
    faces: Array.from({ length: geometryFaces }, (_, index) => {
      const offset = index * 0.1;
      return {
        id: index,
        body: index % 2,
        surfaceKind: index % 2 === 0 ? "plane" : "cylinder",
        positions: [
          0 + offset, 0, 0,
          1 + offset, 0, 0,
          0.5 + offset, 1, 0,
        ],
        indices: [0, 1, 2],
        approximations: index === 0 ? ["trim.unresolved:intersection"] : [],
      };
    }),
    losses: ["surface.blended_edge:not-triangulated"],
    approximations: ["geometry.tessellation:angular-64-segments"],
    skipped: [{ id: 99, surfaceKind: "blended_edge", reason: "surface-family-unsupported:blended_edge" }],
    stats: {
      facesTotal: faces,
      facesPublished: geometryFaces,
      facesSkipped: 1,
      vertices: geometryFaces * 3,
      triangles: geometryFaces,
    },
    budgetExceeded: false,
  };
}
process.stdout.write(JSON.stringify(report));
