//! Single-slot handoff from the packet watcher to the render event loop.
//!
//! A burst owns one wake event while newer candidates replace the pending value.
//! The render thread therefore stages the newest observed generation instead of
//! rebuilding every intermediate file rewrite.

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};

#[derive(Debug)]
pub(super) struct Versioned<T> {
    pub generation: u64,
    pub value: T,
}

#[derive(Debug)]
pub(super) struct LatestMailbox<T> {
    slot: Arc<Mutex<Option<Versioned<T>>>>,
    newest_generation: Arc<AtomicU64>,
}

impl<T> Clone for LatestMailbox<T> {
    fn clone(&self) -> Self {
        Self {
            slot: Arc::clone(&self.slot),
            newest_generation: Arc::clone(&self.newest_generation),
        }
    }
}

impl<T> Default for LatestMailbox<T> {
    fn default() -> Self {
        Self {
            slot: Arc::new(Mutex::new(None)),
            newest_generation: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl<T> LatestMailbox<T> {
    /// Replaces an older pending value. `true` means the caller must enqueue the
    /// one wake event that owns this non-empty slot.
    pub fn push(&self, generation: u64, value: T) -> bool {
        let mut slot = self.slot.lock().unwrap_or_else(|error| error.into_inner());
        self.newest_generation
            .fetch_max(generation, Ordering::AcqRel);
        if slot
            .as_ref()
            .is_some_and(|pending| pending.generation >= generation)
        {
            return false;
        }
        let needs_wake = slot.is_none();
        *slot = Some(Versioned { generation, value });
        needs_wake
    }

    pub fn take_latest(&self) -> Option<Versioned<T>> {
        self.slot
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
    }

    /// Runs the final renderer + CPU-state publication while holding the same
    /// lock used by producers. A newer generation can never interleave between
    /// the last latest-wins check and the atomic state swap.
    pub fn publish_if_latest<R>(&self, generation: u64, publish: impl FnOnce() -> R) -> Option<R> {
        let _slot = self.slot.lock().unwrap_or_else(|error| error.into_inner());
        (self.newest_generation.load(Ordering::Acquire) == generation).then(publish)
    }
}

#[cfg(test)]
mod tests {
    use super::LatestMailbox;

    #[test]
    fn one_wake_delivers_only_the_latest_burst_member() {
        let mailbox = LatestMailbox::default();
        assert!(mailbox.push(4, "four"));
        assert!(!mailbox.push(5, "five"));
        assert!(!mailbox.push(6, "six"));
        assert!(!mailbox.push(5, "late-five"));

        let latest = mailbox.take_latest().expect("latest candidate");
        assert_eq!((latest.generation, latest.value), (6, "six"));
        assert!(mailbox.take_latest().is_none());
    }

    #[test]
    fn a_new_burst_after_take_requests_a_new_wake() {
        let mailbox = LatestMailbox::default();
        assert!(mailbox.push(1, "first"));
        mailbox.take_latest().expect("consume first burst");
        assert!(mailbox.push(2, "second"));
    }

    #[test]
    fn publication_guard_rejects_superseded_work_before_state_mutation() {
        let mailbox = LatestMailbox::default();
        mailbox.push(1, "first");
        mailbox.take_latest().unwrap();
        mailbox.push(2, "second");
        let mut published = 0;
        assert!(mailbox.publish_if_latest(1, || published = 1).is_none());
        assert_eq!(published, 0);
        assert_eq!(mailbox.publish_if_latest(2, || published = 2), Some(()));
        assert_eq!(published, 2);
    }
}
