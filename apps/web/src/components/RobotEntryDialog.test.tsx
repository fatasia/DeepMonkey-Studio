import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RobotEntryDialog } from "./RobotEntryDialog";

describe("robot entry chooser", () => {
  it("uses one field and requires an explicit selection without extra explanation blocks", () => {
    const html = renderToStaticMarkup(<RobotEntryDialog locale="zh-CN" name="robots.zip" entries={["a.urdf", "b.urdf"]} onSelect={() => undefined} />);
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("描述文件");
    expect(html).toContain('class="button primary" disabled=""');
    expect(html).not.toContain("<p");
    expect(html).toContain("b.urdf");
  });
});
