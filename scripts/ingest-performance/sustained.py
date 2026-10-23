#!/usr/bin/env python3
"""Five-minute paced local-store check: equal offered rate, background work enabled."""
import argparse, concurrent.futures, http.client, json, os, pathlib, statistics, threading, time
from run import fixture, request, run_arm, snapshot, identified, verify_requests

def test(port, pid, seconds, rate, output):
    stream='benchsustained'
    payload=fixture(1000,20,True)
    # Align the arms with the same wall-clock minute phase (conversion is periodic).
    time.sleep((5-time.time()%60)%60)
    for i in range(4): request(port,'POST','/api/v1/ingest',identified(payload,i),stream)
    start=time.monotonic()+1
    count=int(seconds*rate)
    stop=threading.Event()
    samples=[]; monitor_errors=[]
    root=pathlib.Path(os.readlink(f'/proc/{pid}/cwd'))
    def monitor_loop():
        while not stop.is_set():
            sample=snapshot(pid); sample['elapsed_s']=time.monotonic()-start
            for folder in ['staging','data']:
                files=list((root/folder).rglob('*'))
                sizes=[]
                for file in files:
                    try:
                        if file.is_file(): sizes.append(file.stat().st_size)
                    except FileNotFoundError: pass
                sample[folder+'_bytes']=sum(sizes);sample[folder+'_files']=len(sizes)
            samples.append(sample)
            stop.wait(1)
    def monitor():
        try: monitor_loop()
        except Exception as err: monitor_errors.append(repr(err))
    monitor_thread=threading.Thread(target=monitor,daemon=True); monitor_thread.start()
    def worker(index):
        conn=http.client.HTTPConnection('127.0.0.1',port,timeout=90)
        observations=[]
        for i in range(index,count,4):
            body=identified(payload,i+4)
            due=start+i/rate
            delay=due-time.monotonic()
            if delay>0: time.sleep(delay)
            actual=time.monotonic()
            request(port,'POST','/api/v1/ingest',body,stream,conn)
            done=time.monotonic()
            observations.append({'request':i,'latency_s':done-actual,'scheduled_latency_s':done-due,'lag_s':actual-due})
        conn.close();return observations
    before=snapshot(pid)
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            futures=[pool.submit(worker,i) for i in range(4)]
            observations=[v for f in futures for v in f.result()]
        elapsed=time.monotonic()-start
        after=snapshot(pid)
        verify_requests(port,stream,1000,count+4)
        # Poll the target dataset, including its in-process conversion files.
        # Internal pstats may continue generating files after target ingestion stops.
        # Two consecutive empty observations avoid a transient rename window.
        drain_start=time.monotonic(); empty_samples=0
        while time.monotonic()-drain_start < 240:
            backlog=[]
            for f in (root/'staging'/stream).rglob('*'):
                try:
                    if f.is_file() and (f.suffix in ['.arrows','.parquet','.part'] or 'inprocess' in f.parts):
                        if f.stat().st_size: backlog.append(str(f))
                except FileNotFoundError: pass
            empty_samples = empty_samples+1 if not backlog else 0
            if empty_samples >= 3: break
            time.sleep(2)
        else: raise AssertionError(('staging did not drain',backlog[:10]))
        drain_seconds=time.monotonic()-drain_start
        after_drain=snapshot(pid)
        verify_requests(port,stream,1000,count+4)
    finally:
        stop.set();monitor_thread.join()
    assert not monitor_errors, monitor_errors
    assert len(samples)>=seconds, "incomplete resource monitoring"
    def quantile(key,fraction):
        values=sorted(o[key] for o in observations)
        return values[int(fraction*(len(values)-1))]*1000
    result={'duration_s':seconds,'offered_rows_per_s':rate*1000,'accepted_rows':count*1000,
            'elapsed_s':elapsed,'accepted_rows_per_s':count*1000/elapsed,'cpu_s':after['cpu_s']-before['cpu_s'],
            'cpu_including_drain_s':after_drain['cpu_s']-before['cpu_s'],'cpu_including_drain_us_per_row':(after_drain['cpu_s']-before['cpu_s'])*1e6/(count*1000),'cpu_us_per_row':(after['cpu_s']-before['cpu_s'])*1e6/(count*1000),
            'peak_rss_bytes':max(s['rss_bytes'] for s in samples),
            'p50_ms':quantile('latency_s',.5),'p95_ms':quantile('latency_s',.95),'p99_ms':quantile('latency_s',.99),
            'scheduled_p99_ms':quantile('scheduled_latency_s',.99),'max_schedule_lag_ms':max(o['lag_s'] for o in observations)*1000,
            'drain_wait_s':drain_seconds,'drain_scope':'target dataset staging; persisted-only restart verifies rows','verified_rows_before_and_after_drain':(count+4)*1000,'samples':samples,'binary_sha256':__import__('hashlib').sha256(pathlib.Path(os.readlink(f'/proc/{pid}/exe')).read_bytes()).hexdigest(),'loadavg_end':os.getloadavg()}
    output.write_text(json.dumps({'observations':observations,'result':result},indent=2))
    return result

def main():
    p=argparse.ArgumentParser(description=__doc__)
    for arg in ['baseline','candidate','output']:p.add_argument('--'+arg,type=pathlib.Path,required=True)
    p.add_argument('--seconds',type=int,default=300);p.add_argument('--requests-per-second',type=float,default=20)
    p.add_argument('--cpus',default='2,4,6,8')
    args=p.parse_args();args.output.mkdir(parents=True,exist_ok=False)
    for arm in ['baseline','candidate']:
        result=run_arm(getattr(args,arm).resolve(),args.output.resolve(),arm,0,[],args.cpus,
                       lambda port,pid:test(port,pid,args.seconds,args.requests_per_second,args.output/(arm+'-samples.json')),
                       persisted_restart_check=lambda port:verify_requests(port,'benchsustained',1000,int(args.seconds*args.requests_per_second)+4))
        print(json.dumps({k:v for k,v in result.items() if k!='samples'},indent=2),flush=True)

if __name__=='__main__':main()
