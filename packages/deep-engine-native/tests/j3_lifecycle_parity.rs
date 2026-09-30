//! CPU adapter resources only. Uses the exact publication/transport owners used by NativeApp.
#[allow(dead_code)]
#[path = "../src/app/packet_coalescer.rs"]
mod packet_coalescer;
#[path = "../src/app/packet_mailbox.rs"]
mod packet_mailbox;
#[path = "../src/app/watch_thread.rs"]
mod watch_thread;

use packet_coalescer::{PublishDecision, PublishedState, SubmitDecision, UpdateCoalescer};
use packet_mailbox::LatestMailbox;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
    mpsc,
};
use std::time::Duration;
use watch_thread::WatchThread;

struct Resource(Arc<AtomicUsize>);
impl Resource {
    fn new(count: &Arc<AtomicUsize>) -> Arc<Self> {
        count.fetch_add(1, Ordering::SeqCst);
        Arc::new(Self(Arc::clone(count)))
    }
}
impl Drop for Resource {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

struct Payload {
    generation: u64,
    camera: Option<Arc<Resource>>,
    _geometry: Option<Arc<Resource>>,
}

fn sample(
    samples: &mut Vec<Value>,
    phase: &str,
    generation: u64,
    published: &Option<PublishedState<Payload>>,
    count: &Arc<AtomicUsize>,
) {
    samples.push(json!({"phase": phase, "generation": generation,
        "activeGeneration": published.as_ref().map_or(0, |state| state.active().generation),
        "cpuResources": count.load(Ordering::SeqCst)}));
}

fn submit(coalescer: &mut UpdateCoalescer, mailbox: &LatestMailbox<()>, generation: u64) {
    assert_eq!(coalescer.submit(generation), SubmitDecision::Stage);
    mailbox.push(generation, ());
    assert_eq!(mailbox.take_latest().unwrap().generation, generation);
}

fn publish(
    coalescer: &mut UpdateCoalescer,
    mailbox: &LatestMailbox<()>,
    published: &mut Option<PublishedState<Payload>>,
    payload: Payload,
) {
    let generation = payload.generation;
    assert_eq!(coalescer.staged(generation), PublishDecision::Publish);
    assert!(
        mailbox
            .publish_if_latest(generation, || {
                if let Some(state) = published {
                    state.publish(generation, payload);
                } else {
                    *published = Some(PublishedState::new(payload));
                }
                coalescer.publish_ok(generation);
            })
            .is_some()
    );
}

fn run_scenario(id: &str) -> Value {
    let count = Arc::new(AtomicUsize::new(0));
    let mut coalescer = UpdateCoalescer::new(0);
    let mailbox = LatestMailbox::default();
    let mut published = Some(PublishedState::new(Payload {
        generation: 0,
        camera: None,
        _geometry: None,
    }));
    let mut samples = Vec::new();
    submit(&mut coalescer, &mailbox, 1);
    sample(&mut samples, "staging", 1, &published, &count);
    publish(
        &mut coalescer,
        &mailbox,
        &mut published,
        Payload {
            generation: 1,
            camera: Some(Resource::new(&count)),
            _geometry: Some(Resource::new(&count)),
        },
    );
    sample(&mut samples, "committed", 1, &published, &count);
    if matches!(id, "cancelled-retains-active" | "dispose-pending") {
        // Same Stop/Drop path as native transports: shutdown wakes pending work;
        // the decoded resource is discarded before it can enter the mailbox.
        let (ready, entered) = mpsc::channel();
        let (completed, ended) = mpsc::channel();
        let worker_count = Arc::clone(&count);
        let worker_mailbox = mailbox.clone();
        let watcher = WatchThread::spawn(move |stop| {
            ready.send(()).unwrap();
            assert!(!stop.wait(Duration::from_secs(60)));
            let late = Resource::new(&worker_count);
            if !stop.cancelled() {
                worker_mailbox.push(2, ());
            }
            drop(late);
            completed.send(()).unwrap();
        });
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        sample(&mut samples, "staging", 2, &published, &count);
        if id == "dispose-pending" {
            drop(published.take());
            sample(&mut samples, "disposed", 0, &published, &count);
        }
        drop(watcher);
        ended
            .try_recv()
            .expect("watcher must finish the late-resource release path without panic");
        assert!(mailbox.take_latest().is_none());
        assert_eq!(coalescer.staged(2), PublishDecision::Superseded);
        sample(
            &mut samples,
            if id == "dispose-pending" {
                "superseded"
            } else {
                "cancelled"
            },
            2,
            &published,
            &count,
        );
    } else {
        submit(&mut coalescer, &mailbox, 2);
        sample(&mut samples, "staging", 2, &published, &count);
        match id {
            "success" => {
                let camera = published.as_ref().unwrap().active().camera.clone();
                publish(
                    &mut coalescer,
                    &mailbox,
                    &mut published,
                    Payload {
                        generation: 2,
                        camera,
                        _geometry: Some(Resource::new(&count)),
                    },
                );
                sample(&mut samples, "committed", 2, &published, &count);
            }
            "failed-retains-active" => {
                let rejected = Resource::new(&count);
                coalescer.failed(2);
                drop(rejected);
                assert_eq!(coalescer.staged(2), PublishDecision::Superseded);
                sample(&mut samples, "failed", 2, &published, &count);
            }
            "superseded-completion" => {
                submit(&mut coalescer, &mailbox, 3);
                sample(&mut samples, "staging", 3, &published, &count);
                let camera = published.as_ref().unwrap().active().camera.clone();
                publish(
                    &mut coalescer,
                    &mailbox,
                    &mut published,
                    Payload {
                        generation: 3,
                        camera,
                        _geometry: Some(Resource::new(&count)),
                    },
                );
                sample(&mut samples, "committed", 3, &published, &count);
                let late = Resource::new(&count);
                assert_eq!(coalescer.staged(2), PublishDecision::Superseded);
                assert!(
                    mailbox
                        .publish_if_latest(2, || panic!("stale mutation"))
                        .is_none()
                );
                drop(late);
                sample(&mut samples, "superseded", 2, &published, &count);
            }
            _ => panic!("unsupported shared lifecycle scenario: {id}"),
        }
    }
    drop(published.take());
    // Repeated disposal does not re-release payloads.
    drop(published.take());
    sample(&mut samples, "disposed", 0, &published, &count);
    assert_eq!(count.load(Ordering::SeqCst), 0, "all CPU payloads released");
    json!({"id": id, "samples": samples})
}

#[test]
fn j3_gate_e_production_host_component_traces() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../deep-engine/fixtures/j3-lifecycle-v1.json"
    ))
    .unwrap();
    let run = || {
        fixture["scenarios"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| {
                let result = run_scenario(entry["id"].as_str().unwrap());
                assert_eq!(
                    result["samples"], entry["expected"],
                    "shared lifecycle contract"
                );
                result
            })
            .collect::<Vec<_>>()
    };
    let first = run();
    let second = run();
    assert_eq!(first, second, "same-host lifecycle traces are stable");
    if let Some(path) = std::env::var_os("J3_NATIVE_LIFECYCLE_OUTPUT_PATH") {
        let evidence = json!({"host": "native-production-publication-transport", "scope": fixture["scope"],
            "fixture": fixture, "runs": [first, second]});
        std::fs::write(path, serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
    }
}
