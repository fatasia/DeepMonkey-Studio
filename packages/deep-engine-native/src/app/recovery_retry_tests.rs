use super::recovery_retry::RecoveryRetry;
use std::time::Duration;
use web_time::Instant;
use winit::event_loop::ControlFlow;

#[test]
fn expired_animation_deadline_is_consumed_instead_of_busy_looping() {
    let now = Instant::now();
    let next = now + Duration::from_millis(16);
    for old in [now - Duration::from_millis(16), now] {
        assert_eq!(
            super::recovery_retry::merge_animation_wake(ControlFlow::WaitUntil(old), next, now),
            ControlFlow::WaitUntil(next)
        );
    }
    let earlier = now + Duration::from_millis(5);
    assert_eq!(
        super::recovery_retry::merge_animation_wake(ControlFlow::WaitUntil(earlier), next, now),
        ControlFlow::WaitUntil(earlier)
    );
    assert_eq!(
        super::recovery_retry::merge_animation_wake(ControlFlow::Poll, next, now),
        ControlFlow::Poll
    );
}

#[test]
fn loss_retries_are_bounded_and_do_not_run_before_deadline() {
    let mut retry = RecoveryRetry::default();
    let now = Instant::now();
    assert!(!retry.begin_attempt());
    retry.begin();
    assert!(retry.begin_attempt());
    let first = retry.failed(now).unwrap();
    assert_eq!(first - now, Duration::from_millis(250));
    assert!(!retry.take_due(first - Duration::from_millis(1)));
    assert!(retry.take_due(first));
    assert!(!retry.take_due(first));
    assert!(retry.begin_attempt());
    let second = retry.failed(first).unwrap();
    assert_eq!(second - first, Duration::from_millis(500));
    assert!(retry.take_due(second));
    assert!(retry.begin_attempt());
    assert!(retry.failed(second).is_none());
    assert!(!retry.take_due(second + Duration::from_secs(100)));
    retry.begin(); // Another loss before any valid frame cannot refresh the budget.
    assert!(!retry.begin_attempt());
    assert_eq!(retry.attempts(), 3);
}

#[test]
fn only_matching_presented_frame_resets_budget() {
    let mut retry = RecoveryRetry::default();
    retry.begin();
    assert!(retry.begin_attempt());
    retry.ready(11);
    retry.presented(10);
    assert!(retry.active());
    retry.begin();
    assert!(retry.begin_attempt()); // Candidate 11 lost before its first present.
    assert_eq!(retry.attempts(), 2);
    retry.ready(12);
    retry.presented(11);
    assert!(retry.active());
    retry.presented(12);
    assert!(!retry.active());
    retry.begin();
    assert!(retry.begin_attempt());
    assert_eq!(retry.attempts(), 1);
}

#[test]
fn manual_cancel_invalidates_pending_deadline_and_candidate() {
    let mut retry = RecoveryRetry::default();
    retry.begin();
    assert!(retry.begin_attempt());
    let wake = retry.failed(Instant::now()).unwrap();
    let installed = retry.merge_wake(ControlFlow::Wait);
    retry.cancel();
    assert!(!retry.take_due(wake + Duration::from_secs(1)));
    assert_eq!(retry.clear_managed_wake(installed), ControlFlow::Wait);
    assert_eq!(retry.merge_wake(ControlFlow::Wait), ControlFlow::Wait);
    retry.ready(123);
    retry.presented(123);
    assert!(!retry.active());
}

#[test]
fn retry_deadline_preserves_poll_and_earlier_animation_wakes() {
    let mut retry = RecoveryRetry::default();
    retry.begin();
    assert!(retry.begin_attempt());
    let wake = retry.failed(Instant::now()).unwrap();
    let early = ControlFlow::WaitUntil(wake - Duration::from_millis(10));
    assert_eq!(retry.merge_wake(ControlFlow::Poll), ControlFlow::Poll);
    assert_eq!(retry.merge_wake(early), early);
    assert_eq!(retry.clear_managed_wake(early), early);
    let later = ControlFlow::WaitUntil(wake + Duration::from_secs(1));
    assert_eq!(retry.merge_wake(later), ControlFlow::WaitUntil(wake));
    assert_eq!(
        retry.clear_managed_wake(ControlFlow::Poll),
        ControlFlow::Poll
    );
}
