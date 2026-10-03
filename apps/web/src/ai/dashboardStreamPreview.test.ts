import { describe, expect, it } from "vitest";
import { parseDashboardStreamPreview } from "./dashboardStreamPreview";

describe("H-C5-T7 dashboard 流式布局预览解析", () => {
  it("完整流:逐 widget 提取标题与类型集合,保序去重", () => {
    const raw = `{"pageId":"p1","widgets":[{"type":"chart.line","title":"产线温度"},{"type":"kpi","title":"OEE"},{"type":"chart.line","title":"能耗"}]}`;
    const preview = parseDashboardStreamPreview(raw);
    expect(preview.labels).toEqual(["产线温度", "OEE", "能耗"]);
    expect(preview.types).toEqual(["chart.line", "kpi"]);
    expect(preview.inProgress).toBe(true);
  });

  it("截断流:半截对象忽略,已闭合的收录;无标题回落类型", () => {
    const raw = `{"widgets":[{"type":"kpi","title":"良品率"},{"type":"gauge","title":"温`;
    const preview = parseDashboardStreamPreview(raw);
    expect(preview.labels).toEqual(["良品率"]);
    expect(preview.types).toEqual(["kpi"]);
  });

  it("无标题只有类型:回落类型作标签;字符串内的括号不破坏扫描", () => {
    const raw = `{"widgets":[{"type":"table","title":"含 } 与 \\" 引号的标题"},{"type":"map"}],"x":1}`;
    const preview = parseDashboardStreamPreview(raw);
    expect(preview.labels).toEqual(['含 } 与 " 引号的标题', "map"]);
    expect(preview.types).toEqual(["table", "map"]);
  });

  it("纯文本流(无 widgets 结构):零预览零误报", () => {
    const preview = parseDashboardStreamPreview(`好的，我来为您生成产线监控大屏。`);
    expect(preview.labels).toEqual([]);
    expect(preview.types).toEqual([]);
    expect(preview.inProgress).toBe(false);
  });

  it("顶层直接是 widgets 数组文本的形态也可解析", () => {
    const raw = `[{"type":"kpi","title":"直通率"}]`;
    const preview = parseDashboardStreamPreview(raw);
    expect(preview.labels).toEqual(["直通率"]);
    expect(preview.inProgress).toBe(true);
  });
});
