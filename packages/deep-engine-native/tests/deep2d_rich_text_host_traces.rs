//! P2-03 可自动化剩余项:formatter / 动画 / 异常与超时的宿主轨迹。
//!
//! 与首个离线轨迹(`src/platform_text/ime_trace_tests.rs`,digest `c5c5ac85…`)
//! 同一 fixture schema(`deep-engine.deep2d-rich-text-ime-trace` v1),新增三份
//! 宿主轨迹夹具,全部离线确定(注入时钟,无真实系统 IME):
//!
//! - **formatter**:按封闭枚举合同(千分位/百分比/固定两位小数,无任意代码)在
//!   commit 前格式化 pending;未声明的 formatter 类型与非数字输入一律 fail-closed,
//!   文档、revision 与在途组合全部保持;
//! - **动画**:P1-23 动画 ABI 同源——渐入 opacity 关键帧在注入时刻做阶梯采样,
//!   双跑一致,且采样是注入时刻的纯函数;
//! - **异常/超时**:畸形 preedit(超 4096 字节)、N1 预算触界(宿主回退 undo)、
//!   组合 deadline 到期(宿主按注入时钟强制取消)→ 状态机保持,上一有效状态
//!   可恢复,每条故障都有结构化诊断。
//!
//! 诚实边界:超时策略是宿主侧(测试)按注入 atMs 判定的策略,不是 N0 `ImeSession`
//! 的内建时钟;formatter 语义定义在本测试的封闭枚举实现里,不进入生产代码。

use deep_engine_native::adapter_n1::{
    N1Adapter, N1Budget, N1Certification, N1Certifications, N1FontAsset, N1FontStyle, N1HostAssets,
    N1InputKind, N1Outcome, fixture_digest,
};
use deep_engine_native::behavior_ir::{BehaviorPayload, BehaviorProperty, Scalar};
use deep_engine_native::deep2d::Deep2dCommand;
use deep_engine_native::platform_text::{ImeSession, ImeSessionError, TextDocumentV1};
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeMap;

const FORMATTER_TRACE: &[u8] = include_bytes!("fixtures/deep2d-rich-text-formatter-trace-v1.json");
const ANIMATION_TRACE: &[u8] = include_bytes!("fixtures/deep2d-rich-text-animation-trace-v1.json");
const FAILURE_TRACE: &[u8] = include_bytes!("fixtures/deep2d-rich-text-failure-trace-v1.json");

const FORMATTER_TRACE_DIGEST: &str =
    "1de62c6a911be7858a7b1156b4bf53fd574f09794799c595e01c7d0a56bdbf52";
const ANIMATION_TRACE_DIGEST: &str =
    "d6b73ad02015302646ca6473b260648b86b182a691cca0af310559655e62c6fb";
const FAILURE_TRACE_DIGEST: &str =
    "0b372ac836b320e054085b95654afc35662bad0c03c255e9987b7881625da75e";

