/**
 * 帧 uniform 96 字(f32)槽位表 + RT/级联逐像素混合 ABI 审计(B3 收口,2026-10-06)。
 *
 * == 审计范围 ==
 * 上一批(4988df13)交付的帧粒度 RT mask/级联选路遗留"按像素距离混合需帧 uniform
 * ABI 新槽位"欠账。本模块给出台账级槽位表并对"能否再开槽"给出裁决;消费方合同
 * 三点交叉验证:WGSL 单源 Frame struct(frameAbi/generated/frameStructsWgsl.ts,
 * schema 钉 sha256)、宿主打包(pbrFrameUniforms.updatePbrFrameUniforms)、着色消费
 * (pbrShader.ts/pbrFogWgsl.ts 的 frame.* 引用)。逐字对拍见同目录
 * frameUniformSlotTable.test.ts(真打包运行时断言,非源码字符串扫)。
 *
 * == 槽位表(TS 宿主 Frame uniform,96 f32 = 384B;WGSL struct Frame 单源同序) ==
 *   [0..15]  currentViewProjection  深度/主 VP(TAA 抖动后;depth 重建族消费)
 *   [16..31] previousViewProjection 上一帧 VP(T07 运动向量;cameraFrameHistory)
 *   [32..47] worldToView            相机相对世界→视(megaLights 重建/SSR 族消费)
 *   [48..63] light                  内建地面正交光矩阵(行 3 = 地面偏移)
 *   [64..67] eye                    xyz=帧 eye(相机相对);w=环境开关位(1/0,
 *                                   pbrShader irradiance/radiance 门)
 *   [68..71] background             rgb=背景色;w=castShadow 开关位(1/0;M2 复用,
 *                                   "background.w 复用"先例,宿主打包 word 71)
 *   [72..75] floor                  rgb=地面 albedo;w=groundGrid 开关位
 *   [76..79] lightDirection         xyz=primary surfaceToLight(世界);
 *                                   w=environmentIntensity(0..64,环境缩放)
 *   [80..83] tuning                 x/y=jitterDeltaUv(T07);z=预览 roughness;
 *                                   w=fog 密度门(pbrFogWgsl frame.tuning.w≤0 短路)
 *   [84..87] sunColor               rgb=primary 色;w=primary 强度
 *   [88..95] output(DeepOutputSettings,8 字)
 *                                   [88]=exposure [89]=bloom 保留槽→RT 阴影开关位
 *                                   (M2 复用,>0.5 采样 r32float mask;RT 档分支,
 *                                   默认档剥离) [90]=vignette [91]=toneMapping
 *                                   [92..95]=colorGrading(temperature/tint/
 *                                   contrast/saturation)
 *
 * == 裁决:96 字满载,无空闲槽位;逐像素混合不硬塞,登记下一切片 ==
 * 全部 96 字均有在途消费方;历史上两个"保留槽"(background.w、output.bloom)已分别
 * 被 castShadow 与 RT 阴影开关位占用。逐像素 RT/级联距离混合的真实需求是:
 *   (a) 逐像素混合因子(mask 纹理或距离场)——本就不该放帧 uniform(逐像素数据),
 *       走 group(2) 纹理槽(RT 档管线变体已存在,加 binding 需管线变体扩容);
 *   (b) 一个混合区间标量(如 blendRange 米)——96 字内无空位,唯一非破坏路径是
 *       frame-abi.schema 扩展(DeepOutputSettings 增字或新尾段)→ 双端(TS/Rust
 *       596 字 ledger)再生成 → 所有 chunker/parity 测试连带刷新,blast radius
 *       覆盖两包,不属于本切片。
 * 结论:帧粒度选路(质量档+健康度+滞回,rtShadowScheduling)已覆盖 RT/级联调度
 * 需求;逐像素距离混合如实降级登记为下一切片,前置条件 = schema 扩展单源再生成
 * (或与 DeepOutputSettings 下一批扩展合并规划)。禁止在现有槽位上"借位"复用——
 * 该两槽的先例已证明借位会让开关语义散落进打包细节(见 output.bloom 双重语义)。
 */

