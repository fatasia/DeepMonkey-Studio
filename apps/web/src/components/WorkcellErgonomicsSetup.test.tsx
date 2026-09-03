import type { WorkcellAuditObject, WorkcellErgonomicsProfile } from "@bim-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { appendErgonomicsProfile, removeErgonomicsProfile, WorkcellErgonomicsSetup } from "./WorkcellErgonomicsSetup";

describe("WorkcellErgonomicsSetup", () => {
  it("keeps the module visible with a clear empty state when no person was detected", () => {
    const html = renderToStaticMarkup(<WorkcellErgonomicsSetup
      profiles={[]} operatorOptions={[]} objects={[]}
      resultVisible={false} disabled={false} onChange={vi.fn()}
    />);

    expect(html).toContain("人工作业规划筛查");
    expect(html).toContain("场景中尚未确认人工作业");
    expect(html).toContain("添加人工作业");
    expect(html).toContain("不会自动把设备当作人员");
  });

  it("adds an unconfirmed needs-data profile without inventing an operator or measurements", () => {
    const first = appendErgonomicsProfile([]);
    const second = appendErgonomicsProfile(first);

    expect(first).toEqual([{ id: "human-task-1", name: "人工作业 1" }]);
    expect(second[1]).toEqual({ id: "human-task-2", name: "人工作业 2" });
    expect(second[1]).not.toHaveProperty("operatorObjectId");
    expect(second[1]).not.toHaveProperty("anthropometry");
    expect(second[1]).not.toHaveProperty("task");
    expect(second[1]).not.toHaveProperty("policy");
  });

  it("removes only the requested profile and supports returning to the empty state", () => {
    const profiles = appendErgonomicsProfile(appendErgonomicsProfile([]));
    expect(removeErgonomicsProfile(profiles, "human-task-1")).toEqual([{ id: "human-task-2", name: "人工作业 2" }]);
    expect(removeErgonomicsProfile(profiles.slice(0, 1), "human-task-1")).toEqual([]);
  });

  it("exposes the complete planning input sequence without inferred human measurements", () => {
    const objects: WorkcellAuditObject[] = [
      { id: "person-1", name: "装配人员", role: "equipment", position: { x: 0, y: 0, z: 0 } },
      { id: "station-1", name: "装配点", role: "target", position: { x: .4, y: 1.1, z: 0 } },
    ];
    const profiles: WorkcellErgonomicsProfile[] = [{ id: "task-1", name: "装配人员 · 人工作业", operatorObjectId: "person-1", anthropometry: { method: "percentile" } }];
    const html = renderToStaticMarkup(<WorkcellErgonomicsSetup
      profiles={profiles} operatorOptions={objects} objects={objects}
      resultVisible={false} disabled={false} onChange={vi.fn()}
    />);

    expect(html).toContain("人体数据");
    expect(html).toContain("身高百分位");
    expect(html).toContain("功能可达距离");
    expect(html).toContain("作业点世界坐标");
    expect(html).toContain("单次负荷");
    expect(html).toContain("搬运频次");
    expect(html).toContain("项目筛查策略");
    expect(html).toContain("装配点 · 目标");
    expect(html).toContain("不自动推断人体尺寸");
    expect(html).not.toMatch(/value="(?:0|1\.7|50)"/);
  });
});
