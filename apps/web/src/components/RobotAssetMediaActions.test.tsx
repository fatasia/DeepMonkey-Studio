import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ModelRecord } from "@bim-studio/contracts";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { RobotAssetMediaActions } from "./RobotAssetMediaActions";

describe("robot media actions", () => {
  const model = { name: "arm.zip", format: "zip", status: "ready" } as ModelRecord;
  it("shows necessary source/screenshot actions, with screenshot unavailable until the Viewer is ready", () => {
    const html = renderToStaticMarkup(<RobotAssetMediaActions locale="zh-CN" model={model} />);
    expect(html).toContain("下载原包 arm.zip"); expect(html).toContain("截图");
    expect((html.match(/disabled=""/g) ?? []).length).toBe(1);
    expect(html).not.toContain("<h2"); expect(html).not.toContain("badge");
  });
  it("uses one compact download action in inventory without a fake thumbnail", () => {
    const html = renderToStaticMarkup(<RobotAssetMediaActions locale="zh-CN" model={model} screenshot={false} compact />);
    expect((html.match(/<button/g) ?? []).length).toBe(1); expect(html).not.toContain("截图"); expect(html).not.toContain("<img"); expect(html).not.toContain("<canvas");
  });
  it("disables pending assets and hides the robot-only action for ordinary models", () => {
    const html = renderToStaticMarkup(<RobotAssetMediaActions locale="en-US" model={{ ...model, status: "queued" }} engine={{} as ViewerEngine} disabled />);
    expect((html.match(/disabled=""/g) ?? []).length).toBe(2);
    expect(renderToStaticMarkup(<RobotAssetMediaActions locale="en-US" model={{ ...model, format: "glb" }} />)).toBe("");
  });
});
