#!/usr/bin/env python3
"""Bounded loopback S3 protocol fixture; never connects to AWS. Requires pyarrow."""
import argparse, collections, hashlib, http.server, json, pathlib, random, struct, subprocess, threading, time, urllib.parse
import pyarrow as pa
import pyarrow.parquet as pq

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--scratch', type=pathlib.Path, required=True)
    ap.add_argument('--binary', type=pathlib.Path, required=True)
    ap.add_argument('--output', type=pathlib.Path, required=True)
    a = ap.parse_args()
    a.scratch.mkdir(parents=True, exist_ok=True)
    a.output.mkdir(parents=True, exist_ok=True)
    # Fixed entropy, 4 MiB payload, 64 columns x 100 row groups for a real large footer.
    rng = random.Random(20261110)
    small = pa.table({'message': [rng.randbytes(512) for _ in range(8192)], 'p_timestamp': list(range(8192))})
    pq.write_table(small, a.scratch/'small.parquet', compression='NONE', row_group_size=8192, use_dictionary=False, write_page_index=True)
    # Many column chunks, not padded user metadata: wide schema and many row groups.
    wide = pa.table({f'attr_{c:03}': [rng.randbytes(8) for _ in range(10000)] for c in range(128)})
    pq.write_table(wide, a.scratch/'large.parquet', compression='NONE', row_group_size=100, use_dictionary=False, write_page_index=True)
    pq.write_table(pa.concat_tables([wide]*3), a.scratch/'xlarge.parquet', compression='NONE', row_group_size=100, use_dictionary=False, write_page_index=True)
    fixture = {n: (a.scratch/f'{n}.parquet').read_bytes() for n in ['small', 'large', 'xlarge']}
    manifest = []
    for name, data in fixture.items():
        manifest.append({'case': name, 'object_bytes': len(data), 'footer_bytes': struct.unpack('<I', data[-8:-4])[0]+8, 'sha256': hashlib.sha256(data).hexdigest(), 'pyarrow': pa.__version__, 'rows': pq.read_metadata(a.scratch/f'{name}.parquet').num_rows})
    objects = {f'{n}-{h}.parquet': data for n,data in fixture.items() for h in [65536,524288,2097152]}
    objects.update({'ranges.parquet': fixture['small'], 'retry.parquet': fixture['small']})
    trace=[]
    retries=[0]
    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version='HTTP/1.1'
        def log_message(self,*args): pass
        def dispatch(self):
            p=urllib.parse.urlsplit(self.path)
            key=urllib.parse.unquote(p.path.removeprefix('/bench/'))
            incoming=0
            status=200
            body=b''
            extra={}
            if self.command=='PUT':
                incoming=int(self.headers.get('Content-Length','0'))
                objects[key]=self.rfile.read(incoming)
                extra['ETag']='"local-etag"'
            elif self.command=='GET' and p.query:
                body=('<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>bench</Name><IsTruncated>false</IsTruncated>'+''.join(f'<Contents><Key>{k}</Key><LastModified>2026-11-10T00:00:00Z</LastModified><ETag>"local-etag"</ETag><Size>{len(v)}</Size><StorageClass>STANDARD</StorageClass></Contents>' for k,v in sorted(objects.items()))+'</ListBucketResult>').encode()
                key='LIST'
            else:
                body=objects[key]
                if key=='retry.parquet' and not retries[0]:
                    retries[0]+=1
                    status=503
                    body=b'<Error><Code>SlowDown</Code><Message>Injected retry</Message></Error>'
                elif self.headers.get('Range'):
                    lo,hi=self.headers['Range'].removeprefix('bytes=').split('-')
                    if not lo: start,end=len(body)-int(hi),len(body)-1
                    else: start,end=int(lo),int(hi) if hi else len(body)-1
                    extra['Content-Range']=f'bytes {start}-{end}/{len(body)}'
                    body=body[start:end+1]
                    status=206
            self.send_response(status)
            for k,v in {'Content-Length':str(len(body)), 'Last-Modified':'Tue, 10 Nov 2026 00:00:00 GMT','ETag':'"local-etag"',**extra}.items(): self.send_header(k,v)
            self.end_headers()
            sent=0 if self.command=='HEAD' else len(body)
            trace.append({'sequence':len(trace)+1,'method':self.command,'operation':'LIST' if key=='LIST' else self.command,'key':key,'range':self.headers.get('Range'),'status':status,'response_body_bytes':sent,'request_body_bytes':incoming})
            if sent:self.wfile.write(body)
        do_GET=do_HEAD=do_PUT=dispatch
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        result=subprocess.run([str(a.binary.resolve()),f'http://127.0.0.1:{server.server_port}'],text=True,capture_output=True,timeout=120)
    finally:server.shutdown();server.server_close()
    (a.output/'wire.jsonl').write_text(''.join(json.dumps(x,sort_keys=True)+'\n' for x in trace))
    (a.output/'metadata.jsonl').write_text(result.stdout)
    (a.output/'fixtures.json').write_text(json.dumps(manifest,indent=2)+'\n')
    (a.output/'stderr.txt').write_text(result.stderr)
    summary=[]
    for key in sorted(set(x['key'] for x in trace)):
        events=[x for x in trace if x['key']==key]
        summary.append({'key':key,'attempts':dict(collections.Counter(x['method'] for x in events)),'statuses':dict(collections.Counter(str(x['status']) for x in events)),'response_body_bytes':sum(x['response_body_bytes'] for x in events),'request_body_bytes':sum(x['request_body_bytes'] for x in events)})
    (a.output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
    print(json.dumps({'exit_code':result.returncode,'attempts':len(trace),'output':str(a.output)}))
    if result.returncode: raise SystemExit(result.stderr)
if __name__=='__main__': main()