const TRACE_SCHEMA: &str = "deep-engine.deep2d-rich-text-ime-trace";
const TEST_PLATFORM: &str = "p2-03-offline-test";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct HostTraceFixture {
    schema: String,
    schema_version: u32,
    initial: InitialState,
    #[serde(default)]
    formatters: Vec<FormatterDecl>,
    #[serde(default)]
    animation: Option<AnimationDecl>,
    #[serde(default)]
    samples: Vec<u64>,
    #[serde(default)]
    expected_samples: Vec<Vec<f64>>,
    #[serde(default)]
    failure: Option<FailureDecl>,
    events: Vec<HostTraceEvent>,
    #[serde(default)]
    expected_diagnostics: Vec<String>,
    expected_n1_snapshots: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct InitialState {
    text: String,
    caret_cluster: usize,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FormatterDecl {
    id: String,
    detail: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AnimationDecl {
    text_content: String,
    tracks: Vec<AnimationTrackDecl>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AnimationTrackDecl {
    node_id: String,
    property: String,
    keyframes: Vec<AnimationKeyframeDecl>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AnimationKeyframeDecl {
    at_ms: u64,
    value: AnimationValueDecl,
}

/// 与 N1 `AnimationValueV1` 同形的封闭标量(externally tagged)。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum AnimationValueDecl {
    Number(f64),
    Bool(bool),
    Index(u32),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FailureDecl {
    composition_timeout_ms: u64,
    n1_max_text_code_units: usize,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct HostTraceEvent {
    op: String,
    #[serde(default)]
    at_ms: Option<u64>,
    #[serde(default)]
    text: Option<String>,
    /// 畸形注入:把 `repeat` 重复 `count` 次合成 preedit(如超 4096 字节)。
    #[serde(default)]
    repeat: Option<String>,
    #[serde(default)]
    count: Option<usize>,
    #[serde(default)]
    cluster: Option<usize>,
    #[serde(default)]
    formatter: Option<String>,
    #[serde(default)]
    publish_n1: bool,
    #[serde(default)]
    expected_error: Option<String>,
    /// N0 commit 成功、但 N1 发布被预算拒绝时期望的结构化原因。
    #[serde(default)]
    expected_n1_block: Option<String>,
    expected: GoldenState,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct GoldenState {
    document_text: String,
    revision: u64,
    cluster_count: usize,
    caret_cluster: usize,
    caret_x: f64,
    focused: bool,
    composing: bool,
    pending: String,
}

/// 一次完整轨迹的观测产物(双跑一致性比较用)。
#[derive(Debug, PartialEq)]
struct TraceResult {
    n1_snapshots: Vec<String>,
    diagnostics: Vec<String>,
    samples: Vec<Vec<f64>>,
}

struct HostHarness {
    session: ImeSession,
    /// 当前在途组合的开始时刻(注入时钟);无组合时为 `None`。
    composition_opened_at_ms: Option<u64>,
    composition_timeout_ms: u64,
    publish_budget: N1Budget,
    diagnostics: Vec<String>,
    n1_snapshots: Vec<String>,
}

/// 离线簇宽表:ASCII 簇 8px、CJK 簇 14px,其余一律 panic(夹具防漂移)。
fn offline_advance(cluster: &str) -> f64 {
    let mut chars = cluster.chars();
    let Some(first) = chars.next() else {
        panic!("fixture has an empty cluster");
    };
    if chars.next().is_some() {
        panic!("fixture has no offline advance for multi-char cluster {cluster:?}");
    }
    if first.is_ascii() {
        8.0
    } else if ('\u{2e80}'..='\u{9fff}').contains(&first)
        || ('\u{ff00}'..='\u{ffef}').contains(&first)
    {
        14.0
    } else {
        panic!("fixture has no offline advance for cluster {cluster:?}");
    }
}

fn state_of(session: &ImeSession) -> GoldenState {
    let (_, rect) = session.caret_rect(20.0, &offline_advance);
    GoldenState {
        document_text: session.document().text().into(),
        revision: session.revision(),
        cluster_count: session.document().cluster_count(),
        caret_cluster: session.caret_cluster(),
        caret_x: rect[0],
        focused: session.is_focused(),
        composing: session.is_composing(),
        pending: session.pending().into(),
    }
}

/// 封闭 formatter 集:类型与语义都在这一处定义,新增类型必须改这里(fail-closed)。
/// 语义全部是字符串上的确定变换,不引入浮点、不执行任何宿主代码。
const FORMATTER_KINDS: [&str; 3] = ["thousands", "percent", "fixed2"];

fn apply_formatter(kind: &str, pending: &str) -> Result<String, String> {
    // 先验类型后验输入:未声明的类型一律拒绝,与输入内容无关。
    if !FORMATTER_KINDS.contains(&kind) {
        return Err(format!("unknown-formatter:{kind}"));
    }
    let Some((int_part, frac_part)) = split_decimal(pending) else {
        return Err(format!("formatter-input-rejected:{kind}:{pending}"));
    };
    let formatted = match kind {
        "thousands" => {
            if frac_part.is_empty() {
                group_thousands(int_part)
            } else {
                format!("{},.{}", group_thousands(int_part), frac_part)
            }
        }
        "percent" => {
            // 十进制点右移两位:数字串 = 整数部分 + 小数部分 + "00"。
            let digits = format!("{int_part}{frac_part}00");
            let point = int_part.len() + 2;
            let whole = digits[..point].trim_start_matches('0');
            let whole = if whole.is_empty() { "0" } else { whole };
            let rest = digits.get(point..).unwrap_or("");
            let frac = &format!("{:0<2}", rest)[..2];
            format!("{whole}.{frac}%")
        }
        "fixed2" => format!("{int_part}.{}", &format!("{:0<2}", frac_part)[..2]),
        _ => unreachable!("closed formatter set checked above"),
    };
    Ok(formatted)
}

/// 严格十进制:`[0-9]+(.[0-9]+)?`,整数部分不可为空;其余输入一律拒绝。
fn split_decimal(input: &str) -> Option<(&str, &str)> {
    let (int_part, frac_part) = match input.split_once('.') {
        Some((int_part, frac_part)) => (int_part, frac_part),
        None => (input, ""),
    };
    if int_part.is_empty() || !int_part.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if !frac_part.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((int_part, frac_part))
}

fn group_thousands(int_part: &str) -> String {
    int_part
        .as_bytes()
        .rchunks(3)
        .rev()
        .map(|chunk| std::str::from_utf8(chunk).expect("digits are ascii"))
        .collect::<Vec<_>>()
        .join(",")
}

impl HostHarness {
    /// 宿主超时策略:注入时钟下组合存活超过 deadline 即强制取消并记诊断。
    /// N0 `ImeSession` 是同步状态机,时钟完全在宿主侧,这是与产品宿主相同的接线位。
    fn check_deadline(&mut self, at_ms: u64) {
        let Some(opened_at_ms) = self.composition_opened_at_ms else {
            return;
        };
        let expired = at_ms
            .checked_sub(opened_at_ms)
            .is_some_and(|elapsed| elapsed > self.composition_timeout_ms);
        if expired {
            let pending = self.session.pending().to_string();
            self.session
                .cancel_composition()
                .expect("deadline cancel must succeed while composing");
            self.composition_opened_at_ms = None;
            self.diagnostics.push(format!(
                "composition-deadline-expired opened={opened_at_ms} at={at_ms} pending={pending}"
            ));
        }
    }

    fn run_event(&mut self, event: &HostTraceEvent) -> Result<(), String> {
        match event.op.as_str() {
            "focus" => {
                self.session.focus();
                Ok(())
            }
            "blur" => {
                self.session.blur();
                self.composition_opened_at_ms = None;
                Ok(())
            }
            "set-caret" => {
                let cluster = event.cluster.expect("set-caret requires cluster");
                self.session
                    .set_caret(cluster)
                    .map_err(|error| match error {
                        ImeSessionError::InvalidCompositionAnchor { cluster } => {
                            format!("invalid-composition-anchor:{cluster}")
                        }
                        other => other.to_string(),
                    })?;
                self.composition_opened_at_ms = None;
                Ok(())
            }
            "begin" => {
                self.session
                    .begin_composition()
                    .map_err(|error| error.to_string())?;
                self.composition_opened_at_ms = event.at_ms;
                Ok(())
            }
            "preedit" => {
                let pending = match (&event.text, &event.repeat) {
                    (Some(text), None) => text.clone(),
                    (None, Some(unit)) => unit.repeat(event.count.expect("repeat requires count")),
                    _ => panic!("preedit requires exactly one of text or repeat+count"),
                };
                self.session
                    .update_preedit(&pending)
                    .map_err(|error| error.to_string())
            }
            "commit" => {
                if let Some(kind) = event.formatter.as_deref() {
                    let pending = self.session.pending().to_string();
                    match apply_formatter(kind, &pending) {
                        // 宿主策略:commit 前把 pending 经声明 formatter 重写。
                        Ok(formatted) => self
                            .session
                            .update_preedit(&formatted)
                            .map_err(|error| error.to_string())?,
                        // fail-closed:输入在进入 N0 之前被拒,组合与文档原样保留。
                        Err(reason) => {
                            self.diagnostics
                                .push(format!("formatter-rejected {reason}"));
                            return Err(reason);
                        }
                    }
                }
                self.session
                    .commit()
                    .map(|_| ())
                    .map_err(|error| error.to_string())?;
                self.composition_opened_at_ms = None;
                if event.publish_n1 {
                    match publish_n1_text(self.session.document(), self.publish_budget) {
                        Ok(text) => self.n1_snapshots.push(text),
                        Err(reason) => {
                            self.diagnostics
                                .push(format!("n1-publish-blocked {reason}"));
                            if event.expected_n1_block.as_deref() != Some(reason.as_str()) {
                                return Err(format!("unexpected N1 publish block: {reason}"));
                            }
                        }
                    }
                }
                Ok(())
            }
            "cancel" => {
                self.session
                    .cancel_composition()
                    .map_err(|error| error.to_string())?;
                self.composition_opened_at_ms = None;
                Ok(())
            }
            "undo" => {
                self.session
                    .undo()
                    .map(|_| ())
                    .map_err(|error| error.to_string())?;
                self.composition_opened_at_ms = None;
                Ok(())
            }
            // 宿主策略探测位:真正的强制取消发生在 `check_deadline`。
            "deadline-check" => Ok(()),
            unknown => panic!("unknown trace operation {unknown:?}"),
        }
    }
}

/// 把已提交文档投影给 N1 rich-text 适配器(N1 只见 commit 快照,不见 preedit)。
/// 返回 Ok(命令文本) 或 Err(结构化拒绝原因)。
fn publish_n1_text(document: &TextDocumentV1, budget: N1Budget) -> Result<String, String> {
    let fixture = serde_json::to_vec(&json!({
        "kind": "rich-text-inline",
        "schemaVersion": 1,
        "input": {
            "id": "p2.03.rich-text.snapshot",
            "text": document.text(),
            "styles": [],
            "paragraphs": [],
            "inlineObjects": []
        }
    }))
    .expect("N1 snapshot JSON");
    let digest = fixture_digest(&fixture).expect("canonical N1 snapshot digest");
    let adapter = build_adapter(N1InputKind::RichTextInline, digest, budget);
    match adapter.adapt(Some(&fixture), TEST_PLATFORM, 0) {
        N1Outcome::Adapted(adapted) => {
            assert_eq!(adapted.delta.commands.len(), 1, "one paragraph snapshot");
            let Deep2dCommand::Text(command) = &adapted.delta.commands[0] else {
                panic!("rich-text snapshot must produce one text command");
            };
            Ok(command.text.clone())
        }
        N1Outcome::Blocked { reason } => Err(reason),
        N1Outcome::Unknown { reason } => panic!("snapshot kind must be known: {reason}"),
    }
}

fn build_adapter(kind: N1InputKind, digest: String, budget: N1Budget) -> N1Adapter {
    N1Adapter::new(
        N1Certifications::new([N1Certification {
            kind,
            schema_version: 1,
            platform: TEST_PLATFORM.into(),
            fixture_digest: digest,
        }]),
        budget,
        N1HostAssets {
            font: N1FontAsset {
                id: "p2.03.font".into(),
                asset_id: "fixture.font.offline".into(),
                family: "Fixture Sans".into(),
                weight: 400,
                style: N1FontStyle::Normal,
                color: [0.0, 0.0, 0.0, 1.0],
                font_size: 14.0,
            },
            inline_assets: BTreeMap::new(),
        },
    )
    .expect("valid N1 test host")
}

/// 执行一条宿主轨迹:每个事件断言 error golden + 状态 golden + N0 不变量,
/// commit 后把文档快照投影给 N1,返回观测产物供双跑对拍。
fn run_trace(bytes: &[u8]) -> TraceResult {
    let fixture: HostTraceFixture = serde_json::from_slice(bytes).expect("valid trace fixture");
    assert_eq!(fixture.schema, TRACE_SCHEMA);
    assert_eq!(fixture.schema_version, 1);
    let (composition_timeout_ms, publish_budget) = match &fixture.failure {
        Some(failure) => (
            failure.composition_timeout_ms,
            N1Budget {
                max_text_code_units: failure.n1_max_text_code_units,
                ..N1Budget::default()
            },
        ),
        None => (u64::MAX, N1Budget::default()),
    };
    let document = TextDocumentV1::new(&fixture.initial.text, Vec::new(), Vec::new(), Vec::new())
        .expect("valid initial document");
    let mut harness = HostHarness {
        session: ImeSession::new(document, 8),
        composition_opened_at_ms: None,
        composition_timeout_ms,
        publish_budget,
        diagnostics: Vec::new(),
        n1_snapshots: Vec::new(),
    };
    harness
        .session
        .set_caret(fixture.initial.caret_cluster)
        .expect("valid initial caret");

    for (index, event) in fixture.events.iter().enumerate() {
        if let Some(at_ms) = event.at_ms {
            harness.check_deadline(at_ms);
        }
        let before = harness.session.document().clone();
        let actual_error = harness.run_event(event).err();
        assert_eq!(
            actual_error, event.expected_error,
            "event {index} ({}) error golden",
            event.op
        );
        assert_eq!(
            state_of(&harness.session),
            event.expected,
            "event {index} ({}) state golden",
            event.op
        );
        if event.op == "preedit"
            || event.op == "cancel"
            || event.op == "deadline-check"
            || event.expected_error.is_some()
        {
            assert_eq!(
                harness.session.document(),
                &before,
                "preedit/cancel/deadline/rejected events cannot mutate N0"
            );
        }
        if event.publish_n1 {
            assert_eq!(event.op, "commit", "only a commit may publish to N1");
        }
    }

    let mut samples = Vec::new();
    if let Some(animation) = &fixture.animation {
        assert_eq!(
            animation.text_content,
            harness.session.document().text(),
            "animation timeline targets the final committed rich text"
        );
        samples = sample_animation(animation, &fixture.samples, &fixture.expected_samples);
    }
    TraceResult {
        n1_snapshots: harness.n1_snapshots,
        diagnostics: harness.diagnostics,
        samples,
    }
}

/// P1-23 动画 ABI 同源采样:夹具关键帧 → animation-abi 信封 → 注入时刻采样,
/// 逐时刻断言 SetProperty(Opacity) 轨迹。
fn sample_animation(
    animation: &AnimationDecl,
    samples: &[u64],
    expected_samples: &[Vec<f64>],
) -> Vec<Vec<f64>> {
    let tracks = animation
        .tracks
        .iter()
        .map(|track| {
            assert_eq!(
                track.property, "opacity",
                "this trace certifies the fade-in opacity timeline"
            );
            json!({
                "nodeId": track.node_id,
                "property": track.property,
                "keyframes": track.keyframes.iter().map(|keyframe| json!({
                    "atMs": keyframe.at_ms,
                    "value": match keyframe.value {
                        AnimationValueDecl::Number(value) => json!({ "number": value }),
                        AnimationValueDecl::Bool(value) => json!({ "bool": value }),
                        AnimationValueDecl::Index(value) => json!({ "index": value }),
                    },
                })).collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>();
    let envelope = serde_json::to_vec(&json!({
        "kind": "animation-abi",
        "schemaVersion": 1,
        "input": { "id": "p2.03.rich-text.fade", "tracks": tracks },
    }))
    .expect("animation envelope JSON");
    let digest = fixture_digest(&envelope).expect("canonical animation envelope digest");
    let adapter = build_adapter(N1InputKind::AnimationAbi, digest, N1Budget::default());
    assert_eq!(
        adapter.adapt(Some(&envelope), TEST_PLATFORM, 250),
        adapter.adapt(Some(&envelope), TEST_PLATFORM, 250),
        "animation sampling is a pure function of the injected time"
    );

    let mut observed = Vec::with_capacity(samples.len());
    for (sample_index, at_ms) in samples.iter().enumerate() {
        let outcome = adapter.adapt(Some(&envelope), TEST_PLATFORM, *at_ms);
        let adapted = outcome
            .adapted()
            .unwrap_or_else(|| panic!("animation sample at {at_ms}ms must adapt"));
        assert_eq!(adapted.kind, N1InputKind::AnimationAbi);
        assert!(
            adapted.delta.commands.is_empty() && adapted.delta.resources.is_empty(),
            "animation ABI emits actions, not display commands"
        );
        let mut sample = Vec::with_capacity(animation.tracks.len());
        for (track_index, track) in animation.tracks.iter().enumerate() {
            let BehaviorPayload::SetProperty {
                node_id,
                property: BehaviorProperty::Opacity,
                value: Scalar::Number(value),
            } = &adapted.actions[track_index]
            else {
                panic!(
                    "track {} must emit SetProperty(Opacity, number)",
                    track.node_id
                );
            };
            assert_eq!(
                node_id, &track.node_id,
                "actions follow fixture track order"
            );
            sample.push(*value);
        }
        assert_eq!(
            sample, expected_samples[sample_index],
            "opacity sample at {at_ms}ms golden"
        );
        observed.push(sample);
    }
    observed
}

fn assert_deterministic(bytes: &[u8]) -> TraceResult {
    let first = run_trace(bytes);
    let second = run_trace(bytes);
    assert_eq!(
        first, second,
        "host trace must be deterministic across runs"
    );
    first
}

#[test]
fn formatter_trace_formats_committed_clusters_and_fails_closed() {
    let fixture: HostTraceFixture =
        serde_json::from_slice(FORMATTER_TRACE).expect("valid formatter trace fixture");
    // 封闭枚举合同:夹具声明的 formatter 集与实现逐字一致。
    assert_eq!(
        fixture
            .formatters
            .iter()
            .map(|decl| decl.id.as_str())
            .collect::<Vec<_>>(),
        FORMATTER_KINDS
    );
    for decl in &fixture.formatters {
        assert!(
            !decl.detail.is_empty(),
            "every declared formatter carries its reviewed contract text"
        );
        assert!(
            apply_formatter(&decl.id, "12").is_ok(),
            "declared formatter '{}' must accept clean numeric input",
            decl.id
        );
    }
    assert!(apply_formatter("significant-figures", "12").is_err());

    let result = assert_deterministic(FORMATTER_TRACE);
    assert_eq!(result.n1_snapshots, fixture.expected_n1_snapshots);
    assert_eq!(
        result.diagnostics, fixture.expected_diagnostics,
        "fail-closed rejections must surface as structured diagnostics"
    );
}

#[test]
fn animation_trace_samples_fade_in_at_injected_times_across_double_run() {
    let fixture: HostTraceFixture =
        serde_json::from_slice(ANIMATION_TRACE).expect("valid animation trace fixture");
    let result = assert_deterministic(ANIMATION_TRACE);
    assert_eq!(result.n1_snapshots, fixture.expected_n1_snapshots);
    assert!(result.diagnostics.is_empty());
    assert_eq!(result.samples, fixture.expected_samples);
    assert_eq!(result.samples.len(), fixture.samples.len());
}

#[test]
fn failure_trace_recovers_from_malformed_overbudget_and_deadline() {
    let fixture: HostTraceFixture =
        serde_json::from_slice(FAILURE_TRACE).expect("valid failure trace fixture");
    let result = assert_deterministic(FAILURE_TRACE);
    assert_eq!(result.n1_snapshots, fixture.expected_n1_snapshots);
    assert_eq!(
        result.diagnostics, fixture.expected_diagnostics,
        "malformed/over-budget/deadline faults must surface as structured diagnostics"
    );
}

#[test]
fn host_trace_fixtures_keep_frozen_canonical_digests() {
    for (bytes, expected, name) in [
        (FORMATTER_TRACE, FORMATTER_TRACE_DIGEST, "formatter"),
        (ANIMATION_TRACE, ANIMATION_TRACE_DIGEST, "animation"),
        (FAILURE_TRACE, FAILURE_TRACE_DIGEST, "failure"),
    ] {
        assert_eq!(
            fixture_digest(bytes).expect("canonical digest"),
            expected,
            "{name} trace digest drift"
        );
    }
}
