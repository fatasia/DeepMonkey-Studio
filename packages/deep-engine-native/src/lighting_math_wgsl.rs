//! J2-B1 灯光数学三件套 WGSL 单源:Rust 宿主消费端(机制沿袭 F5 试点 `probe_gi_wgsl.rs`)。
//!
//! 唯一真源是 `packages/deep-engine/wgsl/` 下的共享文件:
//! - `materialDielectric.wgsl`  介电 F0(介电 IOR → 反射率);
//! - `brdfDirectLighting.wgsl`  直射 BRDF(GGX + 相关 Smith visibility + Schlick fresnel);
//! - `brdfDirectMultiscattering.wgsl` 直射多散射能量核(DFG 采样留在各宿主);
//! - `directDfgLut185.wgsl`     直射多散射 DFG r185 同源表(C8-S9,三处直射采样点唯一来源);
//! - `iesSampling.wgsl`         IES 光域网采样(E02 采样次序合同)。
//!
//! 消费拓扑:
//! - TS 侧由 `deep-engine/src/lighting/{materialDielectric,brdfDirectLighting,iesSampling}Wgsl.ts`
//!   生成镜像(`deep-engine/scripts/syncSharedWgsl.mjs` 逐字节转写)组合进
//!   `PBR_DIRECT_LIGHTING_WGSL` / `FORWARD_PLUS_PBR_WGSL`;
//! - bin 侧 `src/frame_bindings.rs` 经 `concat!(include_str!(...))` 把同一批字节拼进
//!   native mesh shader(普通与 RT fragment 变体同源)真实消费——`concat!` 只收字符串
//!   字面量,所以 bin 侧直接 `include_str!` 而不经本模块常量;两侧引用同一文件路径,
//!   字节相同由下方对拍测试与 `frame_bindings` 消费闭环断言共同守护。
//!
//! 双端逐字节一致性对拍:共享校验和夹具
//! `packages/deep-engine/wgsl/<name>.wgsl.sha256`(`<sha256-hex> <byte-len>` 单行),
//! TS 半在对应 `*WgslChecksum.test.ts`、Rust 半在本模块测试;两半同时绿 ⇔ 双端拿到的
//! WGSL 逐字节一致。修改 WGSL 的流程:改 `.wgsl` →
//! `pnpm --filter @bim-studio/deep-engine wgsl:sync` → 同一提交带上重新生成的镜像与夹具。
//!
//! 漂移记录(J2-B1 审计):native mesh shader 原内置副本的高光乘法次序为
//! `distribution * visibility * f`,TS 权威序(白炉验收基准)为 `f * visibility * distribution`;
//! 本切片起 native 侧消费单源即随 TS 序,该次序由 `shared_brdf_keeps_ts_authoritative_specular_order`
//! 逐字锁定。CPU 参考实现 `pbr_brdf::direct_brdf` 同步对齐。

/// J2-B1 家族一:介电 F0。pbrShader.ts 以同串对扩展材质内核做 `.replace()` 手术(逐字子串合同)。
pub const MATERIAL_DIELECTRIC_WGSL: &str =
    include_str!("../../deep-engine/wgsl/materialDielectric.wgsl");

/// J2-B1 家族二:直射 BRDF。引用的 `safeNormalize` 由宿主提供(native mesh 侧有同名适配别名)。
pub const PBR_BRDF_DIRECT_LIGHTING_WGSL: &str =
    include_str!("../../deep-engine/wgsl/brdfDirectLighting.wgsl");

/// J2-B1 家族三:IES 光域网采样。引用的 `deepIesShading` storage 由宿主声明
/// (native mesh binding 9;web FORWARD_PLUS_PBR 模板为 group3/binding12,布局各宿主自持)。
pub const DEEP_IES_SAMPLING_WGSL: &str = include_str!("../../deep-engine/wgsl/iesSampling.wgsl");

pub const PBR_BRDF_DIRECT_MULTISCATTERING_WGSL: &str =
    include_str!("../../deep-engine/wgsl/brdfDirectMultiscattering.wgsl");

