//! Pure CPU lifecycle/present contract tests for j3_window_events.
use super::*;

const BASE: &[(WindowEventKind, u64, u64)] = &[
    (WindowEventKind::WindowCreated, 1, 0),
    (WindowEventKind::Presented, 1, 5),
    (WindowEventKind::DeviceLostCallback, 1, 10),
    (WindowEventKind::RecoveryCandidateCreated, 2, 12),
    (WindowEventKind::RecoveryPresented, 2, 20),
    (WindowEventKind::StaleEventRejected, 1, 21),
];

const EXPECT: WindowEventExpectations = WindowEventExpectations {
    loss_callbacks: 1,
    require_recovery_present: true,
    require_present_timing: false,
    timeout: Duration::from_secs(45),
};

fn records(events: &[(WindowEventKind, u64, u64)]) -> Vec<WindowEventRecord> {
    events
        .iter()
        .map(|(kind, renderer_id, offset_ms)| WindowEventRecord {
            kind: *kind,
            renderer_id: *renderer_id,
            at: Duration::from_millis(*offset_ms),
        })
        .collect()
}

fn timeline(events: &[WindowEventRecord]) -> WindowEventTimeline {
    WindowEventTimeline {
        started: Instant::now(),
        records: events.to_vec(),
        present_samples: Vec::new(),
    }
}

#[test]
fn certified_shape_passes_and_every_violation_is_rejected() {
    let findings = validate_window_events(&timeline(&records(BASE)), 1, 2, &EXPECT).unwrap();
    assert_eq!(findings.presents_before_loss, 1);
    assert_eq!(findings.presents_after_recovery, 1);
    assert_eq!(findings.recovery_duration, Some(Duration::from_millis(10)));
    assert_eq!(findings.stale_rejections, 1);
    let base = timeline(&records(BASE));
    assert_eq!(base.present_offsets_ms(), vec![5.0, 20.0]);
    assert!(validate_window_events(&timeline(&records(BASE)), 1, 2, &EXPECT).is_ok());
    /// 对 BASE 施加一处变异后必须以 needle 拒绝；不粉饰、不静默通过。
    fn reject_after(mutate: impl Fn(&mut Vec<WindowEventRecord>), needle: &str) {
        let mut events = records(BASE);
        mutate(&mut events);
        let needle_hint = "expected rejection, timeline passed";
        let error = validate_window_events(&timeline(&events), 1, 2, &EXPECT)
            .err()
            .unwrap_or_else(|| needle_hint.to_string());
        assert!(error.contains(needle), "expected '{needle}' in: {error}");
    }
    reject_after(|e| e[0].kind = WindowEventKind::Presented, "WindowCreated");
    reject_after(
        |e| {
            e.remove(4);
        },
        "after recovery present",
    ); // 缺恢复 present
    reject_after(
        |e| {
            e.remove(5);
        },
        "stale-event",
    ); // 缺 stale 负例
    reject_after(|e| e[4].at = Duration::from_millis(3), "non-monotonic");
    reject_after(|e| e[2].renderer_id = 9, "lost callback id");
    reject_after(|e| e[3].renderer_id = 1, "new renderer id");
    reject_after(|e| e[4].renderer_id = 1, "must come from the new renderer");
    reject_after(
        |e| {
            e.remove(3);
        },
        "expected candidate",
    );
    reject_after(|e| e[4].renderer_id = 3, "expected candidate");
    reject_after(|e| e[5].renderer_id = 2, "stale-event rejection");
    reject_after(|e| e[3].kind = WindowEventKind::Presented, "after loss");
    reject_after(|e| e[5].at = Duration::from_secs(46), "timeout");
}

#[test]
fn empty_candidate_before_loss_and_forbidden_recovery_are_rejected() {
    assert!(
        validate_window_events(&timeline(&[]), 1, 2, &EXPECT)
            .unwrap_err()
            .contains("empty timeline")
    );
    let mut early = records(BASE);
    early.swap(2, 3);
    early[2].at = Duration::from_millis(10);
    early[3].at = Duration::from_millis(12);
    assert!(
        validate_window_events(&timeline(&early), 1, 2, &EXPECT)
            .unwrap_err()
            .contains("must follow lost callback")
    );
    let forbidden = WindowEventExpectations {
        require_recovery_present: false,
        ..EXPECT
    };
    assert!(
        validate_window_events(&timeline(&records(BASE)), 1, 2, &forbidden)
            .unwrap_err()
            .contains("forbidden")
    );
}

#[test]
fn host_present_samples_require_real_event_pairing_and_positive_spans() {
    let mut measured = timeline(&records(BASE));
    for event in measured.records.iter().filter(|event| {
        matches!(
            event.kind,
            WindowEventKind::Presented | WindowEventKind::RecoveryPresented
        )
    }) {
        measured.present_samples.push(WindowPresentSample {
            renderer_id: event.renderer_id,
            kind: event.kind,
            at: event.at,
            duration: Duration::from_micros(123),
        });
    }
    let expect = WindowEventExpectations {
        require_present_timing: true,
        ..EXPECT
    };
    assert!(validate_window_events(&measured, 1, 2, &expect).is_ok());
    measured.present_samples[0].duration = Duration::ZERO;
    assert!(
        validate_window_events(&measured, 1, 2, &expect)
            .unwrap_err()
            .contains("positive host span")
    );
    measured.present_samples[0].duration = Duration::from_micros(123);
    measured.present_samples[0].renderer_id = 99;
    assert!(
        validate_window_events(&measured, 1, 2, &expect)
            .unwrap_err()
            .contains("matching renderer")
    );
    measured.present_samples.pop();
    assert!(
        validate_window_events(&measured, 1, 2, &expect)
            .unwrap_err()
            .contains("pair exactly")
    );
}

#[test]
fn repeated_recovery_presents_keep_first_recovery_duration() {
    let mut events = records(BASE);
    events.push(WindowEventRecord {
        kind: WindowEventKind::RecoveryPresented,
        renderer_id: 2,
        at: Duration::from_millis(25),
    });
    let findings = validate_window_events(&timeline(&events), 1, 2, &EXPECT).unwrap();
    assert_eq!(findings.presents_after_recovery, 2);
    assert_eq!(findings.recovery_duration, Some(Duration::from_millis(10)));
}
