"""Bounded Linux /proc diagnostics for the two benchmark processes only."""
import itertools
import json
import os
import pathlib
import threading
import time


class Diagnostics:
    """Stream 100 ms samples; never enumerate host processes or retain a sample history."""
    def __init__(self, pid, output, max_bytes=256 * 2**20, max_threads=256):
        self.pid, self.output = pid, output
        self.max_bytes, self.max_threads = max_bytes, max_threads
        self.stop = threading.Event()
        self.errors = []
        self.stats = dict(interval_s=.1, records=0, bytes=0, collection_wall_s=0.,
                          collection_cpu_s=0., max_collection_s=0., capped=False,
                          thread_lists_truncated=0)
        self.thread = threading.Thread(target=self._run, name='proc-diagnostic')

    def start(self):
        self.thread.start()

    def close(self):
        self.stop.set()
        self.thread.join()
        return dict(self.stats, errors=self.errors, path=str(self.output))

    def _process(self, pid):
        root = pathlib.Path(f'/proc/{pid}')
        tasks = list(itertools.islice((root / 'task').iterdir(), self.max_threads + 1))
        if len(tasks) > self.max_threads:
            self.stats['thread_lists_truncated'] += 1
        threads = []
        for task in tasks[:self.max_threads]:
            try:
                stat = (task / 'stat').read_text()
                fields = stat.rsplit(') ', 1)[1].split()
                threads.append(dict(tid=int(task.name), name=stat.split('(', 1)[1].rsplit(')', 1)[0],
                                    state=fields[0], minflt=int(fields[7]), majflt=int(fields[9]),
                                    cpu_ticks=int(fields[11]) + int(fields[12]),
                                    wchan=(task / 'wchan').read_text().strip(),
                                    schedstat=[int(x) for x in (task / 'schedstat').read_text().split()]))
            except (FileNotFoundError, ProcessLookupError):
                pass  # A thread can disappear between directory listing and reading.
        io = {k: int(v) for line in (root / 'io').read_text().splitlines()
              for k, v in [line.split(':', 1)]}
        return dict(pid=pid, io=io, threads=threads)

    def _run(self):
        try:
            with self.output.open('wb') as out:
                while not self.stop.is_set():
                    started, cpu = time.monotonic(), time.thread_time()
                    record = dict(monotonic_s=started, wall_s=time.time(),
                                  server=self._process(self.pid), client=self._process(os.getpid()),
                                  pressure={k: pathlib.Path(f'/proc/pressure/{k}').read_text()
                                            for k in ('cpu', 'io', 'memory')})
                    record['vmstat'] = {k: int(v) for k, v in
                                        (line.split() for line in pathlib.Path('/proc/vmstat').read_text().splitlines())
                                        if k in ('pswpin', 'pswpout', 'pgmajfault', 'pgfault',
                                                 'nr_dirty', 'nr_writeback', 'allocstall_normal')}
                    data = (json.dumps(record, separators=(',', ':')) + '\n').encode()
                    if self.stats['bytes'] + len(data) > self.max_bytes:
                        self.stats['capped'] = True
                        break
                    out.write(data)
                    duration = time.monotonic() - started
                    self.stats['records'] += 1
                    self.stats['bytes'] += len(data)
                    self.stats['collection_wall_s'] += duration
                    self.stats['collection_cpu_s'] += time.thread_time() - cpu
                    self.stats['max_collection_s'] = max(self.stats['max_collection_s'], duration)
                    self.stop.wait(max(0, .1 - duration))
        except Exception as error:
            self.errors.append(repr(error))
