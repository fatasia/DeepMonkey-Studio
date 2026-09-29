// GENERATED frame struct（Rust 宿主，596f/2384B/149 行）— schema-sha256: a86ad99ec6748a2457c3a77585a2ad994ee7f6dcce7c18ffb798b322cb727bdb
// 块字段（灯阵列/阴影矩阵带）以行注释记录区间；标量/矩阵行逐行镜像。
struct NativeFrame {
  // row 0: viewProjection: mat4x4f
  // row 4: lightViewProjection: mat4x4f
  // row 8: eye: vec4f
  // row 9: legacySceneRows: vec4f
  // row 11: lightDirection: vec4f
  // row 12: legacyZeroRow: vec4f
  // row 13: sunColor: vec4f
  // row 14: exposureShadowEnabled: vec4f
  // localLights: 64 行（灯 i 起 15+i*4；第 4 行 18+i*4 为阴影记账：[2]=castShadow 槽位、[3]=near*far/(far-near)）
  // localShadowViews: 64 行（16 阴影视图矩阵）
  // row 143: fogProjection: vec4f
  // row 144: localShadowSoftness: vec4f
  // row 148: fogProfile: vec4f
};
