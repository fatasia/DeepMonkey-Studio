import { describe, expect, it } from "vitest";
import { searchDocs } from "@bim-studio/docs-runtime";
import { docsCategories, docsDocuments, docsLinkIssues, DOCS_VERSION } from "./docsCatalog.js";

describe("local documentation catalog", () => {
  it("ships the current end-to-end product guides offline", () => {
    expect(docsDocuments.map((document) => document.id)).toEqual([
      "dashboard-scene",
      "runtime-and-extensions",
      "resource-workflow",
      "media-widgets",
      "topology-resources",
      "data-pipeline",
      "ai-workflows",
      "ai-modeling3d-api",
      "behavior-script",
      "studio-api",
      "sdk-examples",
      "api-reference",
      "industrial-planning",
      "agv-runtime-simulation",
      "simulation-commissioning",
      "server-publish",
      "deployment-operations",
      "troubleshooting"
    ]);
    expect(docsDocuments.every((document) => document.version === DOCS_VERSION)).toBe(true);
    expect(docsCategories).toHaveLength(5);
  });

  it("documents the full supported delivery path and industrial tasks", () => {
    const text = docsDocuments.map((document) => document.plainText).join("\n");
    for (const expected of [
      "项目 → 资源 → 二维 / 三维",
      "资源（项目资源页）",
      "脚本编辑器可隐藏、悬浮或分屏",
      "接入数据 → 处理逻辑 → 发布接口",
      "拓扑编辑与数据绑定",
      "问数据并生成看板",
      "使用工业 AI 助手与视觉能力",
      "studio 应用 API 手册",
      "图文 API 与平台参考",
      "Worker 对象 API",
      "SDK 可运行样例",
      "仿真与虚拟调试",
      "Plant Lite",
      "PPR/BOP",
      "机器人与控制验证",
      "恢复未保存修改",
      "发布体检",
      "部署与系统运维",
      "使用开源基础能力",
      "接入商业扩展",
    ]) expect(text).toContain(expected);
  });

  it("does not expose excluded delivery scope in the offline product guide", () => {
    const text = docsDocuments.map((document) => document.plainText).join("\n");
    for (const excluded of ["多人协作", "发布环境", "Windows 安装与升级", "私有化安装", "审计导出", "轻 3D", "资源库", "资源中心"]) {
      expect(text).not.toContain(excluded);
    }
  });

  it("finds industrial and recovery tasks with plain-language queries", () => {
    expect(searchDocs(docsDocuments, "机器人控制")[0]?.document.id).toBe("industrial-planning");
    expect(searchDocs(docsDocuments, "恢复未保存修改")[0]?.document.id).toBe("troubleshooting");
    expect(searchDocs(docsDocuments, "视觉 ONNX")[0]?.document.id).toBe("ai-workflows");
    expect(searchDocs(docsDocuments, "飞书 推送")[0]?.document.id).toBe("deployment-operations");
  });

  it("has no broken local Markdown links", () => {
    expect(docsLinkIssues).toEqual([]);
  });
});
