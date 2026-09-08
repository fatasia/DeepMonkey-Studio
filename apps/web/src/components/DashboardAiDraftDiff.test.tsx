import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardAiDraftDiff } from "./DashboardAiDraftDiff";

describe("AI dashboard diff presentation", () => {
  it("shows explicit English add/update/delete and old-to-new fields without Chinese labels", () => {
    const node = { id: "kpi", kind: "data-widget" as const, frame: { x: 40, y: 40, width: 300, height: 160 }, zIndex: 1, widget: { type: "value" as const, key: "output", title: "Output", unit: "pcs" } };
    const html = renderToStaticMarkup(<DashboardAiDraftDiff locale="en-US" diff={[
      { op: "add", id: "a", title: "Output", after: node },
      { op: "update", id: "b", title: "Total output", before: node, after: { ...node, widget: { ...node.widget, title: "Total output" } } },
      { op: "delete", id: "c", title: "Old output", before: node },
    ]} />);
    expect(html).toContain("Add"); expect(html).toContain("Update"); expect(html).toContain("Delete");
    expect(html).toContain("Output → Total output"); expect(html).not.toMatch(/[\u4e00-\u9fff]/);
  });
  it("uses existing tokens for the nonmodal scoped surface", async () => {
    const css = await readFile(new URL("./DashboardAiDraft.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/#[\da-f]{3,8}|rgba?\(/i);
    expect(css).toContain("backdrop-filter: none"); expect(css).toContain("var(--layer-workspace)");
  });
  it("cancels the click default before the stop button becomes a submit button", async () => {
    const source = await readFile(new URL("./DashboardAiDraftEntry.tsx", import.meta.url), "utf8");
    expect(source).toContain("event.preventDefault(); session.cancel();");
  });
});
