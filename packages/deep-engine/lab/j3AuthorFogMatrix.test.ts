import {expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {buildJ3AuthorFogMatrix,j3AuthorFogRgb} from "./j3AuthorFogMatrix.js";
const json=(path:string)=>JSON.parse(readFileSync(new URL(path,import.meta.url),"utf8"));
it("reuses the original 85-point geometry masks with positive camera depth",()=>{
  const source=json("../../deep-engine-native/tests/fixtures/runtime-package-v1.json");
  const manifest=json("../fixtures/j3-hdr-flat-normal-v1.json"),profile=json("../fixtures/j3-author-fog-v1.json");
  const plan=buildJ3AuthorFogMatrix(source,manifest,profile);
  expect(plan.cameras.map(c=>c.points.length)).toEqual([45,40]);
  expect(plan.cameras.flatMap(c=>c.points).every(p=>p.depth>0&&p.base.length===3)).toBe(true);
  expect(()=>buildJ3AuthorFogMatrix(source,{...manifest,packetHash:"stale"},profile)).toThrow();
});
it("has independent exp2 and exact material opt-out/zero controls",()=>{
  const base=[.8,.3,.05],color=[.0625,.25,.5];
  expect(j3AuthorFogRgb(base,8,0,color,true)).toEqual(base);
  expect(j3AuthorFogRgb(base,8,.2,color,false)).toEqual(base);
  const rgb=j3AuthorFogRgb(base,8,.2,color,true),t=Math.exp(-2.56);
  expect(rgb[0]).toBeCloseTo(base[0]!*t+color[0]!*(1-t),14);
});
