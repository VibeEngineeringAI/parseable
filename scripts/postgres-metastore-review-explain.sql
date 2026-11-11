-- Run only against a disposable database after applying migrations 000..002.
INSERT INTO parseable_documents(tenant,kind,key,body)
SELECT 'tenant-' || (i % 4), 'manifest', 'tenant-' || (i % 4) || '/logs/date=' || lpad((i % 100)::text,3,'0') || '/' || i || '.manifest.json', repeat('x',1024)::bytea
FROM generate_series(1,200000) i;
INSERT INTO parseable_documents(tenant,kind,key,body)
SELECT 'tenant-' || t, 'stream', 'tenant-' || t || '/stream-' || n || '/.stream/.stream.json', '{}'::bytea
FROM generate_series(0,3) t CROSS JOIN generate_series(1,100) n;
ANALYZE parseable_documents;
SELECT count(*), count(DISTINCT tenant) FROM parseable_documents;
EXPLAIN (ANALYZE, BUFFERS) SELECT key FROM parseable_documents WHERE tenant='tenant-1' AND (key='tenant-1/logs/date=001' OR (key >= 'tenant-1/logs/date=001/' AND key < 'tenant-1/logs/date=0010')) ORDER BY key;
EXPLAIN (ANALYZE, BUFFERS) SELECT key,body FROM parseable_documents WHERE tenant='tenant-1' AND (key='tenant-1/logs/date=001' OR (key >= 'tenant-1/logs/date=001/' AND key < 'tenant-1/logs/date=0010')) ORDER BY key;
EXPLAIN (ANALYZE, BUFFERS) SELECT key,body FROM parseable_documents WHERE tenant='tenant-1' AND key=ANY(ARRAY['tenant-1/logs/date=001/1.manifest.json','tenant-1/logs/date=001/101.manifest.json']);
EXPLAIN (ANALYZE, BUFFERS) SELECT key FROM parseable_documents WHERE tenant='tenant-1' AND key LIKE '%/.stream/%';
BEGIN;
EXPLAIN (ANALYZE, BUFFERS) DELETE FROM parseable_documents WHERE tenant='tenant-1' AND (key='tenant-1/logs/date=001' OR (key >= 'tenant-1/logs/date=001/' AND key < 'tenant-1/logs/date=0010'));
ROLLBACK;
EXPLAIN (ANALYZE, BUFFERS) SELECT EXISTS(SELECT 1 FROM parseable_documents WHERE tenant='tenant-1' AND key >= 'tenant-1/stream-1/.stream/' AND key < 'tenant-1/stream-1/.stream0' AND key LIKE '%stream.json');
