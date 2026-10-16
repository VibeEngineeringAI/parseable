// Hermetic checks for the readiness waits added by quest-readiness.patch.
//
// prepare-quest-benchmark.sh --verify copies this file into Quest's
// tests/integration package, runs only ^TestHarness, and removes it again
// before the image is built. It replaces NewGlob.QueryClient, so it must never
// run alongside the real integration tests.

package main

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/xitongsys/parquet-go-source/local"
	"github.com/xitongsys/parquet-go/writer"

	httpclient "quest/tests/integration/clients/http"
	"quest/tests/integration/clients/pb"
	"quest/tests/integration/readiness"
)

// harnessParquetRow mirrors the columns Parseable writes for flog events.
type harnessParquetRow struct {
	Host      *string `parquet:"name=host, type=BYTE_ARRAY, convertedtype=UTF8, encoding=PLAIN_DICTIONARY"`
	UserId    *string `parquet:"name=user-identifier, type=BYTE_ARRAY, convertedtype=UTF8, encoding=PLAIN_DICTIONARY"`
	Timestamp *string `parquet:"name=datetime, type=BYTE_ARRAY, convertedtype=UTF8, encoding=PLAIN_DICTIONARY"`
	Method    *string `parquet:"name=method, type=BYTE_ARRAY, convertedtype=UTF8, encoding=PLAIN_DICTIONARY"`
	Request   *string `parquet:"name=request, type=BYTE_ARRAY, convertedtype=UTF8, encoding=PLAIN_DICTIONARY"`
	Protocol  *string `parquet:"name=protocol, type=BYTE_ARRAY, convertedtype=UTF8, encoding=PLAIN_DICTIONARY"`
	Status    *int32  `parquet:"name=status, type=INT32, encoding=PLAIN"`
	ByteCount *int32  `parquet:"name=bytes, type=INT32, encoding=PLAIN"`
	Referer   *string `parquet:"name=referer, type=BYTE_ARRAY, convertedtype=UTF8, encoding=PLAIN_DICTIONARY"`
}

func harnessFlogs(prefix string, n int) []Flog {
	flogs := make([]Flog, 0, n)
	for i := 0; i < n; i++ {
		flogs = append(flogs, Flog{
			Host:      fmt.Sprintf("10.0.0.%d", i),
			UserId:    "-",
			Timestamp: fmt.Sprintf("16/Oct/2026:12:00:%02d +0000", i),
			Method:    "GET",
			Request:   fmt.Sprintf("/%s/%d", prefix, i),
			Protocol:  "HTTP/1.1",
			Status:    uint16(200 + i),
			ByteCount: uint64(1000 + i),
			Referer:   "https://example.com/",
		})
	}
	return flogs
}

// writeHarnessParquet writes rows in the given order; nullHost leaves the host
// column empty on every row.
func writeHarnessParquet(t *testing.T, path string, flogs []Flog, nullHost bool) {
	t.Helper()
	fw, err := local.NewLocalFileWriter(path)
	require.NoError(t, err)
	pw, err := writer.NewParquetWriter(fw, new(harnessParquetRow), 1)
	require.NoError(t, err)
	for _, flog := range flogs {
		flog := flog
		status, byteCount := int32(flog.Status), int32(flog.ByteCount)
		row := harnessParquetRow{
			Host: &flog.Host, UserId: &flog.UserId, Timestamp: &flog.Timestamp, Method: &flog.Method,
			Request: &flog.Request, Protocol: &flog.Protocol, Status: &status, ByteCount: &byteCount,
			Referer: &flog.Referer,
		}
		if nullHost {
			row.Host = nil
		}
		require.NoError(t, pw.Write(row))
	}
	require.NoError(t, pw.WriteStop())
	require.NoError(t, fw.Close())
}

func reversed(flogs []Flog) []Flog {
	out := make([]Flog, len(flogs))
	for i, flog := range flogs {
		out[len(flogs)-1-i] = flog
	}
	return out
}

