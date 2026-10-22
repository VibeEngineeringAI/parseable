//! Compile as an external consumer: `Writer` is reached through type inference.
use parseable::parseable::Stream;
use std::path::PathBuf;
use std::time::SystemTime;

fn read_writer(stream: &Stream) {
    let writer = stream.writer.lock().unwrap();
    let _ = writer.disk.len();
    let _ = writer.mem.is_some();
}

#[test]
fn staging_public_surface_remains_reachable() {
    // Type-check read access without constructing a stream or mutating writers.
    let _: fn(&Stream) = read_writer;
    let _: fn(&Stream, SystemTime, u128, bool, bool) -> Vec<(PathBuf, Vec<PathBuf>)> =
        Stream::arrow_files_grouped_exclude_time;
    fn auto_traits<T: Send + Sync + std::panic::UnwindSafe + std::panic::RefUnwindSafe>() {}
    auto_traits::<Stream>();
}
