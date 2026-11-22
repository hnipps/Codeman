package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"codeman/chat-graph/store"
)

func testHandler(t *testing.T) http.Handler {
	t.Helper()
	var n int64
	st, err := store.Open(filepath.Join(t.TempDir(), storeName), func() int64 { n++; return n })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return newHandler(st, nil)
}

func call(t *testing.T, h http.Handler, method, path, body string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
	var out map[string]any
	if strings.HasPrefix(rec.Body.String(), "{") {
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("%s %s answered non-JSON %q", method, path, rec.Body.String())
		}
	}
	return rec.Code, out
}

func TestRoutes(t *testing.T) {
	h := testHandler(t)
	steps := []struct {
		method, path, body string
		status             int
		code               string
	}{
		{"POST", "/messages", `{"id":"m1","text":"budget for march","ts":10,"author":"harry"}`, 200, ""},
		{"POST", "/messages", `{"id":"m1","text":"budget for march","ts":10,"author":"harry"}`, 200, ""},
		{"POST", "/messages", `{"id":"m1","text":"something else","ts":10,"author":"harry"}`, 409, "conflict"},
		{"POST", "/messages", `{"id":"m2","text":"","ts":10,"author":"harry"}`, 400, "invalid"},
		{"POST", "/messages", `not json`, 400, "invalid"},
		{"POST", "/messages", `{"id":"m2","text":"train to leeds","ts":11,"author":"harry","kind":"capture"}`, 200, ""},
		{"POST", "/ops", `{"id":"m1","kind":"route","messageId":"m1","topics":[{"topicId":"a","confidence":0.9}],"newTopics":[{"id":"a","title":"Budget"}]}`, 200, ""},
		{"POST", "/ops", `{"id":"m2","kind":"route","messageId":"m2","topics":[{"topicId":"b"}],"newTopics":[{"id":"b","title":"Travel"}]}`, 200, ""},
		{"POST", "/ops", `{"id":"x","kind":"route","messageId":"m1","topics":[{"topicId":"a"}]}`, 400, "invalid"},
		{"POST", "/ops", `{"id":"op1","kind":"teleport"}`, 400, "invalid"},
		{"POST", "/ops", `{"id":"op1","kind":"attach","messageId":"nope","topicId":"a","source":"reply"}`, 404, "not_found"},
		{"POST", "/ops", `{"id":"op1","kind":"attach","messageId":"m1","topicId":"a","source":"reply"}`, 409, "conflict"},
		{"POST", "/ops", `{"id":"op2","kind":"merge","from":"b","into":"a"}`, 200, ""},
		{"POST", "/ops", `{"id":"op2","kind":"merge","from":"b","into":"a"}`, 200, ""},
		{"POST", "/ops", `{"id":"op2","kind":"archive","topicId":"a"}`, 409, "conflict"},
		{"POST", "/ops/m1/undo", ``, 409, "conflict"},
		{"POST", "/ops/nope/undo", ``, 404, "not_found"},
	}
	for i, s := range steps {
		status, body := call(t, h, s.method, s.path, s.body)
		if status != s.status || (s.code != "" && body["code"] != s.code) {
			t.Fatalf("step %d %s %s %s: got %d %v, want %d %q", i, s.method, s.path, s.body, status, body, s.status, s.code)
		}
		if s.code != "" && body["error"] == "" {
			t.Fatalf("step %d: error body has no message: %v", i, body)
		}
	}

	if status, body := call(t, h, "GET", "/topics/a", ""); status != 200 || fmt.Sprint(body["messageIds"]) != "[m1 m2]" {
		t.Fatalf("GET /topics/a after merge: %d %v", status, body)
	}
	if status, body := call(t, h, "POST", "/ops/op2/undo", ""); status != 200 || body["undoneAt"] == nil {
		t.Fatalf("undo merge: %d %v", status, body)
	}
	if status, body := call(t, h, "GET", "/topics/b", ""); status != 200 || body["status"] != "live" || fmt.Sprint(body["messageIds"]) != "[m2]" {
		t.Fatalf("GET /topics/b after undo: %d %v", status, body)
	}
	if status, _ := call(t, h, "GET", "/topics/nope", ""); status != 404 {
		t.Fatalf("GET /topics/nope: %d", status)
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/topics", nil))
	var topics []store.TopicSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &topics); err != nil || rec.Code != 200 {
		t.Fatalf("GET /topics: %d %s", rec.Code, rec.Body)
	}
	members := map[string]int{}
	for _, tp := range topics {
		members[tp.ID+"/"+tp.Status] = tp.LiveMembers
	}
	if want := map[string]int{"a/live": 1, "b/live": 1}; fmt.Sprint(members) != fmt.Sprint(want) {
		t.Fatalf("GET /topics live members %v, want %v", members, want)
	}
}

