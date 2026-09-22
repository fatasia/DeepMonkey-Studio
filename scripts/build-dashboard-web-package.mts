import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DASHBOARD_WEB_FILE_LIMIT } from "../packages/contracts/src/index.ts";
import { createDashboardWebStaticPackage } from "../apps/api/src/dashboardWebStaticPackage.ts";
import { readDashboardStaticFile } from "../apps/api/src/dashboardWebStaticFiles.ts";

const [publicationFile, freezeFile, objectDirectory, output, fontManifestFile, ...rest] = process.argv.slice(2);
if (!publicationFile || !freezeFile || !objectDirectory || !output || !fontManifestFile || rest.length)
  throw new Error("Usage: tsx build-dashboard-web-package.mts <publication.json> <prepared-evidence.json> <object-root> <new-output> <licensed-font-manifest.json>");
const metadata = async (file: string) => JSON.parse((await readDashboardStaticFile(file, 8 * 1024 * 1024)).toString("utf8"));
const publication = await metadata(publicationFile);
const { freezeManifest } = await metadata(freezeFile);
const licensedFonts = await metadata(fontManifestFile);
const objectRoot = await realpath(objectDirectory), directory = path.resolve(output);
// 只创建新目录，失败重跑也不覆盖已有包。
await mkdir(directory);
const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { build } = await import(pathToFileURL(require.resolve("vite")).href);
await build({ configFile: fileURLToPath(new URL("../apps/web/vite.dashboard-static.config.ts", import.meta.url)),
  build: { outDir: directory } });
await rename(path.join(directory, "dashboard-static.html"), path.join(directory, "index.html"));
const bytes = await createDashboardWebStaticPackage({ publication, freezeManifest, licensedFonts,
  webStaticRoot: directory,
  async readResourceObject(key) {
    const file = await realpath(path.resolve(objectRoot, key)), relative = path.relative(objectRoot, file);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("Frozen resource escaped object root");
    return readDashboardStaticFile(file, DASHBOARD_WEB_FILE_LIMIT);
  },
});
const JSZip = require("jszip"), zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
for (const name of Object.keys(zip.files)) {
  if (zip.files[name].dir) continue;
  const file = path.resolve(directory, name), relative = path.relative(directory, file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Package entry escaped output root");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, await zip.files[name].async("uint8array"));
}
await writeFile(`${directory}.web.zip`, bytes, { flag: "wx" });
const manifest = JSON.parse(await readFile(path.join(directory, "dashboard.web.json"), "utf8"));
console.log(JSON.stringify({ directory, archive: `${directory}.web.zip`,
  sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length,
  publicationId: publication.id, revision: publication.applicationRevision, contentSha256: manifest.contentSha256 }));