func TestHarnessParquetLoader(t *testing.T) {
	// Verifies Parquet loading round-trips rows and reports, rather than
	// panics on, truncated, empty or null-field files.
	dir := t.TempDir()
	expected := harnessFlogs("loader", 5)
	good := filepath.Join(dir, "good.parquet")
	writeHarnessParquet(t, good, expected, false)

	loaded, err := loadFlogsFromParquetFile(good)
	require.NoError(t, err)
	require.Equal(t, expected, loaded)

	contents, err := os.ReadFile(good)
	require.NoError(t, err)
	for name, data := range map[string][]byte{
		"empty.parquet":     nil,
		"truncated.parquet": contents[:len(contents)/2],
		"garbage.parquet":   []byte("PAR1 not really parquet PAR1"),
	} {
		path := filepath.Join(dir, name)
		require.NoError(t, os.WriteFile(path, data, 0o600))
		_, err := loadFlogsFromParquetFile(path)
		require.Error(t, err, name)
	}

	nulls := filepath.Join(dir, "nulls.parquet")
	writeHarnessParquet(t, nulls, expected[:1], true)
	_, err = loadFlogsFromParquetFile(nulls)
	require.ErrorContains(t, err, "null fields")

	_, err = loadFlogsFromParquetFiles([]string{good, filepath.Join(dir, "truncated.parquet")})
	require.Error(t, err)
}

// fakeS3 serves a bucket whose listing changes between ListObjectsV2 calls.
type fakeS3 struct {
	mu      sync.Mutex
	bucket  string
	phases  [][]fakeObject // one listing per call; the last repeats
	lists   int
	objects map[string][]byte
	denyAll bool
	// stallLists makes the first n listings hang; stallBodies makes object
	// bodies stop after a few bytes. Hung requests end when the client gives up.
	stallLists  int
	stallBodies bool
}

// stall blocks until the client abandons the request. The body is drained
// first because net/http only notices a disconnect once it has been read;
// the timer keeps a missed disconnect from hanging server shutdown.
func stall(r *http.Request) {
	_, _ = io.Copy(io.Discard, r.Body)
	select {
	case <-r.Context().Done():
	case <-time.After(10 * time.Second):
	}
}

type fakeObject struct {
	key  string
	data []byte
}

type s3ListResult struct {
	XMLName  xml.Name `xml:"ListBucketResult"`
	Name     string   `xml:"Name"`
	Prefix   string   `xml:"Prefix"`
	KeyCount int      `xml:"KeyCount"`
	MaxKeys  int      `xml:"MaxKeys"`
	Contents []struct {
		Key          string `xml:"Key"`
		Size         int    `xml:"Size"`
		ETag         string `xml:"ETag"`
		LastModified string `xml:"LastModified"`
		StorageClass string `xml:"StorageClass"`
	} `xml:"Contents"`
	IsTruncated bool `xml:"IsTruncated"`
}

func (s *fakeS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	if r.URL.Query().Get("list-type") == "2" && s.stallLists > 0 {
		s.stallLists--
		s.lists++
		s.mu.Unlock()
		stall(r)
		return
	}
	defer s.mu.Unlock()
	if s.denyAll {
		w.Header().Set("Content-Type", "application/xml")
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied.</Message></Error>`)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/"+s.bucket)
	path = strings.TrimPrefix(path, "/")
	query := r.URL.Query()
	switch {
	case path == "" && query.Has("location"):
		fmt.Fprint(w, `<?xml version="1.0" encoding="UTF-8"?><LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></LocationConstraint>`)
	case path == "" && query.Get("list-type") == "2":
		phase := s.phases[len(s.phases)-1]
		if s.lists < len(s.phases) {
			phase = s.phases[s.lists]
		}
		s.lists++
		s.objects = map[string][]byte{}
		result := s3ListResult{Name: s.bucket, Prefix: query.Get("prefix"), MaxKeys: 1000}
		for _, object := range phase {
			if !strings.HasPrefix(object.key, query.Get("prefix")) {
				continue
			}
			s.objects[object.key] = object.data
			result.Contents = append(result.Contents, struct {
				Key          string `xml:"Key"`
				Size         int    `xml:"Size"`
				ETag         string `xml:"ETag"`
				LastModified string `xml:"LastModified"`
				StorageClass string `xml:"StorageClass"`
			}{object.key, len(object.data), `"etag"`, "2026-10-16T12:00:00.000Z", "STANDARD"})
		}
		result.KeyCount = len(result.Contents)
		w.Header().Set("Content-Type", "application/xml")
		_ = xml.NewEncoder(w).Encode(result)
	default:
		data, ok := s.objects[path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>gone</Message></Error>`)
			return
		}
		w.Header().Set("Content-Length", fmt.Sprint(len(data)))
		w.Header().Set("Last-Modified", "Fri, 16 Oct 2026 12:00:00 GMT")
		w.Header().Set("ETag", `"etag"`)
		if r.Method == http.MethodHead {
			return
		}
		if s.stallBodies {
			_, _ = w.Write(data[:4])
			w.(http.Flusher).Flush()
			s.mu.Unlock()
			stall(r)
			s.mu.Lock()
			return
		}
		_, _ = w.Write(data)
	}
}

