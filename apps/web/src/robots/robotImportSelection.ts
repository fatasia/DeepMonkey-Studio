import { ROBOT_IMPORT_LIMITS } from "@bim-studio/contracts";

/** 这里只做文件选择前置；资源与 XML 的权威校验仍由服务端执行。 */
export async function robotImportEntries(file: File): Promise<string[] | undefined> {
  if (/\.urdf$/i.test(file.name)) return [file.name];
  if (!/\.zip$/i.test(file.name)) return undefined;
  if (file.size > ROBOT_IMPORT_LIMITS.compressedBytes) throw new Error("机器人包超过 128 MB，请拆分无关资源后导入");
  const { default: JSZip } = await import("jszip");
  let zip: import("jszip");
  try { zip = await JSZip.loadAsync(await file.arrayBuffer()); }
  catch (cause) { throw new Error("ZIP 文件损坏，请重新选择", { cause }); }
  const entries = Object.values(zip.files);
  if (entries.length > ROBOT_IMPORT_LIMITS.maxEntries) throw new Error("机器人包文件过多");
  const paths = entries.filter(entry => !entry.dir && /\.urdf$/i.test(entry.name)).map(entry => entry.name).sort();
  if (!paths.length) throw new Error("ZIP 包中没有 URDF 文件");
  return paths;
}

export async function selectRobotImports(
  files: readonly File[],
  choose: (file: File, entries: string[]) => Promise<string | undefined>,
  assertCurrent: () => void = () => undefined,
): Promise<ReadonlyMap<File, string> | undefined> {
  const selected = new Map<File, string>();
  for (const file of files) {
    assertCurrent();
    const entries = await robotImportEntries(file);
    assertCurrent();
    if (!entries) continue;
    const entry = entries.length === 1 ? entries[0] : await choose(file, entries);
    assertCurrent();
    if (!entry) return;
    if (!entries.includes(entry)) throw new Error("请选择包内的 URDF 文件");
    selected.set(file, entry);
  }
  return selected;
}
