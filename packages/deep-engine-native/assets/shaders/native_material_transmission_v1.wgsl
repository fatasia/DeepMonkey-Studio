@group(0) @binding(13) var native_scene_opaque: texture_2d<f32>;
fn native_scene_transmission_sample(world:vec3f,normal:vec3f,view:vec3f,ior:f32,roughness:f32)->vec4f {
  let clip=frame.view*vec4f(world,1.0);
  if (clip.w <= 0.00000001) { return vec4f(0.0); }
  let uv=vec2f(clip.x/clip.w*0.5+0.5,0.5-clip.y/clip.w*0.5);
  if (any(uv<vec2f(0.0)) || any(uv>vec2f(1.0))) { return vec4f(0.0); }
  let size=vec2f(textureDimensions(native_scene_opaque)); let half_texel=0.5/size;
  let center=clamp(uv,half_texel,vec2f(1.0)-half_texel);
  let rough=clamp(roughness*clamp(ior*2.0-2.0,0.0,1.0),0.0,1.0);
  if (rough<=0.0001) { return textureSampleLevel(native_scene_opaque,environment_sampler,center,0.0); }
  let radius=rough*rough*32.0/size;
  var color=vec4f(0.0);
  color+=textureSampleLevel(native_scene_opaque,environment_sampler,clamp(center+vec2f(radius.x,0.0),half_texel,vec2f(1.0)-half_texel),0.0);
  color+=textureSampleLevel(native_scene_opaque,environment_sampler,clamp(center-vec2f(radius.x,0.0),half_texel,vec2f(1.0)-half_texel),0.0);
  color+=textureSampleLevel(native_scene_opaque,environment_sampler,clamp(center+vec2f(0.0,radius.y),half_texel,vec2f(1.0)-half_texel),0.0);
  color+=textureSampleLevel(native_scene_opaque,environment_sampler,clamp(center-vec2f(0.0,radius.y),half_texel,vec2f(1.0)-half_texel),0.0);
  return color*0.25;
}
fn native_transmission_response(input:VertexOutput,normal:vec3f,view:vec3f,base:vec3f,metal:f32,rough:f32,dielectric:f32)->vec3f {
  if (native_material_transmission<=0.0) { return vec3f(0.0); }
  let ior=select(1.5,material_textures.extended0.x,material_textures.extended0.x>=1.0);
  let nv=clamp(dot(normal,view),0.001,1.0);
  let dfg=textureSampleLevel(brdf_lut,environment_sampler,vec2f(nv,rough),0.0).rg;
  let weight=(vec3f(1.0)-(native_specular_f0(base,metal,dielectric)*dfg.x+native_specular_f90(metal)*dfg.y))*(1.0-metal)*base;
  let scene=native_scene_transmission_sample(input.world,normal,view,ior,rough);
  if (scene.a>0.0) {
    let exposure=select(1.0,max(frame.lightingOptions.x,0.00000001),frame.sunColor.w>=2.0);
    return native_material_transmission*scene.rgb*weight/exposure;
  }
  let direction=safeNormalize(refract(-view,normal,1.0/ior),-view);
  let radiance=textureSampleLevel(specular_environment,environment_sampler,direction,
    rough*clamp(ior*2.0-2.0,0.0,1.0)*f32(textureNumLevels(specular_environment)-1u)).rgb;
  return native_material_transmission*radiance*weight;
}
