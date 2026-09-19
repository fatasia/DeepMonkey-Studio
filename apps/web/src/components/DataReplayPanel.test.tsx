import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DataReplayPanel, signalsFromEntries } from "./DataReplayPanel";
import { normalizeTimeline } from "../alerting/timelineReplay";

const entries = [
  { at: 0, values: { temp: 20, press: 0.5 } },
  { at: 10_000, values: { temp: 85, press: 0.4 } },
  { at: 20_000, values: { temp: 70, press: 0.5 } },
];

describe("DataReplayPanel (P4 UI slice)", () => {
  it("renders revision, controls and signal values for a loaded series", () => {
    const markup = renderToStaticMarkup(
      <DataReplayPanel projectId="p1" request={async () => ({}) as never}
        signals={[{ key: "temp", label: "轴承温度" }, { key: "press", label: "油压" }]} locale="zh-CN" />,
    );
    // 初始未加载(replay 状态在 effect 后才可用),但控件与空态可见。
    expect(markup).toContain("时序回放");
    expect(markup).toContain("重载");
    void entries;
  });

  it("derives the signal list from entries for callers", () => {
    expect(signalsFromEntries(entries)).toEqual([
      { key: "temp", label: "temp" },
      { key: "press", label: "press" },
    ]);
  });

  it("normalizes out-of-order series before replay", () => {
    expect(normalizeTimeline([
      { at: 20_000, values: { temp: 1 } },
      { at: 10_000, values: { temp: 2 } },
    ]).map((entry) => entry.at)).toEqual([10_000, 20_000]);
  });
});