func buildSidecar(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "chat-graph")
	out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput()
	if err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	return bin
}

type sidecar struct {
	cmd    *exec.Cmd
	client *http.Client
}

func startSidecar(t *testing.T, bin, dir string) *sidecar {
	t.Helper()
	cmd := exec.Command(bin, "--dir", dir)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	c := client(filepath.Join(dir, socketName))
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if res, err := c.Get("http://chat-graph/health"); err == nil {
			res.Body.Close()
			return &sidecar{cmd: cmd, client: c}
		}
	}
	t.Fatal("sidecar never answered /health")
	return nil
}

func (s *sidecar) post(t *testing.T, path, body string) {
	t.Helper()
	res, err := s.client.Post("http://chat-graph"+path, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("POST %s answered %d", path, res.StatusCode)
	}
}

func TestStoreFilesArePrivate(t *testing.T) {
	dir := shortDir(t)
	sc := startSidecar(t, buildSidecar(t), dir)
	sc.post(t, "/messages", `{"id":"m1","text":"private words","ts":1,"author":"harry"}`)
	sc.post(t, "/ops", `{"id":"m1","kind":"route","messageId":"m1","topics":[{"topicId":"a"}],"newTopics":[{"id":"a","title":"Budget"}]}`)
	for _, name := range []string{storeName, storeName + "-wal", storeName + "-shm"} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if mode := info.Mode().Perm(); mode != 0o600 {
			t.Fatalf("%s mode %o, want 600", name, mode)
		}
	}
	sc.cmd.Process.Signal(syscall.SIGTERM)
	if err := sc.cmd.Wait(); err != nil {
		t.Fatalf("sidecar did not exit cleanly on SIGTERM: %v", err)
	}
}

func rssKB(t *testing.T, pid int, field string) int {
	t.Helper()
	f, err := os.Open(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if v, ok := strings.CutPrefix(sc.Text(), field+":"); ok {
			kb, err := strconv.Atoi(strings.Fields(v)[0])
			if err != nil {
				t.Fatal(err)
			}
			return kb
		}
	}
	t.Fatalf("no %s in /proc/%d/status", field, pid)
	return 0
}

// Acceptance check 5: the sidecar stays under 64 MB after 100,000 messages
// are filed into 1,000 topics. Heavy, so it runs only when asked for.
func TestLoadMemory(t *testing.T) {
	if os.Getenv("CHAT_GRAPH_LOAD_TEST") != "1" {
		t.Skip("set CHAT_GRAPH_LOAD_TEST=1 to run")
	}
	const messages, topics = 100_000, 1_000
	dir := shortDir(t)
	sc := startSidecar(t, buildSidecar(t), dir)
	words := strings.Fields("budget train leeds invoice march plan dentist garden roof quote paint kids school trip " +
		"tax return pension car service insurance flight hotel visa book call email draft review design deploy bug")
	rng := rand.New(rand.NewSource(1))
	start := time.Now()
	for i := 0; i < messages; i++ {
		id := fmt.Sprintf("m%d", i)
		text := make([]string, 8+rng.Intn(12))
		for j := range text {
			text[j] = words[rng.Intn(len(words))]
		}
		sc.post(t, "/messages", fmt.Sprintf(`{"id":%q,"text":%q,"ts":%d,"author":"harry"}`, id, strings.Join(text, " "), i+1))
		topic := fmt.Sprintf("t%d", i%topics)
		newTopics := ""
		if i < topics {
			newTopics = fmt.Sprintf(`,"newTopics":[{"id":%q,"title":"topic %d"}]`, topic, i)
		}
		sc.post(t, "/ops", fmt.Sprintf(`{"id":%q,"kind":"route","messageId":%q,"topics":[{"topicId":%q,"confidence":0.8}]%s}`, id, id, topic, newTopics))
	}
	elapsed := time.Since(start)
	pid := sc.cmd.Process.Pid
	rss, hwm := rssKB(t, pid, "VmRSS"), rssKB(t, pid, "VmHWM")
	info, _ := os.Stat(filepath.Join(dir, storeName))
	t.Logf("%d messages into %d topics in %s; VmRSS %d kB, VmHWM %d kB; graph.sqlite %d bytes", messages, topics, elapsed, rss, hwm, info.Size())
	if rss > 64*1024 {
		t.Fatalf("VmRSS %d kB is over 64 MB", rss)
	}
}
