import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyNativeExecutableBranding } from "./nativeExecutableBranding.js";
import { nativeBrandingResources } from "./nativeExecutableBrandingResources.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const iconPath = path.join(root, "apps/desktop/src-tauri/icons/icon.ico");
describe("native EXE brand resources", () => {
  it("keeps unspecified bytes exact and rejects invalid name/icon bounds", async () => {
    const bytes = Buffer.from("unchanged");
    expect(await applyNativeExecutableBranding(bytes, {})).toEqual(bytes);
    for (const applicationName of ["", "bad\nname", "x".repeat(81)]) expect(() => nativeBrandingResources({ applicationName })).toThrow();
    const ico = await readFile(iconPath);
    const bad = Buffer.from(ico); bad.writeUInt32LE(ico.length, 18);
    expect(() => nativeBrandingResources({ iconIco: bad })).toThrow("越界");
    const resources = nativeBrandingResources({ iconIco: ico });
    expect(resources.filter(item => item.type === 3)).toHaveLength(6);
    expect(resources.at(-1)).toMatchObject({ type: 14, id: 101 });
  });
  it("rejects cancellation before starting resource updates", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(applyNativeExecutableBranding(Buffer.alloc(0), { applicationName: "test" }, controller.signal)).rejects.toThrow();
    const overlay = Buffer.alloc(128); overlay.write("DMDASH01", 80);
    await expect(applyNativeExecutableBranding(overlay, { applicationName: "test" })).rejects.toThrow("之前");
  });
  it.skipIf(process.platform !== "win32")("writes real PE metadata and roundtrips all neutral icon/name resources without modifying source", async () => {
    const sourcePath = path.join(root, "packages/deep-engine-native/target/debug/deep-engine-native.exe");
    const original = await readFile(sourcePath);
    const branding = { applicationName: "验证工厂 ' & 品牌", iconIco: await readFile(iconPath) };
    const output = await applyNativeExecutableBranding(original, branding);
    expect(createHash("sha256").update(await readFile(sourcePath)).digest("hex")).toBe(createHash("sha256").update(original).digest("hex"));
    const directory = await mkdtemp(path.join(tmpdir(), "bim-brand-test-"));
    try {
      const target = path.join(directory, "verified.exe"); await writeFile(target, output);
      const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class ReadBrand {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr LoadLibraryEx(string p,IntPtr f,uint flags);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr FindResourceEx(IntPtr m,IntPtr t,IntPtr n,ushort l);
 [DllImport("kernel32.dll")] public static extern IntPtr LoadResource(IntPtr m,IntPtr r);
 [DllImport("kernel32.dll")] public static extern IntPtr LockResource(IntPtr r);
 [DllImport("kernel32.dll")] public static extern uint SizeofResource(IntPtr m,IntPtr r);
 [DllImport("kernel32.dll")] public static extern bool FreeLibrary(IntPtr m);
 public static string Read(string p,int t,int n){var m=LoadLibraryEx(p,IntPtr.Zero,2);try{var r=FindResourceEx(m,(IntPtr)t,(IntPtr)n,0);var b=new byte[SizeofResource(m,r)];Marshal.Copy(LockResource(LoadResource(m,r)),b,0,b.Length);return Convert.ToBase64String(b);}finally{FreeLibrary(m);}}
}
'@
$version=[Diagnostics.FileVersionInfo]::GetVersionInfo($env:BIM_TEST_EXE)
$resources=@();foreach($item in ($env:BIM_TEST_RESOURCES|ConvertFrom-Json)){$resources+=@{type=$item.type;id=$item.id;base64=[ReadBrand]::Read($env:BIM_TEST_EXE,$item.type,$item.id)}}
@{product=$version.ProductName;description=$version.FileDescription;major=$version.FileMajorPart;minor=$version.FileMinorPart;resources=$resources}|ConvertTo-Json -Depth 5 -Compress`;
      const expected = nativeBrandingResources(branding);
      const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
        windowsHide: true, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, BIM_TEST_EXE: target, BIM_TEST_RESOURCES: JSON.stringify(expected.map(({ type, id }) => ({ type, id }))) },
      });
      const actual = JSON.parse(stdout.replace(/^\uFEFF/, ""));
      expect(actual).toMatchObject({ product: branding.applicationName, description: branding.applicationName, major: 0, minor: 1 });
      expect(actual.resources).toEqual(expected.map(({ type, id, bytes }) => ({ type, id, base64: bytes.toString("base64") })));
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30_000);
});
