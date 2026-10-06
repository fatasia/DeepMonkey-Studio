import { describe, expect, it } from "vitest";
import { disambiguatedProjectLabels } from "./projectNameDisambiguation";

describe("disambiguatedProjectLabels (F10 项目下拉重名消歧)", () => {
  it("keeps unique project names untouched", () => {
    const labels = disambiguatedProjectLabels([
      { id: "a", name: "项目甲", createdAt: "2026-09-01T00:00:00.000Z" },
      { id: "b", name: "项目乙", createdAt: "2026-09-02T00:00:00.000Z" },
    ]);
    expect(labels.get("a")).toBe("项目甲");
    expect(labels.get("b")).toBe("项目乙");
  });

  it("suffixes duplicate names with their creation date", () => {
    const labels = disambiguatedProjectLabels([
      { id: "a", name: "交付验收", createdAt: "2026-09-09T02:00:00.000Z" },
      { id: "b", name: "交付验收", createdAt: "2026-09-10T02:00:00.000Z" },
    ]);
    // 本地时区渲染：同一天偏移下两个日期各自可辨即可，断言包含各自日期成分。
    expect(labels.get("a")).not.toBe(labels.get("b"));
    expect(labels.get("a")).toMatch(/^交付验收（\d{4}-\d{2}-\d{2}）$/u);
    expect(labels.get("b")).toMatch(/^交付验收（\d{4}-\d{2}-\d{2}）$/u);
  });

  it("falls back to the id tail when createdAt is missing or unparseable", () => {
    const labels = disambiguatedProjectLabels([
      { id: "project-abcd", name: "重名项目", createdAt: "" },
      { id: "project-ef01", name: "重名项目", createdAt: "not-a-date" },
    ]);
    expect(labels.get("project-abcd")).toBe("重名项目（ID abcd）");
    expect(labels.get("project-ef01")).toBe("重名项目（ID ef01）");
  });
});
