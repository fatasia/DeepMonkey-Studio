use super::{Renderer, RendererFeatures};
use crate::player_content::PlayerContent;
use deep_engine_native::cascaded_shadow::CascadedShadowOptions;

/// 构造期定格的分配档位事实(只读诊断)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ContentProfileReport {
    /// 纯二维场景(有 deep2d、无实例、无探针)。
    pub planeless: bool,
    /// 前向目标在当前判据下是否可跳过。与 `planeless` 同源,分开列是为了
    /// 让后续接帧路径时「判据」与「已实施」能各自演进。
    pub forward_targets_skippable: bool,
    /// 已实施的1×1背景目标，不代表完全删除前向目标。
    pub compact_forward_targets: bool,
    /// 前向目标每像素字节(与分辨率相乘即估算占用)。
    pub forward_target_bytes_per_pixel: u64,
}

impl ContentProfileReport {
    pub(super) fn evaluate(content: &PlayerContent, features: RendererFeatures) -> Self {
        Self {
            planeless: planeless(content, features),
            forward_targets_skippable: skip_forward_targets(content, features),
            compact_forward_targets: compact_forward(content, features),
            forward_target_bytes_per_pixel: forward_target_bytes_per_pixel(),
        }
    }
    /// 启动报告用的一行。
    pub(crate) fn summary(&self) -> String {
        format!(
            "planeless={} forward_targets_skippable={} compact_forward_targets={} forward_bytes_per_pixel={}",
            self.planeless,
            self.forward_targets_skippable,
            self.compact_forward_targets,
            self.forward_target_bytes_per_pixel
        )
    }
}

pub(super) fn compact_forward(content: &PlayerContent, features: RendererFeatures) -> bool {
    planeless(content, features) && !features.bloom.is_active() && features.fog.density() == 0.0
}

pub(super) fn forward_size(
    compact: bool,
    size: winit::dpi::PhysicalSize<u32>,
) -> winit::dpi::PhysicalSize<u32> {
    if compact {
        winit::dpi::PhysicalSize::new(1, 1)
    } else {
        size
    }
}

// Keep the existing shadow bind ABI while avoiding a 64 MiB allocation in 2D-only players.
// Moving between these profiles is a full, validated renderer epoch, never a low-resolution 3D update.
pub(super) const COMPACT_SHADOW_SIZE: u32 = 64;

pub(super) fn compact_shadow(content: &PlayerContent, features: RendererFeatures) -> bool {
    content.deep2d.is_some()
        && content.packet().instances.is_empty()
        && !features.shadow_probe
        && !features.ibl_probe
}

pub(super) fn shadow_options(compact: bool) -> CascadedShadowOptions {
    let mut options = CascadedShadowOptions::default();
    if compact {
        options.shadow_map_size = COMPACT_SHADOW_SIZE;
    }
    options
}

/// 纯二维场景:二维内容就位且没有任何三维实例。
///
/// 判据比 `compact_shadow` 更窄——额外要求**没有差分探针**。探针要读前向目标像素,
/// 裁掉前向目标会让探针失去证据面,所以探针在场时一律不裁。
pub(super) fn planeless(content: &PlayerContent, features: RendererFeatures) -> bool {
    content.deep2d.is_some()
        && content.packet().instances.is_empty()
        && !features.shadow_probe
        && !features.ibl_probe
}

/// 纯二维场景的分配档位:在渲染器构造期求值一次,作为启动报告里的事实,
/// 也是后续「跳过前向目标」切片的接线点。
///
/// 本函数只交付决策判据;真正跳过帧路径需要像素对比与双主题闭环,属独立切片。
/// 之所以现在就有运行期调用点:判据必须能被观测(`--smoke-*` 会打印它),
/// 否则它只是一段没有真实调用链的推测代码。
pub(super) fn skip_forward_targets(content: &PlayerContent, features: RendererFeatures) -> bool {
    planeless(content, features)
}

/// 逻辑分配估算:单采样HDR + 多采样HDR与深度；不含驱动对齐/压缩。
/// Depth24Plus按每采样4B估算，实际物理驻留由驱动决定。
pub(super) fn forward_target_bytes_per_pixel() -> u64 {
    const HDR: u64 = 8;
    const DEPTH: u64 = 4;
    HDR + (HDR + DEPTH) * deep_engine_native::mesh_abi::FORWARD_SAMPLE_COUNT as u64
}

impl Renderer {
    pub(crate) fn pipeline_counts(&self) -> (usize, usize) {
        self.pipelines.counts()
    }

