import { tessellatePlanarFace } from './3dm-planar-trim.mts';
import { tessellateSphereFace } from './3dm-sphere-tessellation.mts';
import { tessellateCylinderFace } from './3dm-cylinder-tessellation.mts';
import { tessellateConeFace } from './3dm-cone-tessellation.mts';
import { refineCylinderBoundaries } from './3dm-refine-cylinder-boundaries.mts';
import { auditBrepBoundaries } from './3dm-brep-boundary-audit.mts';
import { weldSourceEdges } from './3dm-source-edge-weld.mts';
import { tessellateTrimmedCylinderFace } from './3dm-cylinder-trim.mts';
import { tessellateProvenCylinderFace } from './3dm-proven-cylinder.mts';
import { tessellateBicubicFace,tessellateMultispanBicubicFace } from './3dm-bicubic-face.mts';
import { tessellateRationalBezierFace } from './3dm-rational-bezier-face.mts';
import { synchronizeSourceEdges } from './3dm-synchronize-source-edges.mts';
import { reconstructPlaneSourceEdges } from './3dm-reconstruct-plane-source.mts';

/** Preserve saved meshes, reconstruct only supported missing faces, retain per-face diagnostics. */
export function completeBrepParts(object: any,metersPerUnit?:number,options:{reconstructPlaneBoundaries?:boolean}={}) {
  const parts=[...(object.storedRenderMeshes??[])], diagnostics: any[]=[];
  if(object.kind!=='brep' || !object.cadIr) return { parts, diagnostics };
  if(!Number.isInteger(object.faceCount) || object.faceCount<0 || object.faceCount>100000
    || object.cadIr.faces?.length!==object.faceCount) throw new Error('invalid-brep-face-budget');
  const saved=new Set(parts.map(part=>part.face));
  for(let face=0;face<object.faceCount;face++) {
    if(saved.has(face)) continue;
    try {
      const support=object.cadIr.surfaces[object.cadIr.faces[face].surface]?.analyticSupport;
      const tessellate=support?.kind==='sphere'?tessellateSphereFace:support?.kind==='cylinder'?tessellateCylinderFace:support?.kind==='cone'?tessellateConeFace:tessellatePlanarFace;
      try {parts.push(tessellate(object.cadIr,face));}
      catch(error) {
        const surface=object.cadIr.surfaces[object.cadIr.faces[face].surface];
        if(!support&&!surface?.rational&&surface?.degree?.every((d:number)=>d===3)&&surface.controlPointCount?.every((n:number)=>n===4)) {
          parts.push(tessellateBicubicFace(object.cadIr,face,metersPerUnit!));continue;
        }
        if(!support&&!surface?.rational&&surface?.degree?.every((d:number)=>d===3)) {
          const repeated=surface.knots.some((k:number[])=>new Set(k).size<k.length-6);
          parts.push(repeated?tessellateRationalBezierFace(object.cadIr,face,metersPerUnit!):tessellateMultispanBicubicFace(object.cadIr,face,metersPerUnit!));continue;
        }
        if(!support&&surface?.rational&&(surface.degree?.[0]===3&&surface.degree?.[1]===2
          ||surface.degree?.[0]===2&&surface.degree?.[1]===1&&surface.controlPointCount?.[0]>3)) {
          parts.push(tessellateRationalBezierFace(object.cadIr,face,metersPerUnit!));continue;
        }
        if(!support&&surface?.rational&&surface.degree?.includes(1)&&surface.degree?.includes(2)) {
          parts.push(tessellateProvenCylinderFace(object.cadIr,face,metersPerUnit!));continue;
        }
        if(support?.kind!=='cylinder'||!(error instanceof Error)||!['unsupported-natural-trim','non-isoparametric-trim','unsupported-cylinder-nurbs'].includes(error.message))throw error;
        parts.push(tessellateTrimmedCylinderFace(object.cadIr,face,metersPerUnit!));
      }
    } catch(error) {
      diagnostics.push({objectId:object.id,face,code:error instanceof Error?error.message:'trim-tessellation-failed'});
    }
  }
  let refined=parts,refinements:any[]=[],welds:any[]=[];
  if(metersPerUnit!==undefined&&object.cadIr.edges&&object.cadIr.trims&&object.cadIr.loops){
    const result=weldSourceEdges(object.cadIr,refined,metersPerUnit);refined=result.parts;welds=result.records;
    diagnostics.push(...result.failures.map(failure=>({objectId:object.id,...failure})));
  }
  try {const result=refineCylinderBoundaries(object.cadIr,refined);refined=result.parts;refinements=result.records;
    diagnostics.push(...result.failures.map(failure=>({objectId:object.id,...failure})));}
  catch(error){diagnostics.push({objectId:object.id,code:error instanceof Error?error.message:'boundary-refinement-failed',detail:error instanceof Error?error.cause:undefined});}
  let sourceEdgeSynchronizations:any[]=[];
  if(metersPerUnit!==undefined&&object.cadIr.edges&&object.cadIr.trims&&object.cadIr.loops){
    const result=synchronizeSourceEdges(object.cadIr,refined,metersPerUnit);refined=result.parts;sourceEdgeSynchronizations=result.records;
  }
  let planeSourceReconstructions:any[]=[];
  if(options.reconstructPlaneBoundaries!==false&&metersPerUnit!==undefined&&object.cadIr.edges&&object.cadIr.trims&&object.cadIr.loops){
    const result=reconstructPlaneSourceEdges(object.cadIr,refined,metersPerUnit);refined=result.parts;planeSourceReconstructions=result.records;
  }
  const boundaryAudit=object.cadIr.edges&&object.cadIr.trims&&object.cadIr.loops?auditBrepBoundaries(object.cadIr,refined):null;
  for(const edge of [...(boundaryAudit?.shared??[]),...(boundaryAudit?.seams??[])])if(!edge.conforming)diagnostics.push({objectId:object.id,code:'nonconforming-brep-boundary',edge:edge.edge});
  for(const edge of boundaryAudit?.unverified??[])if(edge.reason!=='source-edge-not-two-sided'||edge.faces.length>2)
    diagnostics.push({objectId:object.id,code:'nonconforming-brep-boundary',edge:edge.edge,reason:edge.reason});
  return {parts:refined,diagnostics,boundaryAudit,refinements,welds,sourceEdgeSynchronizations,planeSourceReconstructions};
}
