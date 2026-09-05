import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ModelRecord } from "@bim-studio/contracts";
import { PublishedModelCredits } from "./PublishedModelCredits";

const origin = { attribution: { text: "模型作者", modifications: "原始模型保留", sourceUrl: "https://example.com/model", licenseUrl: "https://creativecommons.org/licenses/by/4.0/" } };
const models = [
  { id: "original", name: "未引用原模型", libraryOrigin: origin },
  { id: "optimized", name: "引用优化模型", optimization: { sourceModelName: "设备原模型", libraryOrigin: origin } },
  { id: "local", name: "用户模型" },
] as unknown as ModelRecord[];

describe("PublishedModelCredits", () => {
  it("only displays referenced models and preserves derivative credit", () => {
    const html = renderToStaticMarkup(<PublishedModelCredits models={models} modelIds={["optimized", "local"]} locale="zh-CN" />);
    expect(html).toContain("素材署名"); expect(html).toContain("引用优化模型");
    expect(html).toContain("设备原模型"); expect(html).toContain("模型作者");
    expect(html).toContain("经模型优化处理"); expect(html).toContain(origin.attribution.licenseUrl);
    expect(html).not.toContain("未引用原模型"); expect(html).not.toContain("用户模型");
  });
  it("does not invent credit or show a control for an empty scene", () => {
    expect(renderToStaticMarkup(<PublishedModelCredits models={models} modelIds={[]} locale="zh-CN" />)).toBe("");
    expect(renderToStaticMarkup(<PublishedModelCredits models={[models[2]!]} locale="zh-CN" />)).toBe("");
  });
});
