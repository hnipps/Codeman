package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func callRaw(t *testing.T, h http.Handler, method, path, body string) (int, []byte) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
	return rec.Code, rec.Body.Bytes()
}

func must(t *testing.T, h http.Handler, method, path, body string) []byte {
	t.Helper()
	status, out := callRaw(t, h, method, path, body)
	if status != 200 {
		t.Fatalf("%s %s %s: %d %s", method, path, body, status, out)
	}
	return out
}

func postMessage(t *testing.T, h http.Handler, id, text string) {
	t.Helper()
	must(t, h, "POST", "/messages", fmt.Sprintf(`{"id":%q,"text":%q,"ts":1,"author":"harry"}`, id, text))
}

type gotDecision struct {
	Attach []struct {
		TopicID    string   `json:"topicId"`
		Confidence *float64 `json:"confidence"`
		Band       string   `json:"band"`
	} `json:"attach"`
	NewTopic *struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	} `json:"newTopic"`
	Reactivate string `json:"reactivate"`
}

type gotRoute struct {
	Op struct {
		ID    string `json:"id"`
		Kind  string `json:"kind"`
		Added []struct {
			MessageID string `json:"messageId"`
			TopicID   string `json:"topicId"`
		} `json:"added"`
	} `json:"op"`
	Decision gotDecision `json:"decision"`
}

// summary renders a decision as "attach a/0.9/quiet b/nil/explicit; new id 'title'; reactivate x".
func (g gotRoute) summary() string {
	var parts []string
	for _, a := range g.Decision.Attach {
		c := "nil"
		if a.Confidence != nil {
			c = fmt.Sprint(*a.Confidence)
		}
		parts = append(parts, fmt.Sprintf("%s/%s/%s", a.TopicID, c, a.Band))
	}
	s := "attach " + strings.Join(parts, " ")
	if nt := g.Decision.NewTopic; nt != nil {
		s += fmt.Sprintf("; new %s %q", nt.ID, nt.Title)
	}
	if g.Decision.Reactivate != "" {
		s += "; reactivate " + g.Decision.Reactivate
	}
	return s
}

func routeOK(t *testing.T, h http.Handler, id, body string) gotRoute {
	t.Helper()
	raw := must(t, h, "POST", "/messages/"+id+"/route", body)
	var g gotRoute
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	if g.Op.ID != id || g.Op.Kind != "route" {
		t.Fatalf("route %s answered op %+v", id, g.Op)
	}
	return g
}

func topicMessages(t *testing.T, h http.Handler, topic string) string {
	t.Helper()
	_, body := call(t, h, "GET", "/topics/"+topic, "")
	return fmt.Sprint(body["messageIds"])
}

