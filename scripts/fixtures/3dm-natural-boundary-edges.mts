import { evaluateCurve } from './3dm-nurbs-parameters.mjs';
/** Source trim identity for the rectangular strip mesh, including both uses of a periodic seam. */
export function naturalBoundaryEdges(ir:any,face:any,domain:number[][],curved:number,parameters:number[],closed:boolean) {
  const n=parameters.length,linear=1-curved;
  return ir.loops[face.loops[0]].trims.map((index:number)=>{
    const trim=ir.trims[index],curve=ir.curves2d[trim.curve2d],ends=trim.sourceSubdomain.map((t:number)=>evaluateCurve(curve,t));
    if(trim.curveReversed)ends.reverse();let vertices:number[];
    if(Math.abs(ends[0][linear]-ends[1][linear])<1e-9){
      const row=Math.abs(ends[0][linear]-domain[linear][0])<1e-9?0:1;
      vertices=parameters.map((_,i)=>row*n+i);if(closed)vertices.push(row*n);
      if(ends[0][curved]>ends[1][curved])vertices.reverse();
    }else{
      const column=Math.abs(ends[0][curved]-domain[curved][0])<1e-9||closed?0:n-1;
      vertices=[column,column+n];if(ends[0][linear]>ends[1][linear])vertices.reverse();
    }
    return {edge:trim.edge,trim:index,vertices};
  });
}
