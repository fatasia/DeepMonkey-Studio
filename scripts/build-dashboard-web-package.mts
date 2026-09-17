import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runtimeContentSha256 } from "../packages/deep-engine/src/runtimePackage/index.ts";
import { createDashboardDocument } from "../packages/contracts/src/index.ts";
import { dashboardCanonicalJsonSha256 } from "../apps/api/src/dashboardPublicationFreeze.js";
import { assertDashboardWebPackage, assertDashboardWebSource, DASHBOARD_WEB_FILE_LIMIT, type DashboardWebResource } from "../apps/web/src/delivery/dashboardWebPackage.ts";
import { dashboardFrozenFontStyle } from "../apps/web/src/delivery/dashboardFrozenFontStyle.ts";

const [publicationFile,freezeFile,objectDirectory,output,fontManifestFile] = process.argv.slice(2);
if(!publicationFile || !freezeFile || !objectDirectory || !output || !fontManifestFile)
  throw new Error("Usage: tsx build-dashboard-web-package.mts <publication.json> <prepared-evidence.json> <object-root> <new-output> <licensed-font-manifest.json>");
const sha=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
for (const file of [publicationFile,freezeFile,fontManifestFile]) if((await stat(file)).size>8*1024*1024) throw new Error("Publication metadata exceeds 8 MiB");
const licensedFonts=JSON.parse(await readFile(fontManifestFile,"utf8")),licenses=new Map<string,Buffer>();
const publication=JSON.parse(await readFile(publicationFile,"utf8"));
const {freezeManifest:freeze}=JSON.parse(await readFile(freezeFile,"utf8"));
const {manifestSha256,...freezeBody}=freeze;
if(dashboardCanonicalJsonSha256(freezeBody)!==manifestSha256
  || freeze.authority.publicationId!==publication.id || freeze.authority.applicationRevision!==publication.applicationRevision
  || freeze.documentSha256!==dashboardCanonicalJsonSha256(createDashboardDocument(publication.document,freeze.entryPageId)))
  throw new Error("Web package must use the original published document and freeze manifest");
const resources:DashboardWebResource[]=[],contents=new Map<string,Buffer>(),objectRoot=path.resolve(objectDirectory);
let resourceBytes=0;
for(const resource of freeze.resources) {
  if(!Number.isSafeInteger(resource.bytes) || resource.bytes<1 || resource.bytes>DASHBOARD_WEB_FILE_LIMIT
    || (resourceBytes+=resource.bytes)>256*1024*1024) throw new Error("Frozen resource byte budget exceeded");
  const file=path.resolve(objectRoot,resource.objectKey);
  if(!file.startsWith(`${objectRoot}${path.sep}`)) throw new Error("Frozen resource escaped object root");
  if((await stat(file)).size>DASHBOARD_WEB_FILE_LIMIT) throw new Error("Frozen resource exceeds byte budget");
  const bytes=await readFile(file); if(bytes.length!==resource.bytes || sha(bytes)!==resource.sha256) throw new Error("Frozen resource hash mismatch");
  const target=`resources/${resource.id.replace(/[^a-zA-Z0-9_-]/g,"_")}-${resource.sha256}`;
  let font:DashboardWebResource["font"];
  if(resource.kind==="font") {
    let matched=false;
    for(const entry of licensedFonts) {
      if(!path.isAbsolute(entry.path) || !path.isAbsolute(entry.licensePath) || (await stat(entry.path)).size>DASHBOARD_WEB_FILE_LIMIT) continue;
      if(sha(await readFile(entry.path))!==resource.sha256) continue;
      if((await stat(entry.licensePath)).size>1024*1024) throw new Error("Font license exceeds budget");
      const license=await readFile(entry.licensePath),licensePath=`licenses/font-${resource.sha256}.txt`;
      if(!license.length) throw new Error("Font license is empty");
      licenses.set(licensePath,license);
      font={...dashboardFrozenFontStyle(bytes),licenseEvidence:resource.licenseEvidence,licensePath};matched=true;break;
    }
    if(!matched) throw new Error("Frozen font lacks its matching distribution license");
  }
  resources.push({sourceUrl:font ? `font:${resource.id}` : `/assets/${resource.objectKey}`,path:target,mime:resource.mime,
    bytes:bytes.length,sha256:resource.sha256,...(font?{font}:{})});
  contents.set(target,bytes);
}
assertDashboardWebSource(publication,freeze.entryPageId,resources);
const initial={schema:"deep-monkey.dashboard-web" as const,schemaVersion:1 as const,publication,
  publicationSha256:runtimeContentSha256(publication),entryPageId:freeze.entryPageId,resources,
  runtimeFiles:[...licenses].map(([name,bytes])=>({path:name,bytes:bytes.length,sha256:sha(bytes)}))};
assertDashboardWebPackage({...initial,contentSha256:runtimeContentSha256(initial)});
const directory=path.resolve(output); await mkdir(directory);
const require=createRequire(new URL("../apps/web/package.json",import.meta.url));
const {build}=await import(pathToFileURL(require.resolve("vite")).href);
await build({configFile:fileURLToPath(new URL("../apps/web/vite.dashboard-static.config.ts",import.meta.url)),build:{outDir:directory}});
await rename(path.join(directory,"dashboard-static.html"),path.join(directory,"index.html"));
for(const [name,bytes] of licenses) {await mkdir(path.dirname(path.join(directory,name)),{recursive:true});await writeFile(path.join(directory,name),bytes);}
for(const name of ["LICENSE","THIRD_PARTY_NOTICES.md"]) await writeFile(path.join(directory,name),await readFile(new URL(`../${name}`,import.meta.url)));
const runtimeFiles:{path:string;bytes:number;sha256:string}[]=[];
async function collect(relative="") {
  for(const entry of await readdir(path.join(directory,relative),{withFileTypes:true})) {
    const name=path.posix.join(relative,entry.name);
    if(entry.isDirectory()) await collect(name);
    else {const bytes=await readFile(path.join(directory,name));runtimeFiles.push({path:name,bytes:bytes.length,sha256:sha(bytes)});}
  }
}
await collect();
const body={schema:"deep-monkey.dashboard-web" as const,schemaVersion:1 as const,publication,
  publicationSha256:runtimeContentSha256(publication),entryPageId:freeze.entryPageId,resources,runtimeFiles};
const manifest={...body,contentSha256:runtimeContentSha256(body)}; assertDashboardWebPackage(manifest);
for(const [name,bytes] of contents) {await mkdir(path.dirname(path.join(directory,name)),{recursive:true});await writeFile(path.join(directory,name),bytes);}
await writeFile(path.join(directory,"dashboard.web.json"),JSON.stringify(manifest));
const JSZip=require("jszip"),zip=new JSZip();
for(const file of [...runtimeFiles,...resources]) zip.file(file.path,await readFile(path.join(directory,file.path)));
zip.file("dashboard.web.json",JSON.stringify(manifest));
const archive=await zip.generateAsync({type:"nodebuffer",compression:"DEFLATE"});
await writeFile(`${directory}.web.zip`,archive);
console.log(JSON.stringify({directory,archive:`${directory}.web.zip`,sha256:sha(archive),bytes:archive.length,
  publicationId:publication.id,revision:publication.applicationRevision,contentSha256:manifest.contentSha256}));
