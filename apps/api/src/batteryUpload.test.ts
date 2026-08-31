import { describe, expect, it } from "vitest";
import { parseBatteryUpload } from "./batteryUpload";

describe("parseBatteryUpload", () => {
  it("parses quoted fields and finite numeric samples", () => {
    const records = parseBatteryUpload(Buffer.from('cellId,cycle,voltage,note\n"LFP,01",1,3.28,"ok"\n'));
    expect(records).toEqual([{ cellId: "LFP,01", cycle: 1, voltage: 3.28, note: "ok" }]);
  });

  it("rejects duplicate headers", () => {
    expect(() => parseBatteryUpload(Buffer.from("cycle,cycle\n1,2\n"))).toThrow("重复字段");
  });

  it("does not treat delimiters inside quoted headers as dialect separators", () => {
    const records = parseBatteryUpload(Buffer.from('cellId,"note;detail",voltage\nLFP-01,"stable;checked",3.3\n'));
    expect(records).toEqual([{ cellId: "LFP-01", "note;detail": "stable;checked", voltage: 3.3 }]);
  });
});
