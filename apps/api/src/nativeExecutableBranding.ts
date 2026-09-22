import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeBrandingResources, type NativeExecutableBranding } from "./nativeExecutableBrandingResources.js";
export type { NativeExecutableBranding } from "./nativeExecutableBrandingResources.js";

/** 仅在追加 DMDA overlay/签名前处理私有副本，原候选 EXE 与其 hash 不变。 */
export async function applyNativeExecutableBranding(executableBytes: Uint8Array, branding: NativeExecutableBranding, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const resources = nativeBrandingResources(branding);
  if (!resources.length) return Buffer.from(executableBytes);
  if (executableBytes.length >= 48 && Buffer.from(executableBytes.subarray(-48, -40)).toString("ascii") === "DMDASH01") {
    throw new Error("品牌资源必须在追加 Dashboard 运行包之前写入");
  }
  if (process.platform !== "win32") throw new Error("Native 客户端品牌资源更新需要 Windows 打包宿主");
  if (executableBytes.length < 64 || executableBytes[0] !== 0x4d || executableBytes[1] !== 0x5a) throw new Error("Native 候选不是 Windows EXE");
  const directory = await mkdtemp(path.join(tmpdir(), "bim-native-brand-"));
  try {
    const executable = path.join(directory, "client.exe"), payload = path.join(directory, "resources.json");
    await writeFile(executable, executableBytes);
    await writeFile(payload, JSON.stringify(resources.map(resource => ({ type: resource.type, id: resource.id, base64: resource.bytes.toString("base64") }))));
    await runResourceUpdate(executable, payload, signal);
    signal?.throwIfAborted();
    return await readFile(executable);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function runResourceUpdate(executable: string, payload: string, signal?: AbortSignal): Promise<void> {
  const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BrandResources {
 public delegate bool LanguageCallback(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr data);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr LoadLibraryEx(string file, IntPtr fileHandle, uint flags);
 [DllImport("kernel32.dll")] public static extern bool FreeLibrary(IntPtr module);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern bool EnumResourceLanguages(IntPtr module, IntPtr type, IntPtr name, LanguageCallback callback, IntPtr data);
 public static ushort[] Languages(string file, int type, int name) {
  var result=new System.Collections.Generic.List<ushort>();
  var module=LoadLibraryEx(file,IntPtr.Zero,2);
  if(module==IntPtr.Zero) throw new Exception("LoadLibraryEx failed");
  try { EnumResourceLanguages(module,(IntPtr)type,(IntPtr)name,(m,t,n,l,d)=>{result.Add(l);return true;},IntPtr.Zero); }
  finally {FreeLibrary(module);}
  return result.ToArray();
 }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr BeginUpdateResource(string file, bool delete);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool UpdateResource(IntPtr handle, IntPtr type, IntPtr name, ushort language, byte[] bytes, uint size);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool EndUpdateResource(IntPtr handle, bool discard);
}
'@
$items=Get-Content -LiteralPath $env:BIM_BRAND_RESOURCES -Raw | ConvertFrom-Json
$languages=@{}
foreach($item in $items){$languages["$($item.type):$($item.id)"]=[BrandResources]::Languages($env:BIM_BRAND_EXE,$item.type,$item.id)}
$handle=[BrandResources]::BeginUpdateResource($env:BIM_BRAND_EXE,$false)
if($handle -eq [IntPtr]::Zero){throw 'BeginUpdateResource failed'}
$committed=$false
try {
 foreach($item in $items) {
  foreach($language in $languages["$($item.type):$($item.id)"]){
   if($language -ne 0 -and -not [BrandResources]::UpdateResource($handle,[IntPtr][int]$item.type,[IntPtr][int]$item.id,$language,$null,0)){throw 'Delete resource language failed'}
  }
  $bytes=[Convert]::FromBase64String($item.base64)
  if(-not [BrandResources]::UpdateResource($handle,[IntPtr][int]$item.type,[IntPtr][int]$item.id,0,$bytes,$bytes.Length)){throw 'UpdateResource failed'}
 }
 if(-not [BrandResources]::EndUpdateResource($handle,$false)){throw 'EndUpdateResource failed'}
 $committed=$true
} finally {if(-not $committed){[BrandResources]::EndUpdateResource($handle,$true)|Out-Null}}
`;
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, BIM_BRAND_EXE: executable, BIM_BRAND_RESOURCES: payload },
    });
    let errorText = "", failure: Error | undefined;
    const abort = () => { failure = new Error("客户端品牌更新已取消"); child.kill(); };
    const timer = setTimeout(() => { failure = new Error("客户端品牌更新超时"); child.kill(); }, 30_000);
    signal?.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", bytes => { errorText = (errorText + String(bytes)).slice(-1500); });
    child.once("error", error => { failure = error; });
    child.once("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (failure || code !== 0) reject(failure ?? new Error(`客户端品牌资源更新失败：${errorText.trim()}`));
      else resolve();
    });
    if (signal?.aborted) abort();
  });
}
