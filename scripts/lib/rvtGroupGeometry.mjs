// Persisted group geometry is a reference graph, distinct from the logical
// group-placement record. Applying both would transform members twice.
const requireValue=(ok,message)=>{if(!ok)throw Error(message);};
const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
export function validateRigid(matrix){
  requireValue(matrix.length===12&&matrix.every(Number.isFinite),'non-finite group matrix');
  const axes=[matrix.slice(0,3),matrix.slice(3,6),matrix.slice(6,9)];
  requireValue(axes.every(a=>Math.abs(Math.hypot(...a)-1)<1e-10)&&axes.every((a,i)=>Math.abs(dot(a,axes[(i+1)%3]))<1e-10),'non-rigid group matrix');
  const [a,b,c]=axes,det=a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]);
  requireValue(Math.abs(Math.abs(det)-1)<1e-10,'singular group matrix');return det;
}
export function decodeGroupGeometry(bytes,element){
  requireValue(Buffer.isBuffer(bytes)&&bytes.length>=100,'truncated group geometry');
  requireValue(bytes.readBigUInt64LE(0)===BigInt(element)&&bytes.readUInt32LE(26)===element,'group source ID mismatch');
  requireValue(bytes.readUInt32LE(12)===bytes.length-20&&bytes.readUInt32LE(bytes.length-4)===bytes.length-20,'group framing');
  requireValue(bytes.subarray(16,26).equals(Buffer.from('3f08ffffffffffffffff','hex')),'group carrier');
  requireValue([0x88004,0x8c004].includes(bytes.readUInt32LE(34))&&bytes.readUInt32LE(42)===3,'group reference profile');
  const count=bytes.readUInt32LE(38),start=bytes.length-4-count*112;
  requireValue(count>0&&count<=100000&&start>=46+count*6+32,'group reference count');
  for(let i=0;i<count-1;i++)requireValue(bytes.readUInt16LE(46+i*6)===0x820&&bytes.readUInt32LE(48+i*6)===i+4,'group reference index');
  requireValue(bytes.readUInt16LE(46+(count-1)*6)===0x820,'group reference index terminator');
  requireValue(bytes.subarray(start-32,start).equals(Buffer.from('0000000004800800ffffffff310900000000fffffffffffffffffecf00000000','hex')),'group reference-list marker');
  const references=[];
  for(let i=0;i<count;i++){
    const at=start+i*112,matrix=Array.from({length:12},(_,k)=>bytes.readDoubleLE(at+k*8));
    const determinant=validateRigid(matrix),id=bytes.readBigUInt64LE(at+96);
    requireValue(id>0&&id<=BigInt(Number.MAX_SAFE_INTEGER)&&bytes.readUInt32LE(at+104)===0&&bytes.readUInt32LE(at+108)===1,'group reference framing');
    references.push({element:Number(id),matrix,determinant,sourceOffset:at,referenceIndex:i});
  }
  return {element,references};
}
export function applyGroupReference(solid,reference,instance){
  requireValue(solid.element===reference.element,'group member ID mismatch');
  const m=reference.matrix,det=validateRigid(m);
  const verticesFeet=solid.verticesFeet.map(p=>[0,1,2].map(k=>m[k]*p[0]+m[k+3]*p[1]+m[k+6]*p[2]+m[k+9]));
  return {...solid,verticesFeet,triangles:solid.triangles.map(t=>det<0?[t[0],t[2],t[1]]:[...t]),
    instancePath:`group:${instance}/reference:${reference.referenceIndex}/element:${solid.element}`,
    placement:{instance,matrix:[...m],determinant:det,sourceOffset:reference.sourceOffset,source:'persisted-group-geometry-reference'}};
}
export function resolveGroupReference({member,metadata,groupHeader,groupRecord}){
  const h=Buffer.from(groupHeader.hex,'hex'),instance=groupHeader.element;
  requireValue(h.length>=136&&h.readBigUInt64LE(0)===BigInt(instance)&&h.readUInt32LE(12)===1439&&h.readBigInt64LE(18)===-2000095n,'group metadata category');
  requireValue(h.readUInt32LE(66)===0xffffef7f,'group is not a placed instance');
  requireValue(metadata.length>0&&metadata.every(m=>m.element===member&&!m.standalone&&m.containerRaw===h.readBigUInt64LE(50).toString()),'group owner mismatch');
  requireValue(groupRecord.element===instance,'group record/header ID mismatch');
  const group=decodeGroupGeometry(Buffer.from(groupRecord.hex,'hex'),instance),matches=group.references.filter(r=>r.element===member);
  // Repeated references are separate instance paths, never deduplicated by ID.
  requireValue(matches.length>0,'member absent from group geometry');
  // The real retained corpus proves identity references only. Rotation/basis
  // ordering needs a nonidentity source witness before export is enabled.
  const identity=[1,0,0,0,1,0,0,0,1,0,0,0];
  requireValue(matches.every(r=>r.matrix.every((v,k)=>Math.abs(v-identity[k])<=1e-12)),'nonidentity group reference requires source witness');
  return matches.map(reference=>({...reference,instance}));
}
