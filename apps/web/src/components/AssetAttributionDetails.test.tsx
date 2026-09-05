import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssetAttributionDetails } from "./AssetAttributionDetails";

const attribution = { author: "Maker", sourceUrl: "https://sketchfab.com/3d-models/model", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", text: "Original Model — Maker / Sketchfab · CC-BY-4.0", modifications: "仅重新渲染缩略图" };
describe("asset attribution", () => {
  it("keeps attribution and modifications accessible without permanently expanding the card", () => {
    const html = renderToStaticMarkup(<AssetAttributionDetails attribution={attribution} locale="zh-CN" />);
    expect(html).toContain("<summary>许可与来源</summary>");
    expect(html).toContain(attribution.text);
    expect(html).toContain(attribution.modifications);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain(" open");
  });
  it("renders untrusted text as text and refuses executable or credential-bearing links", () => {
    const html = renderToStaticMarkup(<AssetAttributionDetails attribution={{ ...attribution, sourceUrl: "javascript:alert(1)", licenseUrl: "https://user:secret@example.com", text: "<script>do not execute</script>" }} locale="en-US" />);
    expect(html).not.toContain("href=");
    expect(html).not.toContain("<script>");
    expect(html).toContain("License &amp; attribution");
  });
});