    pub(crate) fn requires_content_rebuild(&self, content: &PlayerContent) -> bool {
        let next_compact = content.deep2d.is_some()
            && content.packet().instances.is_empty()
            && self.shadow_probe.is_none()
            && self.ibl_probe.is_none();
        (self.shadow_map.metrics().map_size == COMPACT_SHADOW_SIZE) != next_compact
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::player_content::PlayerContent;
    use deep_engine_native::contract::RenderPacket;

    fn empty_packet() -> RenderPacket {
        RenderPacket {
            schema: deep_engine_native::contract::CONTRACT_SCHEMA.into(),
            version: 1,
            geometries: Vec::new(),
            materials: Vec::new(),
            instances: Vec::new(),
            textures: Vec::new(),
        }
    }

    fn features(shadow_probe: bool, ibl_probe: bool) -> RendererFeatures {
        RendererFeatures {
            bloom: Default::default(),
            fog: deep_engine_native::fog::FogSettings::DISABLED,
            shadow_probe,
            ibl_probe,
            telemetry: false,
        }
    }

    /// 无 deep2d 内容时不算纯二维:三维空场景仍需要前向目标做清屏与后处理链。
    #[test]
    fn planeless_requires_deep2d_content() {
        let content = PlayerContent::from_packet(empty_packet(), None);
        assert!(!planeless(&content, features(false, false)));
        assert!(!skip_forward_targets(&content, features(false, false)));
    }

    /// 有 deep2d 内容时判据为真(夹具的 packet 无实例)。
    #[test]
    fn planeless_holds_for_deep2d_only_content() {
        let list = deep_engine_native::deep2d::decode_display_list(include_bytes!(
            "../../fixtures/deep2d_tessellated_v1.json"
        ))
        .unwrap();
        let content = PlayerContent::from_packet(
            empty_packet(),
            Some(deep_engine_native::deep2d::Deep2dRuntimeContent::DisplayList(list)),
        );
        assert!(planeless(&content, features(false, false)));
        assert!(skip_forward_targets(&content, features(false, false)));
    }

    /// 探针在场时绝不裁:它们要读前向目标像素,裁掉就没有证据面。
    #[test]
    fn probes_veto_the_planeless_profile() {
        let list = deep_engine_native::deep2d::decode_display_list(include_bytes!(
            "../../fixtures/deep2d_tessellated_v1.json"
        ))
        .unwrap();
        let content = PlayerContent::from_packet(
            empty_packet(),
            Some(deep_engine_native::deep2d::Deep2dRuntimeContent::DisplayList(list)),
        );
        assert!(
            !planeless(&content, features(true, false)),
            "shadow probe 否决"
        );
        assert!(
            !planeless(&content, features(false, true)),
            "ibl probe 否决"
        );
        assert!(!skip_forward_targets(&content, features(true, false)));
        assert!(!skip_forward_targets(&content, features(false, true)));
    }

    #[test]
    fn compact_forward_requires_plain_output_and_keeps_window_extent_separate() {
        let list = deep_engine_native::deep2d::decode_display_list(include_bytes!(
            "../../fixtures/deep2d_tessellated_v1.json"
        ))
        .unwrap();
        let content = PlayerContent::from_packet(
            empty_packet(),
            Some(deep_engine_native::deep2d::Deep2dRuntimeContent::DisplayList(list)),
        );
        let mut plain = features(false, false);
        assert!(
            !compact_forward(&content, plain),
            "default Bloom stays full size"
        );
        plain.bloom = deep_engine_native::bloom::BloomSettings::DISABLED;
        assert!(compact_forward(&content, plain));
        let size = winit::dpi::PhysicalSize::new(1280, 720);
        assert_eq!(
            forward_size(true, size),
            winit::dpi::PhysicalSize::new(1, 1)
        );
        assert_eq!(forward_size(false, size), size);
        for (shadow_probe, ibl_probe) in [(true, false), (false, true)] {
            assert!(!compact_forward(
                &content,
                RendererFeatures {
                    shadow_probe,
                    ibl_probe,
                    ..plain
                }
            ));
        }
        plain.fog = deep_engine_native::fog::FogSettings::exponential(0.1, [0.5; 3]).unwrap();
        assert!(!compact_forward(&content, plain));
    }

    /// 与ForwardTargets中的三个纹理描述符对应，深度也使用多重采样。
    #[test]
    fn forward_target_bytes_per_pixel_includes_multisampled_depth() {
        const HDR: u64 = 8; // Rgba16Float
        const MSAA: u64 = HDR * deep_engine_native::mesh_abi::FORWARD_SAMPLE_COUNT as u64;
        const DEPTH: u64 = 4; // Depth24Plus
        let per_pixel =
            HDR + MSAA + DEPTH * deep_engine_native::mesh_abi::FORWARD_SAMPLE_COUNT as u64;
        assert_eq!(forward_target_bytes_per_pixel(), per_pixel);
        assert_eq!(per_pixel, 56);
        assert_eq!(1280 * 720 * per_pixel, 51_609_600);
        // IBL(约 27 KB)与紧凑阴影(64 KB)相对前向目标可忽略,不应作为裁剪目标。
        assert!(3454 * 8 < 1280 * 720 * per_pixel / 1000);
    }

    #[test]
    fn compact_profile_preserves_cascade_abi_and_reduces_depth_allocation() {
        let compact = shadow_options(true);
        let full = shadow_options(false);
        assert_eq!(compact.cascade_count, full.cascade_count);
        assert_eq!(compact.max_shadow_distance, full.max_shadow_distance);
        assert_eq!(compact.shadow_map_size, 64);
        assert_eq!(full.shadow_map_size, 2048);
        assert_eq!(
            u64::from(compact.shadow_map_size).pow(2) * compact.cascade_count as u64 * 4,
            65536
        );
    }
}
