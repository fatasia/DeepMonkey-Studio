//! Latest-wins coordination for the live packet update entry.
//!
//! Pure state machine, no threads or I/O: the watcher thread owns one instance
//! and asks it whether an observed file generation is still worth staging, and
//! whether a staged candidate may publish. Only the highest accepted generation
//! ever publishes; superseded and failed generations keep the last correct frame
//! drawable until a newer generation lands.

use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubmitDecision {
    /// New highest generation; stage it (parse + validate + prepare).
    Stage,
    /// The generation was already superseded by a newer submission or is not
    /// newer than the published frame; discard without reading the file.
    Discard,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublishDecision {
    /// This candidate is the highest accepted generation; publish atomically.
    Publish,
    /// A newer generation was submitted while this one staged; drop it.
    Superseded,
}

#[derive(Debug)]
pub struct UpdateCoalescer {
    /// Highest generation successfully published to the renderer.
    published: u64,
    /// Highest generation submitted for staging.
    highest_submitted: u64,
    /// Generations whose staging or publish failed. A file rewrite retries with a
    /// new generation; a late completion of a failed generation never publishes.
    failed: BTreeSet<u64>,
}

impl UpdateCoalescer {
    pub fn new(published: u64) -> Self {
        Self {
            published,
            highest_submitted: published,
            failed: BTreeSet::new(),
        }
    }

    pub fn published(&self) -> u64 {
        self.published
    }

    /// A watched file revision arrived. Bursts collapse here: only generations
    /// newer than everything seen so far are staged.
    pub fn submit(&mut self, generation: u64) -> SubmitDecision {
        if generation <= self.highest_submitted {
            return SubmitDecision::Discard;
        }
        self.failed.retain(|failed| *failed >= generation);
        self.highest_submitted = generation;
        SubmitDecision::Stage
    }

    /// Staging finished successfully. Publish unless a burst superseded this
    /// generation or it repeats an already-published/failed state.
    pub fn staged(&self, generation: u64) -> PublishDecision {
        if generation < self.highest_submitted
            || generation <= self.published
            || self.failed.contains(&generation)
        {
            return PublishDecision::Superseded;
        }
        PublishDecision::Publish
    }

    /// Staging or publishing failed; the last correct frame stays. The failure
    /// is remembered so a retry of the same bytes is decided explicitly.
    pub fn failed(&mut self, generation: u64) {
        self.failed.insert(generation);
    }

    #[cfg(test)]
    pub fn is_failed(&self, generation: u64) -> bool {
        self.failed.contains(&generation)
    }

    /// Publish completed; advances the rendered generation.
    pub fn publish_ok(&mut self, generation: u64) {
        if generation > self.published {
            self.published = generation;
        }
        self.failed.remove(&generation);
    }
}

/// Last atomically published value. Device reconnects rebuild only from this state;
/// staged or rejected candidates never enter it.
#[derive(Debug)]
pub struct PublishedState<T> {
    generation: u64,
    value: T,
}

impl<T> PublishedState<T> {
    pub fn new(value: T) -> Self {
        Self {
            generation: 0,
            value,
        }
    }

    pub fn active(&self) -> &T {
        &self.value
    }

    pub fn active_mut(&mut self) -> &mut T {
        &mut self.value
    }

    pub fn publish(&mut self, generation: u64, value: T) {
        debug_assert!(generation > self.generation);
        self.generation = generation;
        self.value = value;
    }
}

#[cfg(test)]
mod tests {
    use super::{PublishDecision, PublishedState, SubmitDecision, UpdateCoalescer};

    #[test]
    fn bursts_collapse_to_the_highest_generation() {
        let mut coalescer = UpdateCoalescer::new(1);
        assert_eq!(coalescer.submit(5), SubmitDecision::Stage);
        assert_eq!(coalescer.submit(6), SubmitDecision::Stage);
        assert_eq!(coalescer.submit(7), SubmitDecision::Stage);
        assert_eq!(
            coalescer.submit(6),
            SubmitDecision::Discard,
            "late burst member"
        );
        assert_eq!(coalescer.staged(6), PublishDecision::Superseded);
        assert_eq!(coalescer.staged(5), PublishDecision::Superseded);
        assert_eq!(coalescer.staged(7), PublishDecision::Publish);
        coalescer.publish_ok(7);
        assert_eq!(coalescer.published(), 7);
    }

    #[test]
    fn stale_and_repeated_generations_never_publish() {
        let mut coalescer = UpdateCoalescer::new(3);
        assert_eq!(
            coalescer.submit(3),
            SubmitDecision::Discard,
            "same as published"
        );
        assert_eq!(
            coalescer.submit(2),
            SubmitDecision::Discard,
            "older than published"
        );
        assert_eq!(coalescer.submit(4), SubmitDecision::Stage);
        coalescer.publish_ok(4);
        assert_eq!(
            coalescer.staged(4),
            PublishDecision::Superseded,
            "already published"
        );
    }

    #[test]
    fn failed_candidates_never_publish_and_a_new_generation_can_retry() {
        let mut coalescer = UpdateCoalescer::new(1);
        assert_eq!(coalescer.submit(2), SubmitDecision::Stage);
        assert_eq!(coalescer.staged(2), PublishDecision::Publish);
        coalescer.failed(2);
        assert!(coalescer.is_failed(2));
        assert_eq!(
            coalescer.staged(2),
            PublishDecision::Superseded,
            "failed candidate cannot publish on a late completion"
        );
        assert_eq!(coalescer.submit(3), SubmitDecision::Stage);
        assert!(
            !coalescer.is_failed(2),
            "new generation retires old failures"
        );
        assert_eq!(coalescer.staged(3), PublishDecision::Publish);
        coalescer.publish_ok(3);
        assert_eq!(coalescer.staged(2), PublishDecision::Superseded);
    }

    #[test]
    fn reconnect_uses_only_the_last_fully_published_value() {
        let mut published = PublishedState::new(vec!["base-geometry", "base-material"]);
        let mut coalescer = UpdateCoalescer::new(0);

        assert_eq!(coalescer.submit(1), SubmitDecision::Stage);
        coalescer.failed(1);
        assert_eq!(
            published.active(),
            &["base-geometry", "base-material"],
            "rejected candidate cannot poison a reconnect"
        );

        assert_eq!(coalescer.submit(2), SubmitDecision::Stage);
        assert_eq!(coalescer.staged(2), PublishDecision::Publish);
        published.publish(2, vec!["full-new-geometry", "full-new-material"]);
        coalescer.publish_ok(2);
        assert_eq!(
            published.active(),
            &["full-new-geometry", "full-new-material"],
            "reconnect restores the whole published packet"
        );
    }
}
