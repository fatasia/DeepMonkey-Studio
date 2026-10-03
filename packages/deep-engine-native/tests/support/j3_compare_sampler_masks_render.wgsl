@group(0) @binding(0) var<uniform> mode: vec4u;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0.5,1);
}
@fragment fn depth(@builtin(position) p:vec4f)->@builtin(frag_depth) f32 {
  let x=u32(p.x);let y=u32(p.y);
  let bit=(mode.x >> ((y%2u)*2u+x%2u))&1u;
  return select(0.25,0.75,bit==1u);
}
