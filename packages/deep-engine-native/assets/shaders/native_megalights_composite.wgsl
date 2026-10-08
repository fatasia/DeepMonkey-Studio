// Bilateral upsampling keeps source depth, normal and material boundaries.
struct Params { viewport: vec2u, risViewport: vec2u, exposure: f32, reserved: f32, reserved2: vec2u, clipToView: mat4x4f };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage,read> colors: array<vec4f>;
@group(0) @binding(2) var<storage,read> surfaces: array<vec4f>;
@group(0) @binding(3) var baseMetal: texture_2d<f32>;
@group(0) @binding(4) var normalRough: texture_2d<f32>;
@group(0) @binding(5) var depth: texture_depth_multisampled_2d;
struct Vertex { @builtin(position) position: vec4f };
@vertex fn vs(@builtin(vertex_index) index:u32)->Vertex {
  var quad=array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.));return Vertex(vec4f(quad[index],0.,1.));
}
@fragment fn fs(@builtin(position) coord:vec4f)->@location(0) vec4f {
  let pixel=vec2i(coord.xy);let normal=textureLoad(normalRough,pixel,0).xyz;
  if(all(normal==vec3f(0.))) {return vec4f(0.);}
  let uv=coord.xy/vec2f(params.viewport);
  var z=textureLoad(depth,pixel,0);
  for(var i=1;i<4;i++){z=min(z,textureLoad(depth,pixel,i));}
  let p=params.clipToView*vec4f(uv.x*2.-1.,1.-uv.y*2.,z,1.);
  let viewDepth=-p.z/p.w;
  let base=textureLoad(baseMetal,pixel,0).rgb;
  // Reconstruct source normals in world space from full GBuffer sample centers.
  let samplePosition=uv*vec2f(params.risViewport)-0.5;
  let origin=vec2i(floor(samplePosition));let fraction=fract(samplePosition);
  var result=vec3f(0.);var total=0.;
  for(var y=0;y<2;y++){for(var x=0;x<2;x++){
    let source=clamp(origin+vec2i(x,y),vec2i(0),vec2i(params.risViewport)-1);
    let index=u32(source.y)*params.risViewport.x+u32(source.x);
    let sourceUv=(vec2f(source)+0.5)/vec2f(params.risViewport);
    let sourcePixel=vec2i(sourceUv*vec2f(params.viewport));
    let sourceNormal=textureLoad(normalRough,sourcePixel,0).xyz;
    let sourceDepth=-surfaces[index*3u].z;
    if(sourceDepth<=0. || abs(sourceDepth-viewDepth)>max(0.001,viewDepth*0.1)
      || dot(normalize(normal*2.-1.),normalize(sourceNormal*2.-1.))<0.9
      || distance(base,surfaces[index*3u+2u].rgb)>0.05){continue;}
    let weight=select(1.-fraction.x,fraction.x,x==1)*select(1.-fraction.y,fraction.y,y==1);
    result+=colors[index].rgb*weight;total+=weight;
  }}
  return vec4f(select(vec3f(0.),result/max(total,0.00001),total>0.)*params.exposure,0.);
}
