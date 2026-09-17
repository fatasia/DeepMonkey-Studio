import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { prepareDashboardPublicationFreeze, type DashboardPublicationFreezeManifest } from "../../apps/api/src/dashboardPublicationFreeze.js";
import type { DashboardPublicationAuthorityAdapter } from "../../apps/api/src/dashboardPublicationAuthorityAdapter.js";
import type { AuthoritativeDashboardCompiler } from "../../apps/api/src/dashboardPublicationCapability.js";
import { createDashboardPublishedFontCatalog, type DashboardPublishedFontConfiguration } from "../../apps/api/src/dashboardPublishedFontCatalog.js";
import type { LocalObjectStore } from "../../apps/api/src/objects.js";
import type { uploadDashboardBackground } from "./dashboardBackgroundUpload.mts";

/** Recompiles the exact frozen source and requires byte identity before inspecting private compiler bindings. */
export async function verifyDashboardBackgroundDelivery(authority: DashboardPublicationAuthorityAdapter,
  manifest: DashboardPublicationFreezeManifest, artifact: Uint8Array,
  upload: Awaited<ReturnType<typeof uploadDashboardBackground>>, nativeExecutable: string,
  configuration: Record<string,unknown>, fontCatalog: DashboardPublishedFontConfiguration, objects: LocalObjectStore) {
  const frozen = await prepareDashboardPublicationFreeze({expected:manifest.authority,entryPageId:manifest.entryPageId,
    data:manifest.data,resources:manifest.resources.map(item=>({...item,expectedSha256:item.sha256,
      ...(item.licenseEvidence ? {license:{redistributable:true,evidence:item.licenseEvidence}} : {})})),
    ...authority.revalidation({...manifest.authority,entryPageId:manifest.entryPageId})});
  assert.deepEqual(frozen.manifest,manifest,"Inspection must preserve the original data capture revision");
  const bundle = await import(new URL("../../apps/api/dist/dashboard-content-compiler/deployment.mjs",import.meta.url).href) as {
    createDashboardNativeDeployment(input:unknown):Promise<{compiler:AuthoritativeDashboardCompiler}> };
  const fonts = createDashboardPublishedFontCatalog(fontCatalog,objects);
  const {compiler} = await bundle.createDashboardNativeDeployment({nativeExecutable,
    configuration:{...configuration,nodeAssets:fonts.compilerNodeAssets}});
  const compiled = await compiler.compile({document:frozen.document,data:frozen.data,resources:frozen.resources,freezeManifest:frozen.manifest});
  assert.deepEqual(compiled.artifact,artifact,"Inspection compile must equal the HTTP candidate bytes");
  const page = frozen.document.application.pages[0]!;
  const resource = frozen.manifest.resources.find(item=>item.id===upload.asset.id);
  assert(resource); assert.deepEqual(resource.pageIds,[page.id]); assert.deepEqual(resource.nodeIds,[]);
  assert.equal(resource.sha256,upload.sha256);
  const bindings = compiled.windowEvidence?.backgroundBindings;
  assert.equal(bindings?.length,1);
  const binding = bindings![0]!;
  assert.equal(binding.authorPageId,page.id); assert.equal(binding.resourceId,resource.id);
  assert.equal(binding.sourceSha256,upload.sha256);
  const runtime = JSON.parse(new TextDecoder().decode(artifact));
  const content = runtime.payloads[`${binding.pageId}.background`];
  assert.equal(content.atlases.length,1);
  assert.equal(content.atlases[0].id,binding.atlasId);
  const pixels = Buffer.from(content.atlases[0].dataBase64,"base64");
  assert.equal(pixels.length,page.width*page.height*4);
  const expected = Buffer.alloc(pixels.length);
  for(let offset=0;offset<expected.length;offset+=4) expected.set([20,40,60,128],offset);
  assert.deepEqual(pixels,expected);
  assert.equal(createHash("sha256").update(pixels).digest("hex"),binding.pixelSha256);
  assert.deepEqual(compiled.objects.map(item=>item.nodeId),["portable-author-bar"]);
  return {upload:{transport:upload.transport,asset:upload.asset,sha256:upload.sha256},
    backgroundBindings:bindings,pixelBytes:pixels.length,identicalRecompile:true};
}
