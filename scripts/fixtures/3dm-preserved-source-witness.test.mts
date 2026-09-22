import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {completeBrepParts} from './3dm-brep-tessellation.mts';
import {auditSourceEdgeChain} from './3dm-source-edge-chain.mts';
import {auditPreservedSourceVertices} from './3dm-preserved-source-witness.mts';
import {evaluateCurve} from './3dm-nurbs-parameters.mjs';
const root=resolve(import.meta.dirname,'../..'),out=resolve(root,'test-output/industrial-3dm/preserved-source-2026-09-17-v1');
const path=resolve(root,'data/external-assets/industrial-format-plan/dependencies/extracted/opennurbs-v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm');
const sha=(b:any)=>createHash('sha256').update(b).digest('hex'),sourceSha256='a1b0ef69925b5d9223a7d797033055bb766842768a96f7713e1ecaec2763bb31';
assert.equal(sha(readFileSync(path)),sourceSha256);
const native=spawnSync(resolve(root,'test-output/3dm-source-audit/3dm-source-audit.exe'),[path,'--parameter-evidence-all'],{encoding:'utf8',maxBuffer:128*1024*1024,timeout:60000});
assert.equal(native.status,0,native.stderr);const source=JSON.parse(native.stdout),object=source.objects.find((o:any)=>o.cadIr),ir=object.cadIr;object.storedRenderMeshes=[];
const complete=completeBrepParts(object,.001,{reconstructPlaneBoundaries:false,reconstructPairedBoundaries:false});
test('remaining source expressions are classified without confusing identity and source tolerance',()=>{
  const remaining=complete.boundaryAudit.shared.filter(e=>!e.conforming),groups=new Map<string,number[]>(),audits:any[]=[],unverified:any[]=[];
  assert.equal(remaining.length,53);assert.equal(complete.parts.length,41);assert(complete.boundaryAudit.seams.every(s=>s.conforming));
  for(const {edge} of remaining){const c=ir.curves3d[ir.edges[edge].curve3d],uses=ir.trims.filter((t:any)=>t.edge===edge).map((t:any)=>{
    const s=ir.surfaces[ir.faces[ir.loops[t.loop].face].surface],c2=ir.curves2d[t.curve2d];return `S${s.degree}/${s.controlPointCount}/${s.rational}:C2${c2.degree}/${c2.controlPoints.length}/${c2.rational}`;
  }).sort();const key=`C3${c.degree}/${c.controlPoints.length}/${c.rational}|${uses.join('|')}`;groups.set(key,[...(groups.get(key)??[]),edge]);
    try{const a=auditSourceEdgeChain(ir,edge,.001);audits.push({edge,status:a.status,declaredTolerance:a.declaredTolerance,proof:a.proof,uses:a.uses});}
    catch(error){unverified.push({edge,error:String(error)});}
  }
  assert.equal(audits.length,49);assert(audits.every(a=>a.status==='not-certified-for-repair'&&a.uses.some((u:any)=>u.witness.lowerBound>1e-8)));
  assert.deepEqual(unverified.map(x=>x.edge),[35,36,40,41]);assert(unverified.every(x=>x.error.includes('trim-vertex-budget')));
  const before=JSON.stringify(complete.parts),records=[62,65,74,76].map(edge=>auditPreservedSourceVertices(ir,complete.parts,edge,.001));
  assert(records.every(r=>r.status==='requires-boundary-reconstruction'&&r.uses.some(u=>u.face===33&&u.witness.lowerBound>1e-6)));
  let references=0,maxReferenceError=0;
  for(const r of records){const curves=[ir.curves3d[ir.edges[r.edge].curve3d],...r.uses.map(u=>ir.curves2d[ir.trims[u.trim].curve2d])];
    for(const c of curves)for(const sample of c.parameterEvidence){references++;const actual=evaluateCurve(c,sample.source);maxReferenceError=Math.max(maxReferenceError,Math.hypot(...actual.map((x:number,i:number)=>x-sample.point[i])));}}
  assert(references>=456&&maxReferenceError<1e-10);assert.equal(JSON.stringify(complete.parts),before);
  mkdirSync(out,{recursive:true});writeFileSync(resolve(out,'evidence.json'),JSON.stringify({sourceSha256,archiveVersion:source.archiveVersion,metersPerUnit:.001,
    sourceUrl:'https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm',useBoundary:'official sample; local verification only; not redistributed',
    groups:[...groups].map(([pattern,edges])=>({pattern,edges})),audits,unverified,records,references,maxReferenceError,status:'partial-geometry-preview'},null,2));
  console.log(JSON.stringify({groups:groups.size,references,maxReferenceError,witnesses:records.map(r=>({edge:r.edge,lower:r.uses.find(u=>u.face===33)!.witness.lowerBound}))}));
});
test('invalid units and mutated source points cannot generate a preserved-vertex certificate',()=>{
  assert.throws(()=>auditPreservedSourceVertices(ir,complete.parts,62,NaN),/budget/);
  const parts=complete.parts.filter(p=>[25,33].includes(p.face)).map(p=>structuredClone(p)),p=parts.find(p=>p.face===33)!;
  const id=p.boundaryEdges.find((b:any)=>b.edge===62).vertices[0];p.mesh.positions[id][2]+=.01;
  assert.throws(()=>auditPreservedSourceVertices(ir,parts,62,.001),/not-on-source/);
});
test('a preserved exact line is not rejected, while a nearby source-plane vertex is classified separately',()=>{
  const surface={degree:[1,1],controlPointCount:[2,2],rational:false,parameterMap:{kind:'identity'},domain:[[0,1],[0,1]],knots:[[0,0,1,1],[0,0,1,1]],controlPoints:[[0,0,0],[1,0,0],[0,1,0],[1,1,0]]};
  const curve={dimension:3,degree:1,rational:false,parameterMap:{kind:'identity'},knots:[0,0,1,1],controlPoints:[[0,0,0],[1,0,0]]};
  const source={edges:[{curve3d:0,tolerance:.005,sourceSubdomain:[0,1]}],curves3d:[curve],surfaces:[surface],faces:[{surface:0},{surface:0}]};
  const parts=[0,1].map(face=>({face,boundaryEdges:[{edge:0,trim:face,vertices:[0,1,2]}],audit:{uv:[[0,0],[.5,0],[1,0]]},mesh:{positions:[[0,0,0],[.5,0,0],[1,0,0]]}}));
  assert.equal(auditPreservedSourceVertices(source,parts,0,.001).status,'no-preserved-vertex-obstruction-found');
  parts[0].audit.uv[1][1]=.001;parts[0].mesh.positions[1][1]=.001;
  const before=JSON.stringify(parts),result=auditPreservedSourceVertices(source,parts,0,.001);
  assert.equal(result.status,'requires-boundary-reconstruction');assert(result.uses[0].witness.lowerBound>.00099);
  assert(result.uses[0].witness.lowerBound<result.declaredTolerance);assert.equal(JSON.stringify(parts),before);
});