/// C8-S9 家族六:直射多散射 DFG r185 同源表。文件本体是裸数组字面量 +
/// `deepDirectDfg185` 采样函数(无 `var` 声明头)——native_mesh_wgsl 装配链
/// 与 Web pbrDirectMultiscatteringWgsl 模板各自补
/// `var<private> DEEP_DIRECT_DFG_185 = ` 前缀消费;TS 侧 canonical 常量
/// (halves + 解码 + CPU 查表)由 `directDfgLut185.test.ts` 锁定。
pub const DIRECT_DFG_LUT_185_WGSL: &str =
    include_str!("../../deep-engine/wgsl/directDfgLut185.wgsl");

#[cfg(test)]
mod tests {
    use super::{
        DEEP_IES_SAMPLING_WGSL, DIRECT_DFG_LUT_185_WGSL, MATERIAL_DIELECTRIC_WGSL,
        PBR_BRDF_DIRECT_LIGHTING_WGSL, PBR_BRDF_DIRECT_MULTISCATTERING_WGSL,
    };

    /// 对拍共享夹具:`<sha256-hex> <byte-len>` 单行;内容或长度任一漂移即失败。
    fn assert_matches_pinned_checksum(wgsl: &str, fixture: &str, label: &str) {
        let mut fields = fixture.split_whitespace();
        let expected_checksum = fields.next().expect("checksum fixture missing sha256 hex");
        let expected_bytes: usize = fields
            .next()
            .expect("checksum fixture missing byte length")
            .parse()
            .expect("checksum fixture byte length must be a usize");
        assert_eq!(
            expected_checksum.len(),
            64,
            "{label}: fixture must hold a sha256 hex digest"
        );
        assert_eq!(
            wgsl.len(),
            expected_bytes,
            "{label}: byte length drifted from fixture"
        );
        assert_eq!(
            crate::shader_package::hash::sha256(wgsl.as_bytes()),
            expected_checksum,
            "{label}: content drifted from pinned cross-host checksum"
        );
    }

    #[test]
    fn shared_direct_multiscattering_matches_checksum_and_both_consumers() {
        assert_matches_pinned_checksum(
            PBR_BRDF_DIRECT_MULTISCATTERING_WGSL,
            include_str!("../../deep-engine/wgsl/brdfDirectMultiscattering.wgsl.sha256"),
            "brdfDirectMultiscattering",
        );
        // I-C23 起:直射多散射消费点抽到 native_mesh_v1.wgsl 的
        // native_lit_response 共享函数(直射两处:主太阳 + 局部光),RT 变体
        // 经函数共享,不再自带文本副本(单源合同,与 white_furnace 锁同构)。
        let mesh = include_str!("../assets/shaders/native_mesh_v1.wgsl");
        let rt = include_str!("../assets/shaders/native_mesh_rt_fragment_v1.wgsl");
        assert_eq!(
            mesh.matches("color += native_direct_multiscattering(")
                .count(),
            2,
            "mesh body must hold both direct multiscattering sites (sun + local)"
        );
        assert_eq!(
            mesh.matches("vec2f(nv, rough), 0.0).rg").count(),
            1,
            "mesh body must hold the single nv LUT sample inside native_lit_response"
        );
        assert_eq!(
            rt.matches("color += native_direct_multiscattering(")
                .count(),
            0,
            "RT fragment must not carry a multiscattering text copy"
        );
        // C9/native(2026-10-06):RT 像素路与栅格路共用 native_extended_shade
        // (其内部仍是唯一的 native_lit_response 共享核,零带回退逐位一致)。
        assert_eq!(
            rt.matches("native_extended_shade(").count(),
            1,
            "RT fragment must consume the shared extended response wrapper (single site, both entries)"
        );
        assert_eq!(
            rt.matches("native_lit_response(").count(),
            0,
            "RT fragment must not bypass the extended wrapper for the lit core"
        );
    }

