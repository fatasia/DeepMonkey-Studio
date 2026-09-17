import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {completeBrepParts} from './3dm-brep-tessellation.mts';
import {proveSourceIsocurve} from './3dm-source-isocurve.mts';
import {auditSourceEdgeChain} from './3dm-source-edge-chain.mts';
import {provePlaneTrimIdentity} from './3dm-source-curve-identity.mts';
import {synchronizeSourceEdges} from './3dm-synchronize-source-edges.mts';
import {auditBrepBoundaries} from './3dm-brep-boundary-audit.mts';
const root=resolve(import.meta.dirname,'../..');
const path=resolve(root,'data/external-assets/industrial-format-plan/dependencies/extracted/opennurbs-v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm');
const sourceSha256=createHash('sha256').update(readFileSync(path)).digest('hex');
if(sourceSha256!=='a1b0ef69925b5d9223a7d797033055bb766842768a96f7713e1ecaec2763bb31')throw Error('source-hash-mismatch');
const run=spawnSync(resolve(root,'test-output/3dm-source-audit/3dm-source-audit.exe'),[path,'--parameter-evidence-all'],{encoding:'utf8',maxBuffer:128*1024*1024});
if(run.status!==0)throw Error(run.stderr);const source=JSON.parse(run.stdout),object=source.objects.find((o:any)=>o.cadIr),ir=object.cadIr;
object.storedRenderMeshes=[];const complete=completeBrepParts(object,.001);
const baseline=complete.parts;
const records=auditBrepBoundaries(ir,baseline).shared.filter((e:any)=>!e.conforming).map((e:any)=>{
  const edge=ir.edges[e.edge],c3=ir.curves3d[edge.curve3d];
  const uses=ir.trims.flatMap((t:any,i:number)=>t.edge===e.edge?[{...t,index:i}]:[]).map((t:any)=>{
    const face=ir.loops[t.loop].face,s=ir.surfaces[ir.faces[face].surface],c=ir.curves2d[t.curve2d],part=baseline.find((p:any)=>p.face===face);
    let proof;try{proof=(part.geometrySource==='cad-ir-affine-plane-trim'?provePlaneTrimIdentity(ir,face,e.edge):proveSourceIsocurve(ir,part,e.edge)).continuousBound;}catch(error){proof=String(error);}
    return {face,trim:t.index,geometrySource:part.geometrySource,surface:{degree:s.degree,count:s.controlPointCount,rational:s.rational},
      c2:{degree:c.degree,count:c.controlPoints.length,points:c.controlPoints.length===2?c.controlPoints:null},proof};
  });
  let sourceAudit:any;try{sourceAudit=auditSourceEdgeChain(ir,e.edge,.001);}catch(error){sourceAudit={status:'unverified',reason:String(error)};}
  return {...e,tolerance:edge.tolerance,c3:{degree:c3.degree,count:c3.controlPoints.length,rational:c3.rational},uses,sourceAudit};
});
const out=resolve(root,'test-output/industrial-3dm/common-knot-2026-09-17-v1/survey');mkdirSync(out,{recursive:true});
writeFileSync(resolve(out,'survey.json'),JSON.stringify({sourceSha256,sourceUrl:'https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm',archiveVersion:4,metersPerUnit:.001,useBoundary:'official sample; local verification only; not redistributed',records},null,2));
writeFileSync(resolve(out,'synchronization.json'),JSON.stringify({records:complete.sourceEdgeSynchronizations,failures:synchronizeSourceEdges(ir,complete.parts,.001).failures},null,2));
console.log(JSON.stringify({edges:records.length,sourceBudgetConflicts:records.filter(r=>r.sourceAudit.status==='source-budget-conflict').length,
  notCertified:records.filter(r=>r.sourceAudit.status==='not-certified-for-repair').length,unverified:records.filter(r=>r.sourceAudit.status==='unverified').map(r=>({edge:r.edge,reason:r.sourceAudit.reason}))}));