/** 帧uniform 字段槽位(字偏移为 f32 下标;与 FRAME_STRUCTS_WGSL 字段序逐字互钉)。 */
export interface FrameUniformSlot {
  readonly name: string;
  readonly wgslField: string;
  /** 起始 f32 字下标(含)。 */
  readonly wordStart: number;
  /** 字数(mat4=16,vec4=4)。 */
  readonly words: number;
  readonly note: string;
}

export const FRAME_UNIFORM_SLOTS: readonly FrameUniformSlot[] = [
  { name: "currentViewProjection", wgslField: "currentViewProjection", wordStart: 0, words: 16,
    note: "主/深度 VP(TAA 抖动后);depth 重建族与 motion 消费" },
  { name: "previousViewProjection", wgslField: "previousViewProjection", wordStart: 16, words: 16,
    note: "上一帧 VP(T07 motion;cameraFrameHistory 供给)" },
  { name: "worldToView", wgslField: "worldToView", wordStart: 32, words: 16,
    note: "相机相对 world→view;megaLights 表面重建/反射通道同源" },
  { name: "light", wgslField: "light", wordStart: 48, words: 16,
    note: "内建地面正交光矩阵(行 3 = 地面偏移)" },
  { name: "eye", wgslField: "eye", wordStart: 64, words: 4,
    note: "xyz=帧 eye(相机相对);w=环境开关位(1/0)" },
  { name: "background", wgslField: "background", wordStart: 68, words: 4,
    note: "rgb=背景色;w=castShadow 开关位(M2 借位复用先例)" },
  { name: "floor", wgslField: "floor", wordStart: 72, words: 4,
    note: "rgb=地面 albedo;w=groundGrid 开关位" },
  { name: "lightDirection", wgslField: "lightDirection", wordStart: 76, words: 4,
    note: "xyz=primary surfaceToLight;w=environmentIntensity(0..64)" },
  { name: "tuning", wgslField: "tuning", wordStart: 80, words: 4,
    note: "xy=jitterDeltaUv;z=预览 roughness;w=fog 密度门(≤0 短路)" },
  { name: "sunColor", wgslField: "sunColor", wordStart: 84, words: 4,
    note: "rgb=primary 色;w=primary 强度" },
  { name: "output", wgslField: "output", wordStart: 88, words: 8,
    note: "DeepOutputSettings:[88]=exposure [89]=bloom→RT 阴影开关位(借位复用) [90]=vignette [91]=toneMapping [92..95]=colorGrading" },
] as const;

/** 帧 uniform 总字数(schema 单源 FRAME_ABI_TS_FLOATS 同值;此处独立成字面量供双源对拍)。 */
export const FRAME_UNIFORM_TOTAL_WORDS = 96;
/** 历史借位槽位登记(审计重点:这些字同时承载两个语义,是逐像素混合不得继续借位的依据)。 */
export const FRAME_UNIFORM_REUSED_WORDS: readonly { readonly word: number; readonly primary: string;
  readonly reusedBy: string }[] = [
  { word: 71, primary: "background.w(保留)", reusedBy: "castShadow 开关位(M2)" },
  { word: 89, primary: "output.bloom(保留)", reusedBy: "RT 阴影开关位(M2,>0.5 采样 mask)" },
] as const;

/** 逐像素 RT/级联混合的 ABI 裁决(本模块头注释的机读形态)。 */
export const RT_SHADOW_PER_PIXEL_BLEND_VERDICT = {
  /** 96 字内无空闲槽位。 */
  freeWords: 0,
  /** 帧粒度选路(rtShadowScheduling)已覆盖调度需求。 */
  frameGranularitySufficient: true,
  /** 逐像素混合属下一切片:前置 = frame-abi.schema 扩展单源再生成(TS+Rust 双端)。 */
  perPixelBlendDeferred: true,
  /** 禁止继续借位(71/89 两槽先例:开关语义散落进打包细节)。 */
  furtherWordReuseForbidden: true,
} as const;
