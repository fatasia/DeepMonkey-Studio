//! N1 适配器测试共享支撑:认证 fixture、固化摘要与宿主注入物。
//!
//! fixture 摘要与回放 display hash 同一机制(canonical JSON + SHA-256),
//! 由 `fixture_digest` 复算并与固化值对拍;fixture 内容改动必须同步固化值。

use super::{
    N1Adapter, N1Budget, N1Certification, N1Certifications, N1FontAsset, N1FontStyle, N1HostAssets,
    N1InlineAsset, N1InputKind, fixture_digest,
};
use std::collections::BTreeMap;

/// 测试统一使用的宿主平台标识。
pub const PLATFORM: &str = "win-dx12";

/// 认证组合 fixture(SVG 子集:M/L/H/V/Z + 相对指令)。
pub const SVG_FIXTURE: &str = r#"{"kind":"svg","schemaVersion":1,"input":{"id":"n1.svg.icon","viewBox":[0,0,24,24],"paths":[
{"id":"n1.svg.icon.body","data":"M 2 12 L 12 2 L 22 12 L 12 22 Z","zOrder":1,"fill":[0.1,0.2,0.3,1],"stroke":[1,1,1,1],"strokeWidth":1.5},
{"id":"n1.svg.icon.stem","data":"m 12 22 v -6 h 4","zOrder":2,"stroke":[1,0,0,1],"strokeWidth":1}]}}"#;

/// 认证组合 fixture(富文本 inline:两段落 + 一个 inline object)。
pub const RICH_TEXT_FIXTURE: &str = r#"{"kind":"rich-text-inline","schemaVersion":1,"input":{"id":"n1.rt.panel","text":"泵运行 abnormal",
"styles":[{"startCluster":0,"endCluster":3,"style":1}],
"paragraphs":[{"startCluster":0,"endCluster":4,"align":"start"},{"startCluster":4,"endCluster":12,"align":"end"}],
"inlineObjects":[{"atCluster":2,"objectId":"n1.rt.pump.icon"}]}}"#;

/// 认证组合 fixture(图表扩展:趋势线 + 阈值带 + 标记点)。
pub const CHART_FIXTURE: &str = r#"{"kind":"chart-extension","schemaVersion":1,"input":{"id":"n1.chart.ext","overlays":[
{"overlay":"trend-line","id":"n1.chart.trend","points":[[0,10],[100,20]],"stroke":[0,0.5,1,1],"strokeWidth":2,"zOrder":5},
{"overlay":"threshold-band","id":"n1.chart.band","x0":0,"y0":8,"x1":100,"y1":12,"fill":[1,0,0,0.25],"zOrder":1},
{"overlay":"marker","id":"n1.chart.marker","center":[50,15],"radius":4,"fill":[0,1,0,1],"zOrder":9}]}}"#;

/// 认证组合 fixture(动画 ABI:两条关键帧轨迹)。
pub const ANIMATION_FIXTURE: &str = r#"{"kind":"animation-abi","schemaVersion":1,"input":{"id":"n1.anim.pump","tracks":[
{"nodeId":"pump.rotor","property":"rotation","keyframes":[{"atMs":0,"value":{"number":0}},{"atMs":500,"value":{"number":90}}]},
{"nodeId":"pump.lamp","property":"opacity","keyframes":[{"atMs":0,"value":{"index":0}},{"atMs":200,"value":{"index":1}},{"atMs":600,"value":{"index":2}}]}]}}"#;

/// 认证台账的 fixture 摘要(hex SHA-256)。
pub const SVG_DIGEST: &str = "50b1cd8092c7a38fe942bf2327516a582b3c295085ad74a19056af10cd6280cd";
pub const RICH_TEXT_DIGEST: &str =
    "ad56df1cf53c367ab31d8f5eeebd5e14cd729379ea635e8c7bf3239d4035c068";
pub const CHART_DIGEST: &str = "5aab58a7b1dff6de6526756e6dcdc95efc96e5c84b155426269926a1793eb957";
pub const ANIMATION_DIGEST: &str =
    "ffb6112352d0aba525196c01e1c5a9d01f42cbf21a5ecb1bb60b3a49299f8fed";

pub fn certification(kind: N1InputKind, digest: &str) -> N1Certification {
    N1Certification {
        kind,
        schema_version: 1,
        platform: PLATFORM.into(),
        fixture_digest: digest.into(),
    }
}

/// 宿主注入的资源身份:一个字体 + 一个 inline object 资产映射。
pub fn host_assets() -> N1HostAssets {
    let mut inline_assets = BTreeMap::new();
    inline_assets.insert(
        "n1.rt.pump.icon".into(),
        N1InlineAsset {
            asset_id: "asset.pump-icon".into(),
            width: 16,
            height: 16,
        },
    );
    N1HostAssets {
        font: N1FontAsset {
            id: "n1.font.main".into(),
            asset_id: "asset.font-main".into(),
            family: "Inter".into(),
            weight: 400,
            style: N1FontStyle::Normal,
            color: [0.05, 0.05, 0.05, 1.0],
            font_size: 14.0,
        },
        inline_assets,
    }
}

/// 全部四类组合都按固化摘要认证的适配器。
pub fn certified_adapter() -> N1Adapter {
    N1Adapter::new(
        N1Certifications::new([
            certification(N1InputKind::Svg, SVG_DIGEST),
            certification(N1InputKind::RichTextInline, RICH_TEXT_DIGEST),
            certification(N1InputKind::ChartExtension, CHART_DIGEST),
            certification(N1InputKind::AnimationAbi, ANIMATION_DIGEST),
        ]),
        N1Budget::default(),
        host_assets(),
    )
    .expect("host assets are valid")
}

/// 校验 fixture 与固化摘要一一对应,防台账漂移。
pub fn assert_ledger_digests_match_fixtures() {
    for (fixture, expected) in [
        (SVG_FIXTURE, SVG_DIGEST),
        (RICH_TEXT_FIXTURE, RICH_TEXT_DIGEST),
        (CHART_FIXTURE, CHART_DIGEST),
        (ANIMATION_FIXTURE, ANIMATION_DIGEST),
    ] {
        let digest = fixture_digest(fixture.as_bytes()).expect("fixture is valid JSON");
        assert_eq!(digest, expected, "ledger digest must match the fixture");
        assert_eq!(digest.len(), 64, "digest is hex sha-256");
    }
    assert_ne!(
        fixture_digest(SVG_FIXTURE.as_bytes()),
        fixture_digest(RICH_TEXT_FIXTURE.as_bytes()),
        "distinct fixtures must have distinct digests"
    );
}
