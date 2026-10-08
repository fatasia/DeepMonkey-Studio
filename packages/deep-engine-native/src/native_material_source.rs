pub(super) fn compose(source:&str)->String {
    source.replace("advanced0: vec4f, advanced1: vec4f, advanced2: vec4f,",
        "advanced0: vec4f, advanced1: vec4f, advanced2: vec4f,\n  specular_row_0: vec4f, specular_row_1: vec4f,\n  specular_color_row_0: vec4f, specular_color_row_1: vec4f, specular_values: vec4f,")
        .replace("brdfWithDielectricF0(normal, view,", "native_specular_brdf(normal, view,")
        .replace("deepDirectMultiscatteringEnergy(mix(vec3f(dielectric), base, metal), dfg_view, dfg_light)",
            "native_specular_direct_energy(native_specular_f0(base,metal,dielectric),native_specular_f90(metal),dfg_view,dfg_light)")
        .replace("let f0 = mix(vec3f(dielectric), base, metal);", "let f0 = native_specular_f0(base,metal,dielectric);")
        .replace("f0 * dfg.x + dfg.y", "f0 * dfg.x + native_specular_f90(metal) * dfg.y")
        .replace("color += (1.0 - specular_fraction) *", "color += (1.0 - native_material_transmission) * (1.0 - specular_fraction) *")
        .replace("color += base * (1.0 - metal) * probe_irradiance", "color += (1.0 - native_material_transmission) * base * (1.0 - metal) * probe_irradiance")
        .replace("color += irradiance * base *", "color += (1.0 - native_material_transmission) * irradiance * base *")
        .replace("  color += input.emissive_alpha.rgb * emission;\n  return color;",
            "  color += native_transmission_response(input,normal,view,base,metal,rough,dielectric);\n  color += input.emissive_alpha.rgb * emission;\n  return color;")
        .replace("  if (section_rejected(input.world)) { discard; }\n  var base_sample", "  native_sample_specular(input);\n  if (section_rejected(input.world)) { discard; }\n  var base_sample")
        .replace(" && ext1.y == 0.0", "").replace(" || ext1.y != 0.0", "")
        .replace("DeepMaterialEvalParams(ext0.x, ext0.y, ext0.z, ext0.w, ext1.x, ext1.y)",
            "DeepMaterialEvalParams(ext0.x, ext0.y, ext0.z, ext0.w, ext1.x, 0.0)")
}
