//! Self-driving smoke for `--smoke-packet-live`: after the first present it
//! rewrites the watched file with a moved instance, then keeps presenting until
//! the live update is atomically published (scene version bump) or times out.

use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};

use winit::event_loop::EventLoopProxy;

use crate::events::GpuEvent;
use crate::renderer::{Renderer, scene_update::RendererSceneEvidence};

const REWRITE_DELAY: Duration = Duration::from_millis(600);
/// Time-based bound: the watcher polls every 500ms and presents run at frame
/// rate, so present counting would time out long before the update lands.
const APPLY_DEADLINE: Duration = Duration::from_secs(8);

pub(super) struct PacketLiveProbe {
    watch_path: PathBuf,
    rewrite_bytes: Vec<u8>,
    rejected_rewrite: Option<Vec<u8>>,
    proxy: EventLoopProxy<GpuEvent>,
    baseline: Option<(u64, u64)>,
    rejection_checked: bool,
    presents: usize,
    started: Instant,
}

impl PacketLiveProbe {
    pub(super) fn new(
        watch_path: PathBuf,
        rewrite_bytes: Vec<u8>,
        rejected_rewrite: Option<Vec<u8>>,
        proxy: EventLoopProxy<GpuEvent>,
    ) -> Self {
        Self {
            watch_path,
            rewrite_bytes,
            rejected_rewrite,
            proxy,
            baseline: None,
            rejection_checked: false,
            presents: 0,
            started: Instant::now(),
        }
    }

    /// Returns `Ok(true)` when the update is live and the smoke may exit.
    pub(super) fn after_present(&mut self, renderer: &mut Renderer) -> Result<bool, String> {
        self.presents += 1;
        if self.started.elapsed() > APPLY_DEADLINE {
            return Err("packet live smoke timed out before the watched update applied".into());
        }
        let evidence: RendererSceneEvidence = renderer.scene_update_evidence();
        let current = (renderer.id(), evidence.shadow_version.scene);
        let Some(baseline) = self.baseline else {
            self.baseline = Some(current);
            self.schedule_rewrite();
            return Ok(false);
        };
        let rejection_ready = self.rejected_rewrite.is_none() || self.rejection_checked;
        if rejection_ready && (current.0 != baseline.0 || current.1 > baseline.1) {
            println!(
                "live reload smoke published: renderer/scene {:?}=>{:?} after {} presents in {:?}",
                baseline,
                current,
                self.presents,
                self.started.elapsed()
            );
            return Ok(true);
        }
        Ok(false)
    }

    pub(super) fn after_rejection_checkpoint(&mut self, renderer: &Renderer) -> Result<(), String> {
        let baseline = self
            .baseline
            .ok_or("live reload rejection checkpoint arrived before first present")?;
        let evidence = renderer.scene_update_evidence();
        let current = (renderer.id(), evidence.shadow_version.scene);
        if current != baseline {
            return Err(format!(
                "rejected live candidate changed active renderer/scene: {baseline:?}=>{current:?}"
            ));
        }
        std::fs::write(&self.watch_path, &self.rewrite_bytes)
            .map_err(|error| format!("live reload valid recovery rewrite failed: {error}"))?;
        self.rejection_checked = true;
        println!("live reload rejected candidate retained last frame: renderer/scene={current:?}");
        Ok(())
    }

    fn schedule_rewrite(&mut self) {
        let path = self.watch_path.clone();
        let rejected = self.rejected_rewrite.clone();
        let bytes = rejected
            .clone()
            .unwrap_or_else(|| self.rewrite_bytes.clone());
        let proxy = self.proxy.clone();
        thread::spawn(move || {
            thread::sleep(REWRITE_DELAY);
            if let Err(error) = std::fs::write(&path, bytes) {
                eprintln!("packet live smoke rewrite failed: {error}");
                return;
            }
            if rejected.is_some() {
                thread::sleep(Duration::from_millis(750));
                let _ = proxy.send_event(GpuEvent::LiveProbeCheckpoint);
            }
        });
    }
}
