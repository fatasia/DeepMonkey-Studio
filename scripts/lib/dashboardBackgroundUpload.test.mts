import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonStore } from "../../apps/api/src/jsonStore.js";
import { LocalObjectStore } from "../../apps/api/src/objects.js";
import { uploadDashboardBackground } from "./dashboardBackgroundUpload.mts";

test("real multipart uploads and lists page image, retaining object bytes after store reopen", async () => {
  const directory=await mkdtemp(path.join(tmpdir(),"dashboard-background-upload-"));
  try {
    const metadata=path.join(directory,"metadata"),store=new JsonStore(metadata); await store.init();
    const project=await store.createProject("Upload acceptance","isolated");
    const objects=new LocalObjectStore(path.join(directory,"isolated-objects"));
    const result=await uploadDashboardBackground(directory,store,objects,project.id);
    assert.equal(result.transport,"loopback-http-multipart");
    assert.equal(result.asset.size,result.bytes.length);
    const reopened=new JsonStore(metadata); await reopened.init();
    assert.deepEqual(reopened.listAssets(project.id),[result.asset]);
  } finally {await rm(directory,{recursive:true,force:true});}
});
test("missing project and unsupported image extension reject without metadata publication", async () => {
  const directory=await mkdtemp(path.join(tmpdir(),"dashboard-background-reject-"));
  try {
    const store=new JsonStore(path.join(directory,"metadata")); await store.init();
    const project=await store.createProject("Rejected upload","isolated"),objects=new LocalObjectStore(path.join(directory,"isolated-objects"));
    await assert.rejects(uploadDashboardBackground(directory,store,objects,"missing"),/项目不存在/);
    await assert.rejects(uploadDashboardBackground(directory,store,objects,project.id,"not-image.txt"),/图片仅支持/);
    assert.deepEqual(store.listAssets(project.id),[]);
  } finally {await rm(directory,{recursive:true,force:true});}
});