func (s *fakeS3) listCalls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lists
}

func startFakeS3(t *testing.T, s3 *fakeS3) MinIoConfig {
	t.Helper()
	server := httptest.NewServer(s3)
	t.Cleanup(server.Close)
	parsed, err := url.Parse(server.URL)
	require.NoError(t, err)
	return MinIoConfig{Url: parsed.Host, User: "minioadmin", Pass: "minioadmin", Bucket: s3.bucket}
}

func parquetBytes(t *testing.T, dir, name string, flogs []Flog) []byte {
	t.Helper()
	path := filepath.Join(dir, name)
	writeHarnessParquet(t, path, flogs, false)
	data, err := os.ReadFile(path)
	require.NoError(t, err)
	return data
}

func TestHarnessWaitForPersistedFlogs(t *testing.T) {
	// Verifies the integrity wait retries empty, partial and unreadable
	// listings until every record is persisted, then returns all rows in
	// the order TestIntegrity compares.
	fixtures := t.TempDir()
	stream := "harnessintegrity"
	expected := harnessFlogs("integrity", 100)
	firstHalf := parquetBytes(t, fixtures, "a.parquet", reversed(expected[:50]))
	secondHalf := parquetBytes(t, fixtures, "b.parquet", reversed(expected[50:]))
	keyA := stream + "/date=2026-10-16/hour=12/minute=00/a.parquet"
	keyB := stream + "/date=2026-10-16/hour=12/minute=01/b.parquet"
	s3 := &fakeS3{bucket: "parseable", phases: [][]fakeObject{
		{},
		{{stream + "/.stream.json", []byte("{}")}},
		{{keyA, firstHalf}},
		{{keyA, firstHalf}, {keyB, secondHalf[:len(secondHalf)/3]}},
		{{keyA, firstHalf}, {keyB, secondHalf}, {"other/x.parquet", []byte("ignored")}},
	}}
	config := startFakeS3(t, s3)

	rows := waitForPersistedFlogs(t, stream, config, t.TempDir(), expected, 10*time.Second, 10*time.Millisecond, 5*time.Second)

	require.Equal(t, 5, s3.listCalls())
	require.Len(t, rows, len(expected))
	require.Empty(t, readiness.Missing(expected, rows))
	// Same comparison as TestIntegrity: newest file first, newest row first.
	for i, expectedFlog := range expected {
		require.Equal(t, rows[len(rows)-i-1], expectedFlog)
	}
}

func TestHarnessPersistedFlogsPermanentErrors(t *testing.T) {
	// Verifies rejected MinIO credentials are not retried.
	s3 := &fakeS3{bucket: "parseable", denyAll: true, phases: [][]fakeObject{{}}}
	config := startFakeS3(t, s3)
	_, err := downloadParquetFiles(context.Background(), "harness", config, t.TempDir())
	require.Error(t, err)
	require.True(t, readiness.IsPermanent(err), "%v", err)
}

// fakePB writes a pb stand-in that returns successive counts per stream from
// <dir>/<stream>.counts, or an AUTH_FAILED envelope if <dir>/<stream>.auth exists.
func fakePB(t *testing.T, counts map[string][]int, authFailed ...string) pb.PBClient {
	client, _ := fakePBWithDir(t, counts, authFailed...)
	return client
}

