import { tessellatePlanarFace } from './3dm-planar-trim.mts';
import { tessellateSphereFace } from './3dm-sphere-tessellation.mts';
import { tessellateCylinderFace } from './3dm-cylinder-tessellation.mts';
import { tessellateConeFace } from './3dm-cone-tessellation.mts';
import { refineCylinderBoundaries } from './3dm-refine-cylinder-boundaries.mts';
import { auditBrepBoundaries } from './3dm-brep-boundary-audit.mts';

/** Preserve saved meshes, reconstruct only supported missing faces, retain per-face diagnostics. */
export function completeBrepParts(object: any) {
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
      parts.push(tessellate(object.cadIr,face));
    } catch(error) {
      diagnostics.push({objectId:object.id,face,code:error instanceof Error?error.message:'trim-tessellation-failed'});
    }
  }
  let refined=parts,refinements:any[]=[];
  try {const result=refineCylinderBoundaries(object.cadIr,parts);refined=result.parts;refinements=result.records;
    diagnostics.push(...result.failures.map(failure=>({objectId:object.id,...failure})));}
  catch(error){diagnostics.push({objectId:object.id,code:error instanceof Error?error.message:'boundary-refinement-failed',detail:error instanceof Error?error.cause:undefined});}
  const boundaryAudit=object.cadIr.edges&&object.cadIr.trims&&object.cadIr.loops?auditBrepBoundaries(object.cadIr,refined):null;
  for(const edge of boundaryAudit?.shared??[])if(!edge.conforming)diagnostics.push({objectId:object.id,code:'nonconforming-brep-boundary',edge:edge.edge});
  return {parts:refined,diagnostics,boundaryAudit,refinements};
}
