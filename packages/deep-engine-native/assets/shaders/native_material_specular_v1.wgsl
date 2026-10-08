var<private> native_specular_color: vec3f = vec3f(1.0);
var<private> native_specular_factor: f32 = 1.0;
var<private> native_material_transmission: f32 = 0.0;
@group(1) @binding(20) var native_specular_map: texture_2d<f32>;
@group(1) @binding(21) var native_specular_sampler: sampler;
@group(1) @binding(22) var native_specular_color_map: texture_2d<f32>;
@group(1) @binding(23) var native_specular_color_sampler: sampler;
fn native_sample_specular(input: VertexOutput) {
  native_specular_factor = material_textures.specular_values.w;
  native_specular_color = material_textures.specular_values.rgb;
  native_material_transmission = select(0.0, clamp(material_textures.extended1.y, 0.0, 1.0), deep_native_extended);
  if (material_textures.specular_row_0.w > 0.5) {
    native_specular_factor *= textureSample(native_specular_map, native_specular_sampler,
      transformed_uv(input.uv0,input.uv1,material_textures.specular_row_0,material_textures.specular_row_1)).a;
  }
  if (material_textures.specular_color_row_0.w > 0.5) {
    native_specular_color *= textureSample(native_specular_color_map,native_specular_color_sampler,
      transformed_uv(input.uv0,input.uv1,material_textures.specular_color_row_0,material_textures.specular_color_row_1)).rgb;
  }
}
fn native_specular_f0(base:vec3f,metal:f32,dielectric:f32)->vec3f {
  return mix(min(vec3f(dielectric)*native_specular_color,vec3f(1.0))*native_specular_factor,base,metal);
}
fn native_specular_f90(metal:f32)->f32 { return mix(native_specular_factor,1.0,metal); }
fn native_specular_brdf(n:vec3f,v:vec3f,l:vec3f,base:vec3f,metal:f32,rough:f32,dielectric:f32)->vec3f {
  if (native_specular_factor == 1.0 && all(native_specular_color == vec3f(1.0)) && native_material_transmission == 0.0) {
    return brdfWithDielectricF0(n,v,l,base,metal,rough,dielectric);
  }
  let h=safeNormalize(v+l,n); let nv=clamp(dot(n,v),0.0001,1.0); let nl=clamp(dot(n,l),0.0,1.0);
  let nh=clamp(dot(n,h),0.0,1.0); let vh=clamp(dot(v,h),0.0,1.0);
  let alpha=rough*rough; let a2=alpha*alpha; let denom=nh*nh*(a2-1.0)+1.0;
  let distribution=a2/max(3.14159265*denom*denom,0.000001);
  let gv=nl*sqrt(a2+(1.0-a2)*nv*nv); let gl=nv*sqrt(a2+(1.0-a2)*nl*nl);
  let visibility=0.5/max(gv+gl,0.000001);
  let factor=exp2((-5.55473*vh-6.98316)*vh);
  let fresnel=native_specular_f0(base,metal,dielectric)*(1.0-factor)+native_specular_f90(metal)*factor;
  let diffuse=(1.0-native_material_transmission)*(1.0-metal)*base/3.14159265;
  return (diffuse+fresnel*visibility*distribution)*nl;
}
fn native_specular_direct_energy(f0:vec3f,f90:f32,dfg_view:vec2f,dfg_light:vec2f)->vec3f {
  if (f90 == 1.0) { return deepDirectMultiscatteringEnergy(f0,dfg_view,dfg_light); }
  let single_view=f0*dfg_view.x+f90*dfg_view.y;
  let single_light=f0*dfg_light.x+f90*dfg_light.y;
  let lost_view=1.0-(dfg_view.x+dfg_view.y); let lost_light=1.0-(dfg_light.x+dfg_light.y);
  let average=f0+(vec3f(f90)-f0)*0.047619;
  return single_view*single_light*average/(1.0-lost_view*lost_light*average+0.000001)*lost_view*lost_light;
}
