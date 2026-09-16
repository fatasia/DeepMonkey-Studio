//! P1-19 字体身份与能力矩阵测试。
//!
//! 重点验证三件事:①身份**确定性**(同一字体任何机器同一 hash,与枚举顺序无关);
//! ②保守默认(系统字体能渲染但**不计入可交付产物**);③缺字/许可给出**对象级**诊断。
//!
//! 这些测试依赖本机已安装字体,因此断言的是**不变量**而不是具体字体名——
//! 否则测试会在换机器时失败,而失败原因与产品缺陷无关。

use super::*;

fn report() -> FontCapabilityReport {
    let mut fonts = FontSystem::new();
    capability_report(&mut fonts)
}

/// 确定性:同一字体库两次探测得到逐值相同的矩阵(排序稳定,与枚举顺序无关)。
#[test]
fn capability_report_is_deterministic_across_probes() {
    let first = report();
    let second = report();
    assert_eq!(
        first, second,
        "两次探测必须逐值相同——否则跨机器比对失去意义"
    );
    assert_eq!(first.schema_version, FONT_CAPABILITY_SCHEMA_VERSION);
}

/// 排序不变量:面按 content_hash 稳定排序且 hash 唯一(去重后)。
#[test]
fn faces_are_sorted_by_content_hash_and_unique() {
    let report = report();
    for pair in report.faces.windows(2) {
        assert!(
            pair[0].identity.content_hash <= pair[1].identity.content_hash,
            "面必须按 hash 稳定排序"
        );
    }
    let mut hashes = report
        .faces
        .iter()
        .map(|face| face.identity.content_hash)
        .collect::<Vec<_>>();
    let before = hashes.len();
    hashes.dedup();
    assert_eq!(hashes.len(), before, "同一字体数据不得出现两次");
}

/// 身份完整性:每个面都带非零 hash 与字节数;拿不到数据的面不得伪造身份。
#[test]
fn every_face_carries_a_real_content_hash() {
    let report = report();
    assert!(!report.faces.is_empty(), "本机应至少装有一种字体");
    for face in &report.faces {
        assert_ne!(
            face.identity.content_hash, 0,
            "hash=0 是伪身份,不得出现: {:?}",
            face.identity
        );
        assert!(
            face.identity.content_bytes > 0,
            "字体数据字节数必须为正: {:?}",
            face.identity
        );
        // OpenType 字重落在 1..=1000。
        assert!(
            (1..=1000).contains(&face.identity.weight),
            "字重越界: {}",
            face.identity.weight
        );
    }
}

/// 保守默认(本模块最重要的产品语义):当前来源是系统字体、许可未知,
/// **不得**计入可交付产物。任何把它标成 usable 的改动都必须先解决许可。
#[test]
fn system_fonts_are_measured_but_not_usable_in_an_artifact() {
    let report = report();
    assert_eq!(
        report.source_counts.get("system-installed").copied(),
        Some(report.faces.len()),
        "当前唯一来源是系统已安装字体"
    );
    assert_eq!(
        report.usable_faces, 0,
        "系统字体许可未确认,不得计入可交付产物"
    );
    assert!(
        report.faces.iter().all(|face| !face.usable_in_artifact),
        "逐个面都必须是不可交付状态"
    );
    assert!(
        report.usable_families().is_empty(),
        "可用家族列表必须为空,避免上层误以为有可直接发布的字体"
    );
}

/// 对象级诊断:不存在的家族与被许可阻断的家族给出**不同**原因,
/// 使上层能把「机器没装」与「装了但不能发」区分开。
#[test]
fn blocked_families_report_distinct_object_level_reasons() {
    let report = report();
    assert_eq!(
        report.family_blocked_reason("__definitely_absent_family__"),
        Some("font family not present on this machine")
    );
    // 任取一个实际存在的家族:它应被许可状态阻断,而不是「不存在」。
    if let Some(face) = report.faces.first() {
        let reason = report
            .family_blocked_reason(&face.identity.family)
            .expect("系统字体必须给出阻断原因");
        assert_ne!(
            reason, "font family not present on this machine",
            "已存在的家族不得被报成缺失"
        );
        assert!(
            reason.contains("license") || reason.contains("not embedded"),
            "阻断原因必须指向许可或未内嵌,实际 {reason}"
        );
    }
}

/// 家族存在性探针:不存在的家族必须为 false,越界输入拒绝而不 panic。
#[test]
fn family_exists_rejects_absent_and_out_of_bounds_families() {
    let mut fonts = FontSystem::new();
    assert!(
        !family_exists(&mut fonts, "__definitely_absent_family__"),
        "不存在的家族不得被判为存在"
    );
    assert!(!family_exists(&mut fonts, ""), "空家族名不是有效查询");
    assert!(!family_exists(&mut fonts, &"x".repeat(300)), "越界输入拒绝");
    // 正向对照:报告里任意一个真实家族必须被判为存在——否则探针恒 false。
    let report = report();
    if let Some(face) = report
        .faces
        .iter()
        .find(|face| !face.identity.family.is_empty())
    {
        assert!(
            family_exists(&mut fonts, &face.identity.family),
            "报告中列出的家族必须能查到: {}",
            face.identity.family
        );
    }
}

/// 缺字探针的分工必须明确:**不能**用它判断「指定家族是否覆盖」。
///
/// 实测确立:cosmic-text 在家族缺失时静默 fallback,不存在的家族照样成形,
/// 因此成形成功不能证明该家族可用——这条测试把这个陷阱固化下来,
/// 防止后来者把 `text_shapes_without_missing_glyphs` 当成家族可用性判定。
#[test]
fn shaping_probe_cannot_prove_family_coverage_because_of_fallback() {
    let mut fonts = FontSystem::new();
    // 不存在的家族 + 常见拉丁文本:整形成功(fallback 生效)。
    assert!(
        text_shapes_without_missing_glyphs(&mut fonts, "__definitely_absent_family__", "Hello"),
        "整形器会 fallback,因此成形成功不代表该家族存在"
    );
    // 但家族存在性探针给出正确答案。
    assert!(!family_exists(&mut fonts, "__definitely_absent_family__"));
    // 空文本不制造假阴性。
    assert!(text_shapes_without_missing_glyphs(&mut fonts, "", ""));
    // 越界输入拒绝而不是 panic。
    assert!(!text_shapes_without_missing_glyphs(
        &mut fonts,
        "sans-serif",
        &"x".repeat(20_000)
    ));
}

/// 摘要行必须反映真实计数,供启动报告与跨机器比对使用。
#[test]
fn summary_reflects_the_real_counts() {
    let report = report();
    let summary = report.summary();
    assert!(summary.contains(&format!("faces={}", report.faces.len())));
    assert!(summary.contains("usable=0"), "摘要不得漏报不可交付状态");
    assert!(summary.contains(&format!(
        "system={}",
        report.source_counts.get("system-installed").copied().unwrap_or(0)
    )));
}
