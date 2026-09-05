import { describe, expect, it } from "vitest";
import { filterBehaviorLogs, type BehaviorLogEntry } from "./behaviorLogModel";

describe("behavior log inspection", () => {
  const logs: BehaviorLogEntry[] = [
    { id: "1", moduleId: "main", level: "info", message: "temperature", data: { value: 42 }, timestamp: "2026-09-05T00:00:00Z" },
    { id: "2", moduleId: "main", level: "info", message: "temperature", data: { value: 42 }, timestamp: "2026-09-05T00:00:01Z" },
    { id: "3", moduleId: "pump", level: "error", message: "temperature", data: { value: 43 }, timestamp: "2026-09-05T00:00:02Z", location: { line: 2, column: 1 } },
  ];
  it("searches structured values and scopes without mutating input", () => {
    const result = filterBehaviorLogs(logs, { moduleId: "main", level: "info", search: "42", collapse: false });
    expect(result.map((entry) => entry.id)).toEqual(["1", "2"]);
    expect(filterBehaviorLogs(logs, { level: "error", search: "PUMP", collapse: false })[0]?.location?.line).toBe(2);
    expect(logs[0]).not.toHaveProperty("count");
  });
  it("collapses only identical messages, values, source and level", () => {
    const result = filterBehaviorLogs(logs, { level: "all", search: "", collapse: true });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: "2", count: 2 });
    expect(result[1]).toMatchObject({ id: "3", count: 1 });
    expect(filterBehaviorLogs([...logs, { ...logs[0]!, id: "4", data: { value: 44 } }], { level: "all", search: "", collapse: true })).toHaveLength(3);
  });
});