func TestCandidates(t *testing.T) {
	h := testHandler(t)
	postMessage(t, h, "m1", "boiler valve is leaking")
	postMessage(t, h, "m2", "the boiler again")
	must(t, h, "POST", "/ops", `{"id":"m1","kind":"route","messageId":"m1","topics":[{"topicId":"a"}],"newTopics":[{"id":"a","title":"Plumbing"},{"id":"n","title":"Boiler notes"}]}`)

	raw := must(t, h, "POST", "/messages/m2/candidates", ``)
	var got struct {
		Candidates []struct {
			TopicID        string   `json:"topicId"`
			Title          string   `json:"title"`
			Status         string   `json:"status"`
			Activation     *float64 `json:"activation"`
			Similarity     float64  `json:"similarity"`
			RetrievalScore *float64 `json:"retrievalScore"`
		} `json:"candidates"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	byID := map[string]int{}
	for i, c := range got.Candidates {
		byID[c.TopicID] = i
	}
	if len(got.Candidates) != 2 {
		t.Fatalf("candidates for m2: %s", raw)
	}
	a, n := got.Candidates[byID["a"]], got.Candidates[byID["n"]]
	if a.Title != "Plumbing" || a.Status != "live" || a.Activation == nil || a.RetrievalScore == nil || a.Similarity <= 0 {
		t.Fatalf("touched candidate a: %+v", a)
	}
	if n.Title != "Boiler notes" || n.Activation != nil || n.RetrievalScore != nil {
		t.Fatalf("never-touched candidate n: %+v", n)
	}
	if !strings.Contains(string(raw), `"activation":null`) || !strings.Contains(string(raw), `"retrievalScore":null`) {
		t.Fatalf("a never-touched topic's -Inf is not encoded as null: %s", raw)
	}

	raw = must(t, h, "POST", "/messages/m2/candidates", `{"query":"plumbing"}`)
	if !strings.Contains(string(raw), `"topicId":"a"`) || strings.Contains(string(raw), `"topicId":"n"`) {
		t.Fatalf("query override: %s", raw)
	}
	if raw := must(t, h, "POST", "/messages/m2/candidates", `{"query":"(\"*"}`); string(raw) != "{\"candidates\":[]}\n" {
		t.Fatalf("hostile query with no terms: %s", raw)
	}
	for i := 3; i < 12; i++ {
		postMessage(t, h, fmt.Sprintf("x%d", i), "kettle")
		must(t, h, "POST", "/ops", fmt.Sprintf(`{"id":"x%d","kind":"route","messageId":"x%d","topics":[{"topicId":"k%d"}],"newTopics":[{"id":"k%d","title":"Kettle"}]}`, i, i, i, i))
	}
	raw = must(t, h, "POST", "/messages/x3/candidates", ``)
	if n := strings.Count(string(raw), `"topicId"`); n != 5 {
		t.Fatalf("9 matching topics gave %d candidates, want 5", n)
	}
	if status, _ := callRaw(t, h, "POST", "/messages/nope/candidates", `{}`); status != 404 {
		t.Fatalf("candidates for an unknown message: %d", status)
	}
	if status, _ := callRaw(t, h, "POST", "/messages/m2/candidates", `[`); status != 400 {
		t.Fatalf("candidates with a broken body: %d", status)
	}
}

func seedRouting(t *testing.T, h http.Handler) {
	t.Helper()
	for _, m := range [][2]string{
		{"m1", "boiler valve"}, {"m2", "boiler again"}, {"m3", "valve part number"}, {"m4", "both"},
		{"m5", "rose bed"}, {"m6", "misc"}, {"m7", "old roof quote"}, {"m8", "re roof"},
		{"m9", "quoting roof"}, {"m10", "chip roof"}, {"m11", "roof scores"}, {"m12", "reply live"},
		{"m13", "unrouted"}, {"m14", "chip dup"}, {"m15", "orphan"},
	} {
		postMessage(t, h, m[0], m[1])
	}
	must(t, h, "POST", "/ops", `{"id":"m1","kind":"route","messageId":"m1","topics":[{"topicId":"a"}],"newTopics":[{"id":"a","title":"Plumbing"},{"id":"n","title":"Notes"}]}`)
	must(t, h, "POST", "/ops", `{"id":"m7","kind":"route","messageId":"m7","topics":[{"topicId":"roof"}],"newTopics":[{"id":"roof","title":"Roof"}]}`)
	must(t, h, "POST", "/ops", `{"id":"op-archive","kind":"archive","topicId":"roof"}`)
	must(t, h, "POST", "/ops", `{"id":"op-dup","kind":"attach","messageId":"m15","topicId":"dup","source":"reply","newTopics":[{"id":"dup","title":"Dup"}]}`)
	must(t, h, "POST", "/ops", `{"id":"op-merge","kind":"merge","from":"dup","into":"a"}`)
	must(t, h, "POST", "/ops", `{"id":"op-gone","kind":"attach","messageId":"m13","topicId":"gone","source":"reply","newTopics":[{"id":"gone","title":"Gone"}]}`)
	must(t, h, "POST", "/ops/op-gone/undo", ``)
}

func TestRouteMessage(t *testing.T) {
	h := testHandler(t)
	seedRouting(t, h)
	cases := []struct {
		id, body, want string
	}{
		{"m2", `{"scores":[{"topicId":"a","score":0.9},{"topicId":"n","score":0.2}],"title":"Boilers"}`, "attach a/0.9/quiet"},
		{"m3", `{"scores":[{"topicId":"a","score":0.6}],"title":"Valves"}`, "attach a/0.6/prominent"},
		{"m4", `{"scores":[{"topicId":"a","score":0.9},{"topicId":"n","score":0.85}],"title":"Both"}`, "attach a/0.9/quiet n/0.85/quiet"},
		{"m5", `{"scores":[{"topicId":"a","score":0.3}],"title":"Garden","resolvedText":"the rose bed"}`, `attach ; new m5 "Garden"`},
		{"m6", `{"scores":[],"title":"Misc","newTopic":{"id":"misc"}}`, `attach ; new misc "Misc"`},
		{"m12", `{"signal":{"kind":"reply","messageId":"m2"}}`, "attach a/nil/explicit"},
		{"m14", `{"signal":{"kind":"chip","topicId":"dup"}}`, "attach a/nil/explicit"},
	}
	for _, c := range cases {
		g := routeOK(t, h, c.id, c.body)
		if got := g.summary(); got != c.want {
			t.Errorf("route %s %s: %s, want %s", c.id, c.body, got, c.want)
		}
		if len(g.Op.Added) == 0 || g.Op.Added[0].MessageID != c.id {
			t.Errorf("route %s added %+v", c.id, g.Op.Added)
		}
	}
	if got := topicMessages(t, h, "m5"); got != "[m5]" {
		t.Fatalf("new topic m5 holds %s", got)
	}

	first := must(t, h, "POST", "/messages/m3/route", `{"scores":[{"topicId":"n","score":0.99}],"title":"Other"}`)
	again := must(t, h, "POST", "/messages/m3/route", `{"signal":{"kind":"chip","topicId":"n"}}`)
	var g gotRoute
	json.Unmarshal(first, &g)
	if g.summary() != "attach a/0.6/prominent" || string(first) != string(again) {
		t.Fatalf("a repeat route answered\n%s\nand\n%s\nnot the first decision", first, again)
	}
	if got := topicMessages(t, h, "n"); got != "[m4]" {
		t.Fatalf("a repeat route changed topic n: %s", got)
	}
}

// Invariant I3: ArchivedNeverAttachedSilently
func TestExplicitSignalNeverAttachesAnArchivedTopic(t *testing.T) {
	h := testHandler(t)
	seedRouting(t, h)
	cases := []struct {
		id, body, want string
	}{
		{"m8", `{"signal":{"kind":"reply","messageId":"m7"}}`, `attach ; new m8 "Roof"; reactivate roof`},
		{"m9", `{"signal":{"kind":"quote","messageId":"m7"},"newTopic":{"id":"roof2","title":"Roof again"}}`, `attach ; new roof2 "Roof again"; reactivate roof`},
		{"m10", `{"signal":{"kind":"chip","topicId":"roof"}}`, `attach ; new m10 "Roof"; reactivate roof`},
		{"m11", `{"scores":[{"topicId":"roof","score":0.95},{"topicId":"a","score":0.2}],"title":"Roofing"}`, `attach ; new m11 "Roofing"; reactivate roof`},
	}
	for _, c := range cases {
		if got := routeOK(t, h, c.id, c.body).summary(); got != c.want {
			t.Errorf("route %s %s: %s, want %s", c.id, c.body, got, c.want)
		}
	}
	if got := topicMessages(t, h, "roof"); got != "[m7]" {
		t.Fatalf("archived topic roof gained a membership: %s", got)
	}
	again := must(t, h, "POST", "/messages/m8/route", `{"signal":{"kind":"reply","messageId":"m7"}}`)
	if !strings.Contains(string(again), `"reactivate":"roof"`) {
		t.Fatalf("a replay lost the reactivate offer: %s", again)
	}
}

func TestRouteMessageRefusals(t *testing.T) {
	h := testHandler(t)
	seedRouting(t, h)
	cases := []struct {
		id, body string
		status   int
	}{
		{"m2", `{}`, 400},
		{"m2", `not json`, 400},
		{"m2", `{"signal":{"kind":"chip","topicId":"a"},"scores":[],"title":"x"}`, 400},
		{"m2", `{"signal":{"kind":"chip","topicId":"a"},"title":"x"}`, 400},
		{"m2", `{"signal":{"kind":"wave","topicId":"a"}}`, 400},
		{"m2", `{"signal":{"kind":"reply","topicId":"a"}}`, 400},
		{"m2", `{"signal":{"kind":"chip","messageId":"m1"}}`, 400},
		{"m2", `{"scores":[{"topicId":"a","score":0.9}]}`, 400},
		{"m2", `{"scores":[{"topicId":"a","score":0.9}],"title":""}`, 400},
		{"m2", `{"scores":[{"topicId":"a","score":1.5}],"title":"x"}`, 400},
		{"m2", `{"scores":[{"topicId":"a","score":-0.1}],"title":"x"}`, 400},
		{"m2", `{"scores":[{"topicId":"a"}],"title":"x"}`, 400},
		{"m2", `{"scores":[{"topicId":"a","score":0.9},{"topicId":"a","score":0.8}],"title":"x"}`, 400},
		{"m2", `{"scores":[{"topicId":"nope","score":0.9}],"title":"x"}`, 404},
		{"m2", `{"signal":{"kind":"reply","messageId":"m2"}}`, 400},
		{"m2", `{"signal":{"kind":"quote","messageId":"nope"}}`, 404},
		{"m2", `{"signal":{"kind":"reply","messageId":"m13"}}`, 409},
		{"m2", `{"signal":{"kind":"chip","topicId":"nope"}}`, 404},
		{"m2", `{"signal":{"kind":"chip","topicId":"gone"}}`, 409},
		{"m2", `{"scores":[{"topicId":"a","score":0.1}],"title":"x","newTopic":{"id":"a"}}`, 409},
		{"nope", `{"scores":[],"title":"x"}`, 404},
	}
	for _, c := range cases {
		if status, body := callRaw(t, h, "POST", "/messages/"+c.id+"/route", c.body); status != c.status {
			t.Errorf("route %s %s: %d %s, want %d", c.id, c.body, status, body, c.status)
		}
	}
	if got := topicMessages(t, h, "a"); got != "[m1 m15]" {
		t.Fatalf("refused routes changed topic a: %s", got)
	}
}

func TestCorrectionsRoute(t *testing.T) {
	h := testHandler(t)
	seedRouting(t, h)
	routeOK(t, h, "m2", `{"scores":[{"topicId":"a","score":0.9}],"title":"x","resolvedText":"the boiler, again"}`)
	must(t, h, "POST", "/ops", `{"id":"op-move","kind":"move","messageId":"m2","from":"a","to":"n"}`)

	var got struct {
		Corrections []map[string]any `json:"corrections"`
	}
	json.Unmarshal(must(t, h, "GET", "/corrections", ""), &got)
	if len(got.Corrections) != 1 {
		t.Fatalf("corrections after a move: %+v", got)
	}
	c := got.Corrections[0]
	delete(c, "createdAt")
	want := map[string]any{"messageId": "m2", "resolvedText": "the boiler, again", "wrongTopicId": "a", "rightTopicId": "n", "opId": "op-move"}
	if !reflect.DeepEqual(c, want) {
		t.Fatalf("correction %v, want %v", c, want)
	}
	if raw := must(t, h, "GET", "/corrections?limit=1", ""); !strings.Contains(string(raw), "op-move") {
		t.Fatalf("limit 1: %s", raw)
	}

	must(t, h, "POST", "/ops/op-move/undo", ``)
	if raw := must(t, h, "GET", "/corrections", ""); string(raw) != "{\"corrections\":[]}\n" {
		t.Fatalf("corrections after the move was undone: %s", raw)
	}
	for _, q := range []string{"0", "-1", "501", "abc", "1.5"} {
		if status, _ := callRaw(t, h, "GET", "/corrections?limit="+q, ""); status != 400 {
			t.Errorf("limit=%s answered %d, want 400", q, status)
		}
	}
}
