import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";
import type { ProjectAssetRecord } from "../../packages/contracts/src/index.ts";
import { createApiServer } from "../../apps/api/src/serverOptions.js";
import { registerModelAssetRoutes } from "../../apps/api/src/modelAssetRoutes.js";
import { ConversionQueue } from "../../apps/api/src/conversion.js";
import { loadConfig } from "../../apps/api/src/config.js";
import type { JsonStore } from "../../apps/api/src/jsonStore.js";
import type { LocalObjectStore } from "../../apps/api/src/objects.js";
import { readDashboardTrustedObject } from "../../apps/api/src/dashboardNativeCandidateRuntime.js";
import { dashboardAcceptanceHttp } from "./dashboardAcceptanceHttp.mts";
const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const multipart = require("@fastify/multipart");
export async function uploadDashboardBackground(directory: string, store: JsonStore, objects: LocalObjectStore,
  projectId: string, filename = "acceptance-background.png") {
  const bytes = await sharp({create:{width:32,height:16,channels:4,background:{r:20,g:40,b:60,alpha:0.5}}}).png().toBuffer();
  const app = createApiServer();
  try {
    await app.register(multipart, {limits:{fileSize:1024*1024}});
    const config = loadConfig();
    await registerModelAssetRoutes(app,{store,objects,config,queue:new ConversionQueue(store,config,objects),
      dataDir:path.join(directory,"isolated-objects")});
    const request = await dashboardAcceptanceHttp(app);
    const form = new FormData(); form.append("file",new Blob([Uint8Array.from(bytes)],{type:"image/png"}),filename);
    const response = await request({method:"POST",url:`/api/projects/${projectId}/assets/images`,form});
    assert.equal(response.statusCode,201,response.body);
    const asset = response.json() as ProjectAssetRecord;
    const list = await request({method:"GET",url:`/api/projects/${projectId}/assets`});
    assert.equal(list.statusCode,200,list.body);
    assert.deepEqual(list.json(),[asset]);
    const stored = await readDashboardTrustedObject(objects,asset.url.slice("/assets/".length));
    assert.deepEqual(stored,Uint8Array.from(bytes));
    return {asset,bytes,sha256:createHash("sha256").update(bytes).digest("hex"),transport:"loopback-http-multipart"};
  } finally { await app.close(); }
}
