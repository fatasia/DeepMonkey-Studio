import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { EventRecordingPanel } from "./EventRecordingPanel";

it("offers the production entry with truthful origins and a useful empty state", () => {
  const html = renderToStaticMarkup(<EventRecordingPanel projectId="p1" request={async () => { throw new Error("SSR must not request"); }} studies={[]} />);
  expect(html).toContain("事件持久录制"); expect(html).toContain("建立录制"); expect(html).toContain("选择已保存的历史录制");
  expect(html).toContain("注入事件"); expect(html).toContain("仿真事件"); expect(html).not.toContain('<option value="subscription">');
  expect(html).toContain("留空表示无帧映射");
});
