@group(0) @binding(0) var image:texture_depth_2d_array;
@group(0) @binding(1) var filtering:sampler_comparison;
@group(0) @binding(2) var<storage,read> query:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> result:array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) invocation:vec3u) {
  let i=invocation.x;let count=arrayLength(&query);
  if(i<count){
    let q=query[i];var pcf=0.0;
    for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
      pcf+=textureSampleCompareLevel(image,filtering,q.xy+vec2f(f32(x),f32(y))*0.25,i32(q.z),0.5);
    }}
    result[i*2u]=q;
    result[i*2u+1u]=vec4f(textureSampleCompareLevel(image,filtering,q.xy,i32(q.z),0.5),pcf/9.0,0,0);
  }
  if(i<64u){let layer=i/16u;let p=vec2i(i32(i%4u),i32((i/4u)%4u));
    result[count*2u+i]=vec4f(textureLoad(image,p,i32(layer),0),f32(p.x),f32(p.y),f32(layer));}
}
