//! Opt-in benchmark build observers. Normal builds have no allocator wrapper.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, Ordering};

pub const AVAILABLE: bool = cfg!(feature = "native-bench");
static LIVE_BYTES: AtomicI64 = AtomicI64::new(0);

pub struct CountingSystem;
unsafe impl GlobalAlloc for CountingSystem {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            LIVE_BYTES.fetch_add(layout.size() as i64, Ordering::Relaxed);
        }
        pointer
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            LIVE_BYTES.fetch_add(layout.size() as i64, Ordering::Relaxed);
        }
        pointer
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) };
        LIVE_BYTES.fetch_sub(layout.size() as i64, Ordering::Relaxed);
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let next = unsafe { System.realloc(pointer, layout, new_size) };
        if !next.is_null() {
            LIVE_BYTES.fetch_add(new_size as i64 - layout.size() as i64, Ordering::Relaxed);
        }
        next
    }
}
pub fn live_bytes() -> i64 {
    LIVE_BYTES.load(Ordering::Relaxed)
}

// One frame may encode cascades on worker threads; count after all encoders join.
static DRAW_ACTIVE: AtomicBool = AtomicBool::new(false);
static DRAWS: AtomicU32 = AtomicU32::new(0);
pub fn begin_draw_frame() {
    DRAWS.store(0, Ordering::Relaxed);
    DRAW_ACTIVE.store(true, Ordering::Relaxed);
}
#[inline(always)]
pub fn note_draw() {
    if AVAILABLE && DRAW_ACTIVE.load(Ordering::Relaxed) {
        DRAWS.fetch_add(1, Ordering::Relaxed);
    }
}
pub fn end_draw_frame() -> u32 {
    DRAW_ACTIVE.store(false, Ordering::Relaxed);
    DRAWS.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn counts_alloc_zero_realloc_and_dealloc_without_retaining_bytes() {
        let before = live_bytes();
        let original = Layout::from_size_align(128, 8).unwrap();
        unsafe {
            let pointer = CountingSystem.alloc_zeroed(original);
            assert!(!pointer.is_null());
            assert_eq!(live_bytes() - before, 128);
            let pointer = CountingSystem.realloc(pointer, original, 256);
            assert!(!pointer.is_null());
            assert_eq!(live_bytes() - before, 256);
            CountingSystem.dealloc(pointer, Layout::from_size_align(256, 8).unwrap());
        }
        assert_eq!(live_bytes(), before);
    }
    #[test]
    fn draw_frames_are_isolated_and_do_not_count_outside_the_window() {
        begin_draw_frame();
        note_draw();
        note_draw();
        std::thread::spawn(note_draw).join().unwrap();
        assert_eq!(end_draw_frame(), if AVAILABLE { 3 } else { 0 });
        note_draw();
        begin_draw_frame();
        assert_eq!(end_draw_frame(), 0);
    }
}