// fakePBWithDir also returns the state directory; creating <stream>.stall
// there makes the next invocations for that stream hang.
func fakePBWithDir(t *testing.T, counts map[string][]int, authFailed ...string) (pb.PBClient, string) {
	t.Helper()
	dir := t.TempDir()
	for stream, values := range counts {
		var lines []string
		for _, value := range values {
			lines = append(lines, fmt.Sprint(value))
		}
		require.NoError(t, os.WriteFile(filepath.Join(dir, stream+".counts"), []byte(strings.Join(lines, "\n")+"\n"), 0o600))
	}
	for _, stream := range authFailed {
		require.NoError(t, os.WriteFile(filepath.Join(dir, stream+".auth"), nil, 0o600))
	}
	script := fmt.Sprintf(`#!/bin/sh
set -eu
dir=%q
[ "$1 $2" = "sql run" ] || exit 64
stream=${3##* }
if [ -e "$dir/$stream.stall" ]; then
  exec sleep 300
fi
if [ -e "$dir/$stream.auth" ]; then
  printf '| fetching...\033[K{"error":{"code":"AUTH_FAILED","message":"query failed: server returned 401 Unauthorized","http_status":401,"retryable":false}}\n'
  exit 1
fi
n=$(cat "$dir/$stream.n" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$dir/$stream.n"
total=$(wc -l < "$dir/$stream.counts")
[ "$n" -le "$total" ] || n=$total
count=$(sed -n "${n}p" "$dir/$stream.counts")
printf '[{"count":%%s}]\n' "$count"
`, dir)
	binary := filepath.Join(dir, "pb")
	require.NoError(t, os.WriteFile(binary, []byte(script), 0o700))
	return pb.PBClient{Binary: binary, Timeout: 10 * time.Second}, dir
}

func useQueryServer(t *testing.T, handler http.Handler) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	parsed, err := url.Parse(server.URL)
	require.NoError(t, err)
	previous := NewGlob.QueryClient
	NewGlob.QueryClient = httpclient.DefaultClient(*parsed, "admin", "admin")
	t.Cleanup(func() { NewGlob.QueryClient = previous })
}

