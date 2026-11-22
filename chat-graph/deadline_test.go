package main

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codeman/chat-graph/store"
)

type fakeClock struct{ at time.Time }

func (c *fakeClock) now() time.Time { return c.at }

func deadlineHandler(t *testing.T) (http.Handler, *store.Store, *deadlines, *fakeClock) {
	t.Helper()
	var n int64
	st, err := store.Open(filepath.Join(t.TempDir(), storeName), func() int64 { n++; return n })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	clock := &fakeClock{at: time.Unix(1000, 0)}
	dl := newDeadlines(routeDeadline, clock.now)
	return newHandler(st, dl), st, dl, clock
}

func unsortedRoute(t *testing.T, h http.Handler, id string) gotRoute {
	t.Helper()
	var got struct {
		gotRoute
		Decision struct {
			gotDecision
			Unsorted bool `json:"unsorted"`
		} `json:"decision"`
	}
	if err := json.Unmarshal(must(t, h, "POST", "/messages/"+id+"/route", `{"unsorted":true}`), &got); err != nil {
		t.Fatal(err)
	}
	if !got.Decision.Unsorted {
		t.Fatalf("%s: decision does not say unsorted", id)
	}
	got.gotRoute.Decision = got.Decision.gotDecision
	return got.gotRoute
}

// Invariant I2: EveryMessageLandsVisibly
func TestUnsortedRouteSharesOneTopic(t *testing.T) {
	h := testHandler(t)
	postMessage(t, h, "m1", "budget for march")
	postMessage(t, h, "m2", "train to leeds")
	if got := unsortedRoute(t, h, "m1").summary(); got != `attach ; new unsorted "Unsorted"` {
		t.Fatalf("first unsorted: %s", got)
	}
	if got := unsortedRoute(t, h, "m2").summary(); got != "attach unsorted/nil/explicit" {
		t.Fatalf("second unsorted: %s", got)
	}
	if got := topicMessages(t, h, "unsorted"); got != "[m1 m2]" {
		t.Fatalf("unsorted holds %q", got)
	}
	status, out := callRaw(t, h, "POST", "/ops/m1/undo", "")
	if status != http.StatusConflict {
		t.Fatalf("undoing an unsorted route answered %d %s, want 409", status, out)
	}
}

// Invariant I2: EveryMessageLandsVisibly
func TestUnsortedLeavesAnArchivedUnsortedAlone(t *testing.T) {
	h := testHandler(t)
	postMessage(t, h, "m1", "budget for march")
	postMessage(t, h, "m2", "train to leeds")
	unsortedRoute(t, h, "m1")
	must(t, h, "POST", "/ops", `{"id":"a1","kind":"archive","topicId":"unsorted"}`)
	if got := unsortedRoute(t, h, "m2").summary(); got != `attach ; new unsorted-m2 "Unsorted"` {
		t.Fatalf("unsorted after archive: %s", got)
	}
}

func TestRouteBodyShapes(t *testing.T) {
	h := testHandler(t)
	postMessage(t, h, "m1", "budget")
	for _, body := range []string{
		`{"unsorted":true,"scores":[],"title":"x"}`,
		`{"unsorted":true,"signal":{"kind":"chip","topicId":"a"}}`,
		`{"unsorted":false}`,
	} {
		if status, out := callRaw(t, h, "POST", "/messages/m1/route", body); status != http.StatusBadRequest {
			t.Fatalf("%s answered %d %s, want 400", body, status, out)
		}
	}
}

// Invariant I2: EveryMessageLandsVisibly
func TestDeadlineFilesUnroutedMessageToUnsorted(t *testing.T) {
	h, st, dl, clock := deadlineHandler(t)
	postMessage(t, h, "m1", "budget for march")
	postMessage(t, h, "m2", "train to leeds")
	must(t, h, "POST", "/messages/m2/route", `{"scores":[],"title":"Travel"}`)

	clock.at = clock.at.Add(routeDeadline - time.Millisecond)
	dl.sweep(st)
	if got := topicMessages(t, h, "unsorted"); got != "<nil>" {
		t.Fatalf("swept before the deadline: unsorted holds %q", got)
	}
	clock.at = clock.at.Add(time.Millisecond)
	dl.sweep(st)
	if got := topicMessages(t, h, "unsorted"); got != "[m1]" {
		t.Fatalf("after the deadline unsorted holds %q, want m1 only", got)
	}

	// Scores that arrive late get the stored decision: the first one stands.
	out := string(must(t, h, "POST", "/messages/m1/route", `{"scores":[],"title":"Budget"}`))
	if !strings.Contains(out, `"unsorted":true`) {
		t.Fatalf("late scores answered %s, want the stored unsorted decision", out)
	}
}

// Invariant I2: EveryMessageLandsVisibly
func TestDeadlineSeedsFromTheStoreAfterARestart(t *testing.T) {
	h, st, _, _ := deadlineHandler(t)
	postMessage(t, h, "m1", "budget for march")

	clock := &fakeClock{at: time.Unix(5000, 0)}
	restarted := newDeadlines(routeDeadline, clock.now)
	if err := restarted.seed(st); err != nil {
		t.Fatal(err)
	}
	clock.at = clock.at.Add(routeDeadline)
	restarted.sweep(st)
	if got := topicMessages(t, h, "unsorted"); got != "[m1]" {
		t.Fatalf("after a restart unsorted holds %q, want m1", got)
	}
	if ids, err := st.UnroutedMessages(); err != nil || len(ids) != 0 {
		t.Fatalf("unrouted after the sweep: %v %v", ids, err)
	}
}
