import fs from "node:fs";

const ev = JSON.parse(fs.readFileSync("test-output/industrial-rvt-holdout-20260919/evidence.json", "utf8"));
import { createHash } from "node:crypto";
const shaSync = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const pick = ["racbasicsampleproject", "rmebasicsampleproject", "rstbasicsampleproject"];
const samples = pick.map((name) => {
  const r = ev.results.find((x) => x.sourcePath.replaceAll("\\", "/").endsWith(`${name}.rvt`));
  if (!r) throw new Error(`missing result for ${name}`);
  return {
    source: `test-model/${name}.rvt`,
    sha256: r.sourceSha256,
    bytes: r.sourceBytes,
    version: r.version,
    status: r.status,
    declaredElementIds: r.statistics.declaredElementIds,
    strictMaterialNameCount: r.statistics.strictMaterialNameCount,
    levelDistinctNames: r.statistics.levelDistinctNames,
  };
});
const bimSha = shaSync("test-model/B示例模型.rvt");
const report = {
  schema: "deep-engine.industrial-rvt-holdout.v1",
  generatedAt: new Date().toISOString(),
  purpose: "S5 RVT profile 独立保留集（与既有 26 份绑定证据所用语料不重叠）",
  samples,
  excluded: [
    {
      source: "test-model/B示例模型.rvt",
      sha256: bimSha,
      reason: "SHA-256 与 asset.bim.bimface-demo-1（8087a360…）完全一致，同文件改名，不构成独立样本",
    },
  ],
  findings: {
    versionCoverageGap: "3 个独立 RVT 2026 样本全部 fail-closed（unsupported-version）；读取器已证明布局上限 2024，fail-closed 行为正确，未伪造解析",
    containerLevelFacts: "容器级统计照实拿到（声明元素/严格材质名/楼层名），与 ⑧ 车道 BIMFACE/Snowdon 同口径",
    holdoutValidity: "独立样本 3/4（1 个剔重）；双跑确定性由 audit 工具链强制",
  },
  evidenceBoundary: "本保留集只证明版本覆盖缺口与容器级事实，不构成 RVT profile 生产化认证",
  upstreamEvidence: "同目录 evidence.json（rvt-rs 构建+单测+双跑确定性）",
};
fs.writeFileSync("test-output/industrial-rvt-holdout-20260919/holdout-report.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ samples: samples.length, excluded: report.excluded.length, versions: samples.map((s) => s.version) }, null, 1));
