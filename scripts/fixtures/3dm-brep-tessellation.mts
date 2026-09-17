import { tessellatePlanarFace } from './3dm-planar-trim.mts';
import { tessellateSphereFace } from './3dm-sphere-tessellation.mts';

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
      parts.push(support?.kind==='sphere'?tessellateSphereFace(object.cadIr,face):tessellatePlanarFace(object.cadIr,face));
    } catch(error) {
      diagnostics.push({objectId:object.id,face,code:error instanceof Error?error.message:'trim-tessellation-failed'});
    }
  }
  return {parts,diagnostics};
}
