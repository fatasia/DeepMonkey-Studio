//! 监听由窗口 transport 持有；关闭立即唤醒等待并回收后台线程。
use std::{sync::mpsc, thread::JoinHandle, time::Duration};

pub(super) struct WatchThread {
    stop: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

pub(super) struct Stop(mpsc::Receiver<()>);

impl Stop {
    pub fn wait(&self, interval: Duration) -> bool {
        matches!(
            self.0.recv_timeout(interval),
            Err(mpsc::RecvTimeoutError::Timeout)
        )
    }

    pub fn cancelled(&self) -> bool {
        !matches!(self.0.try_recv(), Err(mpsc::TryRecvError::Empty))
    }
}

impl WatchThread {
    pub fn spawn(work: impl FnOnce(Stop) + Send + 'static) -> Self {
        let (stop, receiver) = mpsc::channel();
        let thread = std::thread::spawn(move || work(Stop(receiver)));
        Self {
            stop: Some(stop),
            thread: Some(thread),
        }
    }
}

impl Drop for WatchThread {
    fn drop(&mut self) {
        self.stop.take();
        if let Some(thread) = self.thread.take()
            && thread.join().is_err()
        {
            eprintln!("native file watcher exited with a panic");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn closing_interrupts_an_idle_watcher_without_waiting_for_poll_interval() {
        let (ready, started) = mpsc::channel();
        let (done, ended) = mpsc::channel();
        let watcher = WatchThread::spawn(move |stop| {
            ready.send(()).unwrap();
            assert!(!stop.wait(Duration::from_secs(60)));
            assert!(stop.cancelled());
            done.send(()).unwrap();
        });
        started.recv_timeout(Duration::from_secs(2)).unwrap();
        let now = Instant::now();
        drop(watcher);
        assert!(now.elapsed() < Duration::from_secs(2));
        ended.try_recv().unwrap();
    }

    #[test]
    fn cancel_during_read_discards_the_decoded_candidate_before_publication() {
        let (ready, started) = mpsc::channel();
        let (release, blocked) = mpsc::channel();
        let (published, publication) = mpsc::channel();
        let mut watcher = WatchThread::spawn(move |stop| {
            assert!(stop.wait(Duration::from_millis(1)));
            ready.send(()).unwrap();
            blocked.recv_timeout(Duration::from_secs(2)).unwrap();
            if !stop.cancelled() {
                published.send(()).unwrap();
            }
        });
        started.recv_timeout(Duration::from_secs(2)).unwrap();
        watcher.stop.take();
        release.send(()).unwrap();
        drop(watcher);
        assert!(matches!(
            publication.try_recv(),
            Err(mpsc::TryRecvError::Disconnected)
        ));
    }

    #[test]
    fn already_finished_watcher_is_reclaimed_normally() {
        let (done, ended) = mpsc::channel();
        let watcher = WatchThread::spawn(move |_| {
            done.send(()).unwrap();
        });
        ended.recv_timeout(Duration::from_secs(2)).unwrap();
        drop(watcher);
    }
}
