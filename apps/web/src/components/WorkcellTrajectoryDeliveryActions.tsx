import type { WorkcellRobotTrajectory, WorkcellTrajectoryAnalysis } from "@bim-studio/contracts";
import { Download, Table2 } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { downloadTextFile } from "../browserDownload";
import {
  buildWorkcellTrajectoryDelivery,
  inspectWorkcellTrajectoryDelivery,
  serializeWorkcellTrajectoryDelivery,
  workcellTrajectoryDeliveryCsv,
  workcellTrajectoryDeliveryFileStem,
} from "./workcellTrajectoryDelivery";

export function WorkcellTrajectoryDeliveryActions({ analysis, trajectories }: {
  analysis: WorkcellTrajectoryAnalysis;
  trajectories: readonly WorkcellRobotTrajectory[];
}) {
  const readiness = useMemo(
    () => inspectWorkcellTrajectoryDelivery(trajectories, analysis),
    [analysis, trajectories],
  );
  const [status, setStatus] = useState("");
  const unavailableReasonId = useId();

  if (!readiness.ready) {
    return <span className="workcell-trajectory-delivery-unavailable" role="status">
      <span aria-describedby={readiness.reason ? unavailableReasonId : undefined}>交付包不可用</span>
      {readiness.reason && <span id={unavailableReasonId} className="workcell-trajectory-delivery-unavailable-reason">
        {readiness.reason}
      </span>}
    </span>;
  }

  function createPackage() {
    return buildWorkcellTrajectoryDelivery(trajectories, analysis);
  }
  function downloadJson() {
    const delivery = createPackage();
    downloadTextFile(
      serializeWorkcellTrajectoryDelivery(delivery),
      `${workcellTrajectoryDeliveryFileStem(delivery)}.json`,
      "application/json;charset=utf-8",
    );
    setStatus("JSON 已下载");
  }
  function downloadCsv() {
    const delivery = createPackage();
    downloadTextFile(
      workcellTrajectoryDeliveryCsv(delivery),
      `${workcellTrajectoryDeliveryFileStem(delivery)}-keyframes.csv`,
      "text/csv;charset=utf-8",
    );
    setStatus("CSV 已下载");
  }

  return <div className="workcell-trajectory-delivery-actions">
    <span role="status">
      {status || `可交付 · ${readiness.compatibleTrajectoryIds.length} 条轨迹 · ${readiness.waypointCount} 帧`}
    </span>
    <button type="button" onClick={downloadJson} title="导出供应商中立的轨迹输入、风险、节拍与调度证据">
      <Download size={13} />交付包 JSON
    </button>
    <button type="button" onClick={downloadCsv} title="导出真实输入关键帧与关节角 CSV">
      <Table2 size={13} />关键帧 CSV
    </button>
  </div>;
}
