import type { PreparedPacket, GeometryResource, RenderPacket } from "../renderPacket.js";
import type { PacketBufferStagingContext } from "./packetBufferStaging.js";

/** Check before prepareRenderPacket filters unused geometry resources. */
export function assertVertexPacketMembership(id:string|undefined,packet:RenderPacket):void {
  if(id===undefined || (!packet.geometries.length && !packet.instances.length))return;
  if(packet.geometries.length!==1 || packet.instances.length!==1)
    throw Error("Vertex streaming requires exactly one geometry and one instance.");
}

/** Narrow opt-in on the existing packet publication; default packets do no work here. */
export function admitPacketVertexStreaming(context: PacketBufferStagingContext, next: PreparedPacket): void {
  const id=context.vertexStreamingGeometry;
  if(id===undefined) return;
  if(!id.trim() || id.length>256) throw Error("Vertex streaming geometry identity is invalid.");
  // An empty packet is the existing explicit clear/dispose boundary.
  if(!next.geometries.size && !next.batches.length) return;
  const geometry=next.geometries.get(id), selected=next.batches.filter(batch=>batch.geometry===id);
  if(next.geometries.size!==1 || next.batches.length!==1 || !geometry || geometry.tangents || next.deformation || next.textures.length
    || selected.length!==1 || selected[0]!.count!==1
    || next.batches.some(batch=>batch.lod || batch.pose || batch.textures)) {
    throw Error("Vertex streaming requires one fixed untextured instance, no LOD/pose/tangents/deformation.");
  }
  if(!context.geometries.size) return;
  if(next.geometries.size!==context.geometries.size || next.batches.length!==context.batches.size)
    throw Error("Vertex streaming cannot change packet membership.");
  for(const [key,source] of next.geometries) {
    const previous=context.geometries.get(key)?.source;
    if(!previous || (key!==id && !sameGeometry(previous,source)))
      throw Error("Vertex streaming cannot replace static geometry.");
  }
  for(const batch of next.batches) {
    const previous=context.batches.get(batch.key)?.source;
    if(!previous || !equal(previous.data,batch.data) || metadata(previous)!==metadata(batch))
      throw Error("Vertex streaming requires fixed instances and material state.");
  }
}
function metadata(batch: PreparedPacket["batches"][number]): string {
  const {data:_data,sortCenter:_center,...rest}=batch;
  return JSON.stringify(rest);
}
function sameGeometry(a:GeometryResource,b:GeometryResource):boolean {
  return a.revision===b.revision && equal(a.vertices,b.vertices) && equal(a.indices,b.indices)
    && optional(a.uv0,b.uv0) && optional(a.uv1,b.uv1) && optional(a.colors,b.colors) && optional(a.tangents,b.tangents);
}
const equal=(a:Float32Array|Uint32Array,b:Float32Array|Uint32Array)=>a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]));
const optional=(a:Float32Array|undefined,b:Float32Array|undefined)=>a===undefined?b===undefined:b!==undefined&&equal(a,b);
