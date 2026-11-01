//! A global allocator wrapper that counts allocations made by the current thread while a
//! [`Measure`] guard is armed on it. Other threads (the test harness, stdout capture) are
//! never counted, so measurements stay isolated without `--test-threads=1`.
//!
//! A guard started with [`Measure::start_bounded`] (or [`measure_bounded`]) also caps the
//! bytes requested on the armed thread. An allocation that would take them over the cap is
//! stopped before it reaches the system allocator: the process writes a line starting with
//! `alloc_counter:` to stderr and exits with status [`CAP_EXCEEDED_EXIT_CODE`]. An allocator
//! must not panic or unwind, so this is not an ordinary test failure; it keeps a rejection
//! test whose input started to be expanded from using more memory than the cap. Exiting
//! flushes stdout, so the code measured under a cap must not print to stdout. Guards from
//! [`Measure::start`] and [`measure`], which the benchmark uses, have no cap.
//!
//! Install it in each binary or integration test with
//! `#[global_allocator] static A: CountingAlloc = CountingAlloc;`.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::io::Write;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

/// Exit status of a process in which an allocation went over the cap of a bounded [`Measure`]
pub const CAP_EXCEEDED_EXIT_CODE: i32 = 88;

pub struct CountingAlloc;

thread_local! {
    static ARMED: Cell<bool> = const { Cell::new(false) };
}

static COUNT: AtomicU64 = AtomicU64::new(0);
static TOTAL_BYTES: AtomicU64 = AtomicU64::new(0);
// Cap on TOTAL_BYTES while armed; u64::MAX for none
static CAP_BYTES: AtomicU64 = AtomicU64::new(u64::MAX);
// Live bytes relative to arming; goes negative when pre-existing memory (e.g. a consumed
// input) is freed while armed
static CURRENT: AtomicI64 = AtomicI64::new(0);
static PEAK: AtomicI64 = AtomicI64::new(0);
// Serializes guards process-wide, since the counters are shared
static LOCK: Mutex<()> = Mutex::new(());

fn armed() -> bool {
    ARMED.try_with(Cell::get).unwrap_or(false)
}

// Called before an armed allocation of `size` bytes is handed to the system allocator
fn check_cap(size: usize) {
    let total = TOTAL_BYTES
        .load(Ordering::Relaxed)
        .saturating_add(size as u64);
    let cap = CAP_BYTES.load(Ordering::Relaxed);
    if total > cap {
        cap_exceeded(size, total, cap);
    }
}

#[cold]
fn cap_exceeded(size: usize, total: u64, cap: u64) -> ! {
    // Nothing from here on is counted or capped. The message is formatted on the stack and
    // written to a duplicate of fd 2, as `Stderr` takes a lock the measured code may hold.
    let _ = ARMED.try_with(|armed| armed.set(false));
    let mut message = [0u8; 512];
    let mut cursor = std::io::Cursor::new(&mut message[..]);
    let _ = writeln!(
        cursor,
        "alloc_counter: an allocation of {size} bytes on thread {:?} would take the bytes \
         requested while measuring to {total}, over the cap of {cap}; exiting with status \
         {CAP_EXCEEDED_EXIT_CODE}",
        std::thread::current().name().unwrap_or("<unnamed>"),
    );
    let len = cursor.position() as usize;
    write_stderr(&message[..len]);
    std::process::exit(CAP_EXCEEDED_EXIT_CODE)
}

#[cfg(unix)]
fn write_stderr(bytes: &[u8]) {
    use std::os::fd::AsFd;
    if let Ok(fd) = std::io::stderr().as_fd().try_clone_to_owned() {
        let _ = std::fs::File::from(fd).write_all(bytes);
    }
}

#[cfg(not(unix))]
fn write_stderr(bytes: &[u8]) {
    let _ = std::io::stderr().write_all(bytes);
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
        let armed = armed();
        if armed {
            check_cap(layout.size());
        }
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() && armed {
            on_alloc(layout.size());
        }
        ptr
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let armed = armed();
        if armed {
            check_cap(layout.size());
        }
        let ptr = unsafe { System.alloc_zeroed(layout) };
        if !ptr.is_null() && armed {
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
        let armed = armed();
        if armed {
            check_cap(new_size);
        }
        let new = unsafe { System.realloc(ptr, layout, new_size) };
        if !new.is_null() && armed {
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
    /// Counts without a cap
    pub fn start() -> Self {
        Self::start_with_cap(u64::MAX)
    }

    /// Counts, and exits the process (see the module docs) before an allocation that would
    /// take the bytes requested on this thread over `cap_bytes` is made
    pub fn start_bounded(cap_bytes: u64) -> Self {
        Self::start_with_cap(cap_bytes)
    }

    fn start_with_cap(cap_bytes: u64) -> Self {
        let lock = LOCK.lock().unwrap_or_else(|p| p.into_inner());
        COUNT.store(0, Ordering::SeqCst);
        TOTAL_BYTES.store(0, Ordering::SeqCst);
        CURRENT.store(0, Ordering::SeqCst);
        PEAK.store(0, Ordering::SeqCst);
        CAP_BYTES.store(cap_bytes, Ordering::SeqCst);
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
        CAP_BYTES.store(u64::MAX, Ordering::SeqCst);
    }
}

/// Runs `f` with counting armed and returns its result with the stats.
pub fn measure<R>(f: impl FnOnce() -> R) -> (R, AllocStats) {
    let guard = Measure::start();
    let result = f();
    (result, guard.finish())
}

/// [`measure`] under the cap of [`Measure::start_bounded`]
pub fn measure_bounded<R>(cap_bytes: u64, f: impl FnOnce() -> R) -> (R, AllocStats) {
    let guard = Measure::start_bounded(cap_bytes);
    let result = f();
    (result, guard.finish())
}
