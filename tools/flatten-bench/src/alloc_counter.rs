//! A global allocator wrapper that counts allocations made by the current thread while a
//! [`Measure`] guard is armed on it. Other threads (the test harness, stdout capture) are
//! never counted, so measurements stay isolated without `--test-threads=1`.
//!
//! Install it in each binary or integration test with
//! `#[global_allocator] static A: CountingAlloc = CountingAlloc;`.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

pub struct CountingAlloc;

thread_local! {
    static ARMED: Cell<bool> = const { Cell::new(false) };
}

static COUNT: AtomicU64 = AtomicU64::new(0);
static TOTAL_BYTES: AtomicU64 = AtomicU64::new(0);
// Live bytes relative to arming; goes negative when pre-existing memory (e.g. a consumed
// input) is freed while armed
static CURRENT: AtomicI64 = AtomicI64::new(0);
static PEAK: AtomicI64 = AtomicI64::new(0);
// Serializes guards process-wide, since the counters are shared
static LOCK: Mutex<()> = Mutex::new(());

fn armed() -> bool {
    ARMED.try_with(Cell::get).unwrap_or(false)
}

fn on_alloc(size: usize) {
    COUNT.fetch_add(1, Ordering::Relaxed);
    TOTAL_BYTES.fetch_add(size as u64, Ordering::Relaxed);
    let now = CURRENT.fetch_add(size as i64, Ordering::Relaxed) + size as i64;
    PEAK.fetch_max(now, Ordering::Relaxed);
}

fn on_dealloc(size: usize) {
    CURRENT.fetch_sub(size as i64, Ordering::Relaxed);
}

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() && armed() {
            on_alloc(layout.size());
        }
        ptr
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc_zeroed(layout) };
        if !ptr.is_null() && armed() {
            on_alloc(layout.size());
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        if armed() {
            on_dealloc(layout.size());
        }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let new = unsafe { System.realloc(ptr, layout, new_size) };
        if !new.is_null() && armed() {
            // Counted as a fresh allocation of `new_size` replacing the old block
            on_dealloc(layout.size());
            on_alloc(new_size);
        }
        new
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AllocStats {
    /// Number of alloc/alloc_zeroed/realloc calls
    pub count: u64,
    /// Cumulative requested bytes over those calls (a realloc counts its full new size);
    /// an upper bound on new memory, not live memory
    pub total_bytes: u64,
    /// Highest live-bytes DELTA above the arming point: extra memory needed on top of what
    /// was live before. Not an absolute process peak, and frees of memory allocated before
    /// arming (e.g. a consumed input) lower it, so it can understate a consuming call's need
    pub peak_bytes: i64,
    /// Live-bytes delta when the guard was finished (negative if pre-existing memory was freed)
    pub net_bytes: i64,
}

/// Arms counting on the current thread until [`Measure::finish`] (or drop).
/// Blocks while another thread holds a guard.
pub struct Measure {
    _lock: MutexGuard<'static, ()>,
}

impl Measure {
    pub fn start() -> Self {
        let lock = LOCK.lock().unwrap_or_else(|p| p.into_inner());
        COUNT.store(0, Ordering::SeqCst);
        TOTAL_BYTES.store(0, Ordering::SeqCst);
        CURRENT.store(0, Ordering::SeqCst);
        PEAK.store(0, Ordering::SeqCst);
        ARMED.with(|a| a.set(true));
        Self { _lock: lock }
    }

    pub fn finish(self) -> AllocStats {
        ARMED.with(|a| a.set(false));
        let stats = AllocStats {
            count: COUNT.load(Ordering::SeqCst),
            total_bytes: TOTAL_BYTES.load(Ordering::SeqCst),
            peak_bytes: PEAK.load(Ordering::SeqCst),
            net_bytes: CURRENT.load(Ordering::SeqCst),
        };
        drop(self);
        stats
    }
}

impl Drop for Measure {
    fn drop(&mut self) {
        ARMED.with(|a| a.set(false));
    }
}

/// Runs `f` with counting armed and returns its result with the stats.
pub fn measure<R>(f: impl FnOnce() -> R) -> (R, AllocStats) {
    let guard = Measure::start();
    let result = f();
    (result, guard.finish())
}
