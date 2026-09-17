import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { createDashboardRasterHost, rasterizeFrozenPageBackground } from "./dashboardRasterHost.mjs";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const pixel = (result, x, y) => [...result.rgba.slice((y * result.width + x) * 4, (y * result.width + x + 1) * 4)];
async function request(background, size = [6, 4]) {
  const bytes = await sharp(Buffer.from([255,0,0,128, 0,255,0,255, 0,0,255,255, 255,255,255,255]),
    { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer();
  return { width: size[0], height: size[1], fit: "fill", background, requestHash: "f".repeat(64),
    asset: { bytes, sha256: hash(bytes), mime: "image/png" } };
}
test("original preserves source pixels, transparent surroundings and five CSS positions", async () => {
  for (const [position, x, y] of [["center",2,1],["left",0,1],["right",4,1],["top",2,0],["bottom",2,2]]) {
    const result = await rasterizeFrozenPageBackground(await request({ fit: "original", position, repeat: false }));
    assert.deepEqual(pixel(result,x,y), [255,0,0,128]);
    assert.deepEqual(pixel(result,x+1,y+1), [255,255,255,255]);
    assert.equal(result.rgba.filter((_,i) => i % 4 === 3 && result.rgba[i] > 0).length, 4);
    assert.equal(hash(result.rgba), result.sha256);
  }
});
test("repeat uses the positioned tile origin including negative coordinates", async () => {
  for (const size of [[6,4],[7,5]]) for (const position of ["center", "top", "bottom", "left", "right"]) {
    const result = await rasterizeFrozenPageBackground(await request({ fit: "original", position, repeat: true },size));
    for (let y=0;y<size[1];y++) for(let x=0;x<size[0];x++) {
      if(x+2<size[0]) assert.deepEqual(pixel(result,x,y),pixel(result,x+2,y));
      if(y+2<size[1]) assert.deepEqual(pixel(result,x,y),pixel(result,x,y+2));
      assert.ok(pixel(result,x,y)[3] > 0);
    }
  }
});
test("contain keeps letterbox transparent unless repeated; stretch/cover fill the page", async () => {
  for (const fit of ["contain","stretch","cover"]) for (const repeat of [false,true]) {
    const result = await rasterizeFrozenPageBackground(await request({fit,position:"right",repeat}));
    assert.equal(pixel(result,0,0)[3] === 0, fit === "contain" && !repeat);
    assert.ok(pixel(result,5,3)[3] > 0);
  }
});
test("original crops oversized tiles and binds layout into source evidence", async () => {
  const input = await request({fit:"original",position:"right",repeat:false},[1,2]);
  const right = await rasterizeFrozenPageBackground(input);
  assert.deepEqual(pixel(right,0,0),[0,255,0,255]);
  const left = await rasterizeFrozenPageBackground({...input,background:{...input.background,position:"left"}});
  assert.deepEqual(pixel(left,0,0),[255,0,0,128]);
  assert.notEqual(right.sourceSha256,left.sourceSha256);
  assert.deepEqual(right, await createDashboardRasterHost({}).decodePageBackground(input));
});
test("rejects missing/invalid layout, substituted bytes, extent and pre-cancellation", async () => {
  const input = await request({fit:"original",position:"center",repeat:false});
  for (const background of [undefined, {...input.background,fit:"fill"}, {...input.background,position:"north"},
    {...input.background,repeat:"false"}]) await assert.rejects(rasterizeFrozenPageBackground({...input,background}),/layout/);
  await assert.rejects(rasterizeFrozenPageBackground({...input,width:8193}),/extent/);
  await assert.rejects(rasterizeFrozenPageBackground(input,AbortSignal.abort(new Error("stopped"))),/stopped/);
  input.asset.bytes[0] ^= 1;
  await assert.rejects(rasterizeFrozenPageBackground(input),/hash/);
});
test("snapshots bytes and layout before asynchronous decode; cancelled decode publishes no result", async () => {
  const input = await request({fit:"original",position:"left",repeat:false});
  const pending = rasterizeFrozenPageBackground(input);
  input.asset.bytes.fill(0); input.background.position = "right";
  assert.deepEqual(pixel(await pending,0,1),[255,0,0,128]);
  const controller = new AbortController();
  const cancelled = rasterizeFrozenPageBackground(await request({fit:"cover",position:"center",repeat:false}),controller.signal);
  controller.abort(new Error("decode cancelled"));
  await assert.rejects(cancelled,/decode cancelled/);
});
test("one-pixel repeated texture stays bounded at a large page extent", async () => {
  const bytes = await sharp({create:{width:1,height:1,channels:4,background:{r:10,g:20,b:30,alpha:1}}}).png().toBuffer();
  const result = await rasterizeFrozenPageBackground({width:2048,height:2048,fit:"fill",requestHash:"large",
    background:{fit:"original",position:"center",repeat:true},asset:{bytes,sha256:hash(bytes)}});
  assert.equal(result.rgba.length,16*1024*1024);
  assert.deepEqual(pixel(result,0,0),[10,20,30,255]);
  assert.deepEqual(pixel(result,2047,2047),[10,20,30,255]);
});