// countsHandler returns successive counts API totals per stream.
func countsHandler(totals map[string][]uint64, status int) (http.Handler, *int32) {
	var calls int32
	var mu sync.Mutex
	seen := map[string]int{}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		if r.URL.Path != "/api/v1/counts" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		user, pass, ok := r.BasicAuth()
		if !ok || user != "admin" || pass != "admin" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if status != http.StatusOK {
			w.WriteHeader(status)
			return
		}
		var request struct {
			Stream  string `json:"stream"`
			NumBins int    `json:"numBins"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request.NumBins != 10 {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		values := totals[request.Stream]
		index := seen[request.Stream]
		seen[request.Stream]++
		mu.Unlock()
		if index >= len(values) {
			index = len(values) - 1
		}
		total := values[index]
		_ = json.NewEncoder(w).Encode(map[string]any{
			"fields": []string{"start_time", "end_time", "count"},
			"records": []map[string]any{
				{"start_time": "a", "end_time": "b", "count": total / 2},
				{"start_time": "b", "end_time": "c", "count": total - total/2},
			},
		})
	}), &calls
}

func TestHarnessWaitForStreamsQueryable(t *testing.T) {
	// Verifies the query wait requires both streams in SQL and persisted
	// counts, and returns as soon as both are complete.
	handler, _ := countsHandler(map[string][]uint64{
		"s1": {0, 50},
		"s2": {0, 0, 49, 50},
	}, http.StatusOK)
	useQueryServer(t, handler)
	client := fakePB(t, map[string][]int{"s1": {50}, "s2": {20, 50}})

	startedAt := time.Now()
	waitForStreamsQueryable(t, client, []string{"s1", "s2"}, 50, 10*time.Second, 10*time.Millisecond, 5*time.Second)
	require.Less(t, time.Since(startedAt), 5*time.Second)

	sqlCount, err := countStreamWithPB(context.Background(), client, "s2")
	require.NoError(t, err)
	require.Equal(t, uint64(50), sqlCount)
	persisted, err := countPersistedEvents(context.Background(), "s2")
	require.NoError(t, err)
	require.Equal(t, uint64(50), persisted)
}

func TestHarnessWaitForStreamsQueryableTimesOut(t *testing.T) {
	// Verifies an incomplete stream exhausts the bound, then defers to the
	// test's own assertions instead of failing inside the wait.
	handler, calls := countsHandler(map[string][]uint64{"s1": {50}, "s2": {50}}, http.StatusOK)
	useQueryServer(t, handler)
	client := fakePB(t, map[string][]int{"s1": {50}, "s2": {49}})

	startedAt := time.Now()
	waitForStreamsQueryable(t, client, []string{"s1", "s2"}, 50, 300*time.Millisecond, 50*time.Millisecond, 5*time.Second)
	require.GreaterOrEqual(t, time.Since(startedAt), 300*time.Millisecond)
	require.Greater(t, atomic.LoadInt32(calls), int32(2))
}

func TestHarnessQueryReadinessPermanentErrors(t *testing.T) {
	// Verifies rejected credentials from pb or the HTTP API are permanent.
	client := fakePB(t, map[string][]int{"s1": {50}}, "s1")
	_, err := countStreamWithPB(context.Background(), client, "s1")
	require.Error(t, err)
	require.True(t, readiness.IsPermanent(err), "%v", err)

	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		handler, _ := countsHandler(nil, status)
		useQueryServer(t, handler)
		_, err := countPersistedEvents(context.Background(), "s1")
		require.Error(t, err)
		require.True(t, readiness.IsPermanent(err), "status %d: %v", status, err)
	}

	handler, _ := countsHandler(nil, http.StatusInternalServerError)
	useQueryServer(t, handler)
	_, err = countPersistedEvents(context.Background(), "s1")
	require.Error(t, err)
	require.False(t, readiness.IsPermanent(err))
}

func TestHarnessWaitForAlertQueryValue(t *testing.T) {
	// Verifies the alert wait runs the alert's own query over its rolling
	// window and waits for the fixture value.
	stream := "harnessalert"
	alertBody := testAlertRequestBody(stream, "target-id", "title", "metric")
	var config testAlertQueryConfig
	require.NoError(t, json.Unmarshal([]byte(alertBody), &config))
	require.Equal(t, "select count(level) from harnessalert where level = 'info'", config.Query)

	responses := []string{`[]`, `[{"count(harnessalert.level)":0}]`, `[{"count(harnessalert.level)":1}]`}
	var calls int32
	useQueryServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Handlers run off the test goroutine, so report with Errorf, not require.
		var request map[string]string
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil || r.URL.Path != "/api/v1/query" {
			t.Errorf("unexpected alert query request %s: %v", r.URL.Path, err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		start, startErr := time.Parse(time.RFC3339Nano, request["startTime"])
		end, endErr := time.Parse(time.RFC3339Nano, request["endTime"])
		if request["query"] != config.Query || startErr != nil || endErr != nil || end.Sub(start) != 5*time.Minute {
			t.Errorf("alert query request does not match the alert: %v", request)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		index := int(atomic.AddInt32(&calls, 1)) - 1
		if index >= len(responses) {
			index = len(responses) - 1
		}
		_, _ = io.WriteString(w, responses[index])
	}))

	waitForAlertQueryValue(t, alertBody, 1, 10*time.Second, 10*time.Millisecond, 5*time.Second)
	require.Equal(t, int32(3), atomic.LoadInt32(&calls))
}

func TestHarnessAlertQueryValueErrors(t *testing.T) {
	// Verifies malformed results are retryable and rejected credentials are not.
	for body, permanent := range map[string]bool{
		`[{"a":1,"b":2}]`:   false,
		`[{"a":"1"}]`:       false,
		`{"error":"nope"}`:  false,
		`[{"a":1},{"a":1}]`: false,
		`<unauthorized>`:    true,
	} {
		body, permanent := body, permanent
		useQueryServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if permanent {
				w.WriteHeader(http.StatusUnauthorized)
			}
			_, _ = io.WriteString(w, body)
		}))
		_, err := queryAlertValue(context.Background(), "select 1", time.Minute)
		require.Error(t, err, body)
		require.Equal(t, permanent, readiness.IsPermanent(err), body)
	}
}

// stalledBound is how long a stalled attempt bounded by a 200ms context may
// take to unwind, allowing for minio-go's retry backoff and slow CI hosts.
const stalledBound = 3 * time.Second

func TestHarnessStalledMinIO(t *testing.T) {
	// Verifies hung MinIO listings and object bodies end with the attempt
	// context and are retryable rather than permanent.
	fixtures := t.TempDir()
	stream := "harnessstall"
	data := parquetBytes(t, fixtures, "a.parquet", harnessFlogs("stall", 3))
	objects := []fakeObject{{stream + "/a.parquet", data}}

	for name, s3 := range map[string]*fakeS3{
		"listing": {bucket: "parseable", stallLists: 1, phases: [][]fakeObject{objects}},
		"body":    {bucket: "parseable", stallBodies: true, phases: [][]fakeObject{objects}},
	} {
		config := startFakeS3(t, s3)
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		startedAt := time.Now()
		_, err := downloadParquetFiles(ctx, stream, config, t.TempDir())
		elapsed := time.Since(startedAt)
		cancel()
		require.Error(t, err, name)
		require.False(t, readiness.IsPermanent(err), "%s: %v", name, err)
		require.Less(t, elapsed, stalledBound, "%s: %v", name, err)
	}
}

func TestHarnessWaitForPersistedFlogsRecoversFromStalls(t *testing.T) {
	// Verifies stalled listings use up only their attempt, and a later
	// attempt still finds every record.
	fixtures := t.TempDir()
	stream := "harnessstallwait"
	expected := harnessFlogs("stallwait", 10)
	data := parquetBytes(t, fixtures, "a.parquet", reversed(expected))
	s3 := &fakeS3{bucket: "parseable", stallLists: 2, phases: [][]fakeObject{{{stream + "/a.parquet", data}}}}
	config := startFakeS3(t, s3)

	startedAt := time.Now()
	rows := waitForPersistedFlogs(t, stream, config, t.TempDir(), expected, 10*time.Second, 10*time.Millisecond, 200*time.Millisecond)
	require.Empty(t, readiness.Missing(expected, rows))
	require.Less(t, time.Since(startedAt), 2*stalledBound)
	require.GreaterOrEqual(t, s3.listCalls(), 3)
}

func TestHarnessStalledQueryIO(t *testing.T) {
	// Verifies hung pb invocations and HTTP requests (headers or body) end
	// with the attempt context and are retryable.
	client, dir := fakePBWithDir(t, map[string][]int{"s1": {50}})
	require.NoError(t, os.WriteFile(filepath.Join(dir, "s1.stall"), nil, 0o600))

	stalledHeaders := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { stall(r) })
	stalledBody := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `[{"cou`)
		w.(http.Flusher).Flush()
		stall(r)
	})

	checks := map[string]func(ctx context.Context) error{
		"pb": func(ctx context.Context) error {
			_, err := countStreamWithPB(ctx, client, "s1")
			return err
		},
	}
	for name, handler := range map[string]http.Handler{"headers": stalledHeaders, "body": stalledBody} {
		handler := handler
		checks["counts "+name] = func(ctx context.Context) error {
			useQueryServer(t, handler)
			_, err := countPersistedEvents(ctx, "s1")
			return err
		}
		checks["alert query "+name] = func(ctx context.Context) error {
			useQueryServer(t, handler)
			_, err := queryAlertValue(ctx, "select 1", time.Minute)
			return err
		}
	}
	for name, check := range checks {
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		startedAt := time.Now()
		err := check(ctx)
		elapsed := time.Since(startedAt)
		cancel()
		require.Error(t, err, name)
		require.False(t, readiness.IsPermanent(err), "%s: %v", name, err)
		require.Less(t, elapsed, stalledBound, "%s: %v", name, err)
	}
}

func TestHarnessWaitForStreamsQueryableBoundsStalls(t *testing.T) {
	// Verifies a wait whose every attempt hangs still ends within
	// Timeout + AttemptTimeout instead of the 60s HTTP or pb timeouts.
	useQueryServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { stall(r) }))
	client := fakePB(t, map[string][]int{"s1": {50}})

	const timeout, attemptTimeout = 300 * time.Millisecond, 200 * time.Millisecond
	startedAt := time.Now()
	waitForStreamsQueryable(t, client, []string{"s1"}, 50, timeout, 50*time.Millisecond, attemptTimeout)
	elapsed := time.Since(startedAt)
	require.GreaterOrEqual(t, elapsed, timeout)
	require.Less(t, elapsed, timeout+attemptTimeout+time.Second)
}
