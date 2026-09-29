import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiRequestProgress } from "./AiRequestProgress";

/** T6（审计 §二 2.3）：chat 长任务进度行——已耗时 + 当前阶段。 */
describe("AiRequestProgress（T6 chat 进度行）", () => {
  it("connecting 阶段显示已等待耗时与阶段文案（不伪造百分比）", () => {
    const html = renderToStaticMarkup(
      <AiRequestProgress locale="zh-CN" startedAt={Date.now() - 5_000} phase="connecting" />,
    );
    expect(html).toContain("已等待 5s");
    expect(html).toContain("等待服务响应");
    expect(html).toContain('role="timer"');
    expect(html).not.toContain("%");
  });

  it("streaming 阶段切换为流式生成中", () => {
    const html = renderToStaticMarkup(
      <AiRequestProgress locale="zh-CN" startedAt={Date.now() - 65_000} phase="streaming" />,
    );
    expect(html).toContain("流式生成中");
    expect(html).toContain("1m05s");
  });

  it("缺省 startedAt 不渲染（历史消息与 stopped 态不显示进度）", () => {
    const html = renderToStaticMarkup(<AiRequestProgress locale="zh-CN" phase="connecting" />);
    expect(html).toBe("");
  });

  it("负耗时钳为 0（时钟回拨不显示负数）", () => {
    const html = renderToStaticMarkup(
      <AiRequestProgress locale="zh-CN" startedAt={Date.now() + 60_000} phase="connecting" />,
    );
    expect(html).toContain("已等待 0s");
  });
});
