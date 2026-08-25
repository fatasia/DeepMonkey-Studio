import { describe, expect, it } from "vitest";
import type { RevitInstallationRecord } from "@bim-studio/contracts";
import { resolveRevitVersion } from "./revit.js";

function installation(version: string): RevitInstallationRecord {
  return { version, path: `C:/Revit/${version}/Revit.exe`, source: "standard", addinInstalled: true, workerReady: false };
}

describe("resolveRevitVersion", () => {
  const installed = [installation("2023"), installation("2026")];

  it("uses the oldest installed version that can open an older file", () => {
    expect(resolveRevitVersion(installed, "auto", "2019")).toBe("2023");
  });

  it("prefers Revit 2019 when it is installed for an older source file", () => {
    expect(resolveRevitVersion([installation("2019"), ...installed], "auto", "2017")).toBe("2019");
  });

  it("uses an exact newer version when required", () => {
    expect(resolveRevitVersion(installed, "auto", "2026")).toBe("2026");
  });

  it("rejects an explicitly selected incompatible version", () => {
    expect(() => resolveRevitVersion(installed, "2023", "2026")).toThrow("不能使用 Revit 2023");
  });

  it("reports when no installed version can open the source", () => {
    expect(() => resolveRevitVersion([installation("2023")], "auto", "2026")).toThrow("当前最高仅安装 Revit 2023");
  });
});
