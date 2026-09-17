use super::*;
use crate::adapter_n1::{
    N1Adapter, N1Budget, N1Certification, N1Certifications, N1FontAsset, N1FontStyle, N1HostAssets,
    N1InputKind, fixture_digest,
};
use crate::deep2d::Deep2dCommand;
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeMap;

const TRACE_BYTES: &[u8] =
    include_bytes!("../../../deep-engine/fixtures/deep2d-rich-text-ime-trace-v1.json");
const TRACE_DIGEST: &str = "c5c5ac85f2fb3c411aa75bf09baadd0f84beea9b6fb02b674b5563c0e4171b3d";
const TEST_PLATFORM: &str = "p2-03-offline-test";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TraceFixture {
    schema: String,
    schema_version: u32,
    initial: InitialState,
    events: Vec<TraceEvent>,
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
struct TraceEvent {
    op: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    cluster: Option<usize>,
    #[serde(default)]
    publish_n1: bool,
    #[serde(default)]
    expected_error: Option<String>,
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

fn offline_advance(cluster: &str) -> f64 {
    match cluster {
        "泵" | "运" | "行" => 14.0,
        "e" | "e\u{301}" => 8.0,
        "👩\u{200d}🔧" => 16.0,
        unexpected => panic!("fixture has no offline advance for cluster {unexpected:?}"),
    }
}

fn snapshot(session: &ImeSession) -> GoldenState {
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

fn run_event(session: &mut ImeSession, event: &TraceEvent) -> Result<(), String> {
    match event.op.as_str() {
        "focus" => {
            session.focus();
            Ok(())
        }
        "blur" => {
            session.blur();
            Ok(())
        }
        "set-caret" => session
            .set_caret(event.cluster.expect("set-caret requires cluster"))
            .map_err(|error| match error {
                ImeSessionError::InvalidCompositionAnchor { cluster } => {
                    format!("invalid-composition-anchor:{cluster}")
                }
                other => other.to_string(),
            }),
        "begin" => session
            .begin_composition()
            .map_err(|error| error.to_string()),
        "preedit" => session
            .update_preedit(event.text.as_deref().expect("preedit requires text"))
            .map_err(|error| error.to_string()),
        "commit" => session
            .commit()
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "cancel" => session
            .cancel_composition()
            .map_err(|error| error.to_string()),
        unknown => panic!("unknown trace operation {unknown:?}"),
    }
}

fn n1_snapshot_text(document: &TextDocumentV1) -> String {
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
    let adapter = N1Adapter::new(
        N1Certifications::new([N1Certification {
            kind: N1InputKind::RichTextInline,
            schema_version: 1,
            platform: TEST_PLATFORM.into(),
            fixture_digest: digest,
        }]),
        N1Budget::default(),
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
    .expect("valid N1 test host");
    let outcome = adapter.adapt(Some(&fixture), TEST_PLATFORM, 0);
    let adapted = outcome
        .adapted()
        .expect("commit snapshot is certified by this offline fixture");
    assert_eq!(adapted.delta.commands.len(), 1);
    let Deep2dCommand::Text(command) = &adapted.delta.commands[0] else {
        panic!("rich-text snapshot must produce one text command");
    };
    command.text.clone()
}

#[test]
fn shared_chinese_emoji_combining_trace_keeps_n0_authoritative() {
    assert_eq!(
        fixture_digest(TRACE_BYTES).expect("canonical trace digest"),
        TRACE_DIGEST
    );
    let fixture: TraceFixture = serde_json::from_slice(TRACE_BYTES).expect("valid trace fixture");
    assert_eq!(fixture.schema, "deep-engine.deep2d-rich-text-ime-trace");
    assert_eq!(fixture.schema_version, 1);

    let document = TextDocumentV1::new(&fixture.initial.text, Vec::new(), Vec::new(), Vec::new())
        .expect("valid initial document");
    let mut session = ImeSession::new(document, 8);
    session
        .set_caret(fixture.initial.caret_cluster)
        .expect("valid initial caret");

    let mut n1_snapshots = Vec::new();
    let mut last_committed = session.document().text().to_string();
    for (index, event) in fixture.events.iter().enumerate() {
        let before = session.document().clone();
        let actual_error = run_event(&mut session, event).err();
        assert_eq!(
            actual_error, event.expected_error,
            "event {index} ({}) error golden",
            event.op
        );
        assert_eq!(
            snapshot(&session),
            event.expected,
            "event {index} ({}) state golden",
            event.op
        );

        if event.op == "preedit" || event.op == "cancel" || event.expected_error.is_some() {
            assert_eq!(
                session.document(),
                &before,
                "preedit/cancel/rejected events cannot mutate N0"
            );
        }
        if event.publish_n1 {
            assert_eq!(event.op, "commit", "only a commit may publish to N1");
            last_committed = session.document().text().to_string();
            n1_snapshots.push(n1_snapshot_text(session.document()));
        } else {
            assert_eq!(
                n1_snapshots.last().map(String::as_str),
                (!n1_snapshots.is_empty()).then_some(last_committed.as_str()),
                "non-commit events must leave the last N1 snapshot unchanged"
            );
        }
    }

    assert_eq!(n1_snapshots, fixture.expected_n1_snapshots);
}
