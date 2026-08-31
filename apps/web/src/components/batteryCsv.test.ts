import { describe, expect, it } from "vitest";
import { parseBatteryCsv } from "./batteryCsv";

describe("parseBatteryCsv", () => {
  it("parses quoted CSV values and keeps equipment identifiers as text", async () => {
    const file = new File([
      'cellId,cycle,voltage,note\r\n"LFP,01",1,3.28,"normal ""charge"""\r\n',
    ], "battery.csv", { type: "text/csv" });
    const result = await parseBatteryCsv(file);
    expect(result.headers).toEqual(["cellId", "cycle", "voltage", "note"]);
    expect(result).toEqual({ headers: ["cellId", "cycle", "voltage", "note"], rowCount: 1 });
  });

  it("rejects duplicate headers instead of silently overwriting a field", async () => {
    const file = new File(["cycle,cycle\n1,2\n"], "battery.csv");
    await expect(parseBatteryCsv(file)).rejects.toThrow("重复字段");
  });

  it("ignores quoted delimiter characters while detecting the file dialect", async () => {
    const file = new File(['cellId,"note;detail",voltage\nLFP-01,"stable;checked",3.3\n'], "battery.csv");
    const result = await parseBatteryCsv(file);
    expect(result).toEqual({ headers: ["cellId", "note;detail", "voltage"], rowCount: 1 });
  });
});