    #[test]
    fn shared_material_evaluate_core_matches_checksum_and_layer_consumer() {
        let core = include_str!("../../deep-engine/wgsl/materialEvaluateCore.wgsl");
        assert_matches_pinned_checksum(
            core,
            include_str!("../../deep-engine/wgsl/materialEvaluateCore.wgsl.sha256"),
            "materialEvaluateCore",
        );
        assert!(!core.contains("@group("));
        assert!(!core.contains("texture"));
        assert!(!core.contains("fn deepDielectricF0("));
        let source = include_str!("native_mesh_wgsl.rs");
        assert!(
            source.contains("include_str!(\"../../deep-engine/wgsl/materialEvaluateCore.wgsl\")")
        );
        assert!(source.contains("native_layer_extended_v1.wgsl"));
        let wrapper = include_str!("../assets/shaders/native_layer_extended_v1.wgsl");
        assert!(wrapper.contains("if (params0.y == 0.0"));
        assert!(wrapper.contains("params0.x, params0.y, params0.z"));
        assert!(!wrapper.contains("deepLayeredMaterial"));
    }

    #[test]
    fn shared_dielectric_wgsl_matches_pinned_checksum() {
        assert_matches_pinned_checksum(
            MATERIAL_DIELECTRIC_WGSL,
            include_str!("../../deep-engine/wgsl/materialDielectric.wgsl.sha256"),
            "materialDielectric",
        );
    }

    #[test]
    fn shared_brdf_wgsl_matches_pinned_checksum() {
        assert_matches_pinned_checksum(
            PBR_BRDF_DIRECT_LIGHTING_WGSL,
            include_str!("../../deep-engine/wgsl/brdfDirectLighting.wgsl.sha256"),
            "brdfDirectLighting",
        );
    }

    #[test]
    fn shared_metal_reflection_wgsl_matches_pinned_checksum() {
        assert_matches_pinned_checksum(
            include_str!("../../deep-engine/wgsl/materialMetalReflection.wgsl"),
            include_str!("../../deep-engine/wgsl/materialMetalReflection.wgsl.sha256"),
            "materialMetalReflection",
        );
    }

    #[test]
    fn shared_ies_wgsl_matches_pinned_checksum() {
        assert_matches_pinned_checksum(
            DEEP_IES_SAMPLING_WGSL,
            include_str!("../../deep-engine/wgsl/iesSampling.wgsl.sha256"),
            "iesSampling",
        );
    }

    #[test]
    fn shared_direct_dfg_lut_185_matches_pinned_checksum_and_hosts() {
        assert_matches_pinned_checksum(
            DIRECT_DFG_LUT_185_WGSL,
            include_str!("../../deep-engine/wgsl/directDfgLut185.wgsl.sha256"),
            "directDfgLut185",
        );
        // 文件形态合同:注释头之后是裸数组字面量、以 `);` 收尾后接采样函数,
        // 文件自身不带 var 声明头(两宿主各自补 `var<private> DEEP_DIRECT_DFG_185 = `
        // 前缀),改成自带头声明会破坏双端拼接。
        assert!(DIRECT_DFG_LUT_185_WGSL.contains("array<vec2f, 256>("));
        assert!(!DIRECT_DFG_LUT_185_WGSL.contains("var<private>"));
        assert!(
            DIRECT_DFG_LUT_185_WGSL
                .contains("fn deepDirectDfg185(roughness: f32, dotNv: f32) -> vec2f {")
        );
        // C8-S9 合同:native mesh 装配链必须消费该表(直射三处采样点的唯一
        // DFG 来源);直射核不再采样 brdf_lut,表也绝不反向采样任何纹理。
        assert!(!DIRECT_DFG_LUT_185_WGSL.contains("texture"));
        assert!(!DIRECT_DFG_LUT_185_WGSL.contains("@group("));
        let assembly = include_str!("native_mesh_wgsl.rs");
        assert!(
            assembly.contains("include_str!(\"../../deep-engine/wgsl/directDfgLut185.wgsl\")"),
            "production source builder must assemble the r185 direct DFG table"
        );
        let mesh = include_str!("../assets/shaders/native_mesh_v1.wgsl");
        // C9/native(2026-10-06):第 4 处 = native_extended_shade 的扩展带
        // stock_direct 替换抵消项(与 native_lit_response 同一 r185 表来源,
        // 单源合同不变)。
        assert_eq!(
            mesh.matches("deepDirectDfg185(").count(),
            4,
            "mesh body must hold the four direct sampling sites (dfg_light + lazy dfg_view + seed + extended wrapper)"
        );
        assert_eq!(
            mesh.matches("textureSampleLevel(brdf_lut,").count(),
            1,
            "brdf_lut must stay sampled only for the IBL split-sum fraction (C12 contract)"
        );
    }

