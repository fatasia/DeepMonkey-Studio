import type { PlantLiteStudyRecord } from "@bim-studio/contracts";
import { Download, FileSpreadsheet, PackageCheck } from "lucide-react";
import { useState } from "react";
import { downloadTextFile } from "../browserDownload";
import {
  buildPlantLiteEvidencePackage,
  plantLiteEvidenceFileStem,
  serializePlantLiteEvidencePackage,
} from "./plantLiteEvidenceExport";
import { plantLiteEvidenceMetricsCsv } from "./plantLiteEvidenceExportCsv";
import "./PlantLiteEvidenceExportActions.css";

export function PlantLiteEvidenceExportActions({ study, baseline }: {
  study: PlantLiteStudyRecord;
  baseline?: PlantLiteStudyRecord;
}) {
  const [status, setStatus] = useState("");
  const missing = [
    !study.model && "模型快照",
    !study.outcome.nodeMetrics95 && "节点区间",
    !study.trace && "代表性轨迹",
  ].filter((item): item is string => Boolean(item));

  function createPackage() {
    return buildPlantLiteEvidencePackage(study, baseline);
  }

  function downloadJson() {
    try {
      const evidence = createPackage();
      downloadTextFile(
        serializePlantLiteEvidencePackage(evidence),
        `${plantLiteEvidenceFileStem(evidence)}.json`,
        "application/json;charset=utf-8",
      );
      setStatus("JSON 证据包已下载");
    } catch (error) {
      setStatus(exportError(error));
    }
  }

  function downloadCsv() {
    try {
      const evidence = createPackage();
      downloadTextFile(
        plantLiteEvidenceMetricsCsv(evidence),
        `${plantLiteEvidenceFileStem(evidence)}-metrics.csv`,
        "text/csv;charset=utf-8",
      );
      setStatus("CSV 指标已下载");
    } catch (error) {
      setStatus(exportError(error));
    }
  }

  return <section className="plant-evidence-export-actions" aria-label="工程证据包导出">
    <span className="plant-evidence-export-summary">
      <PackageCheck size={14} />
      <span>
        <strong>工程证据包</strong>
        <small>{missing.length ? `旧记录可导出 · 缺少${missing.join("、")}` : `模型、统计与${study.trace?.truncated ? "截断" : "有界"}轨迹已就绪`}</small>
      </span>
    </span>
    <div>
      <button type="button" onClick={downloadJson} title="导出可复现输入、统计区间、谱系、轨迹完整性与能力边界">
        <Download size={13} />证据包 JSON
      </button>
      <button type="button" onClick={downloadCsv} title="导出带 UTF-8 BOM 且防公式注入的可比较指标表">
        <FileSpreadsheet size={13} />指标 CSV
      </button>
    </div>
    <small className="plant-evidence-export-status" role="status" aria-live="polite">
      {status || (baseline ? `含基线谱系 · ${baseline.name}` : "未选择基线，仅导出当前 Study 谱系")}
    </small>
  </section>;
}

function exportError(error: unknown): string {
  return error instanceof Error ? `导出失败：${error.message}` : "导出失败：未知错误";
}
