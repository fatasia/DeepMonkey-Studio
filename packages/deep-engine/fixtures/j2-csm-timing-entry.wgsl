@vertex fn probeVertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  return vec4f(p[i],0,1);
}
@fragment fn probeFragment(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let depths = array<f32,3>(TIMING_DEPTHS);
  let us = array<f32,7>(TIMING_UVS);
  let pixel = u32(p.x);
  let world = vec3f(us[pixel % 7u]*2.0-1.0,0,depths[pixel % 3u]);
  return vec4f(shadow_visibility(world,vec3f(0),1.0),0,0,1);
}