    #[test]
    fn shared_brdf_keeps_ts_authoritative_specular_order() {
        // J2-B1 漂移修复锁:native 原内置副本为 `distribution * visibility * f` 起乘,
        // 白炉验收以 TS 序 `f * visibility * distribution` 为权威;单源化后两侧同序,
        // 若真源被改回 native 序,本断言与 TS 半 brdfDirectLightingWgslChecksum.test.ts 同时失败。
        assert!(
            PBR_BRDF_DIRECT_LIGHTING_WGSL.contains("let specular = f * visibility * distribution;")
        );
        assert!(!PBR_BRDF_DIRECT_LIGHTING_WGSL.contains("let specular = distribution"));
    }

    #[test]
    fn shared_ies_stride_locks_native_packing_abi() {
        // 真源内固化的 91u 字面量与 native 打包端行距(ies_shading::IES_ROW_STRIDE_VEC4)
        // 必须同值;任一端单独改值都会在此暴露。
        assert!(DEEP_IES_SAMPLING_WGSL.contains("const DEEP_IES_ROW_STRIDE: u32 = 91u;"));
        assert_eq!(crate::ies_shading::IES_ROW_STRIDE_VEC4, 91);
        // 采样库不携带 binding 声明(绑定留在宿主模板);引用符号与 native 宿主一致。
        assert!(!DEEP_IES_SAMPLING_WGSL.contains("@group("));
        assert!(DEEP_IES_SAMPLING_WGSL.contains("deepIesShading["));
    }

    #[test]
    fn shared_dielectric_keeps_legacy_special_case() {
        assert!(MATERIAL_DIELECTRIC_WGSL.contains("fn deepDielectricF0(encodedIor: f32) -> f32 {"));
        assert!(
            MATERIAL_DIELECTRIC_WGSL
                .contains("if (encodedIor == 0.0 || encodedIor == 1.5) { return 0.04; }")
        );
    }

    #[test]
    fn frame_bindings_consumes_the_same_single_source_files() {
        let bindings = include_str!("frame_bindings.rs");
        assert!(bindings.contains("native_mesh_wgsl::native_mesh_shader_source()"));
        assert!(bindings.contains("native_mesh_wgsl::native_mesh_rt_shader_source()"));
        let source = include_str!("native_mesh_wgsl.rs");
        for path in [
            "include_str!(\"../../deep-engine/wgsl/materialDielectric.wgsl\")",
            "include_str!(\"../../deep-engine/wgsl/brdfDirectLighting.wgsl\")",
            "include_str!(\"../../deep-engine/wgsl/brdfDirectMultiscattering.wgsl\")",
            "include_str!(\"../../deep-engine/wgsl/directDfgLut185.wgsl\")",
            "include_str!(\"../../deep-engine/wgsl/iesSampling.wgsl\")",
        ] {
            assert!(
                source.contains(path),
                "production source builder must reference {path}"
            );
        }
    }

    #[test]
    fn composed_native_mesh_shader_parses_with_the_shared_libraries() {
        // Parse the same complete source used by the production factory.
        // naga(即 wgpu 运行时同一前端)解析通过 = 库函数/符号在宿主内可解析、
        // dpdx 派生函数与 binding 声明无冲突;此测试不需要 GPU adapter。
        let composed = crate::native_mesh_wgsl::native_mesh_shader_source();
        let module = wgpu::naga::front::wgsl::parse_str(&composed)
            .expect("composed native mesh shader with shared lighting-math libraries must parse");
        assert!(
            !module.entry_points.is_empty(),
            "composed shader must keep its entry points"
        );
    }
}
