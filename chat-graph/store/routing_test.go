package store

import (
	"fmt"
	"reflect"
	"slices"
	"testing"

	"codeman/chat-graph/route"
)

func addText(t *testing.T, s *Store, id, text string) {
	t.Helper()
	if err := s.AddMessage(Message{ID: id, Text: text, TS: 1, Author: "harry", Kind: KindChat}); err != nil {
		t.Fatal(err)
	}
}

func hitTopics(t *testing.T, s *Store, query string) []string {
	t.Helper()
	hits, err := s.Retrieve(query, 10)
	if err != nil {
		t.Fatalf("Retrieve(%q): %v", query, err)
	}
	var ids []string
	for _, h := range hits {
		if h.Relevance <= 0 {
			t.Fatalf("Retrieve(%q) hit %+v has no relevance", query, h)
		}
		ids = append(ids, h.TopicID)
	}
	slices.Sort(ids)
	return ids
}

func TestRetrieve(t *testing.T) {
	s := openAt(t, dbPath(t), migrations)
	addText(t, s, "m1", "replace the boiler valve")
	addText(t, s, "m2", "boiler service invoice")
	addText(t, s, "m3", "boiler pressure keeps dropping")
	addText(t, s, "m4", "boiler on a retracted topic")
	addText(t, s, "m5", "boiler filed then unfiled")
	addText(t, s, "m6", "roses need pruning")
	mustApply(t, s, `{"id":"m1","kind":"route","messageId":"m1","topics":[{"topicId":"a"}],"newTopics":[{"id":"a","title":"Plumbing"}]}`)
	mustApply(t, s, `{"id":"m2","kind":"route","messageId":"m2","topics":[{"topicId":"old"}],"newTopics":[{"id":"old","title":"Old house"}]}`)
	mustApply(t, s, `{"id":"op-archive","kind":"archive","topicId":"old"}`)
	mustApply(t, s, `{"id":"m3","kind":"route","messageId":"m3","topics":[{"topicId":"c"}],"newTopics":[{"id":"c","title":"Heating"}]}`)
	mustApply(t, s, `{"id":"op-merge","kind":"merge","from":"c","into":"a"}`)
	mustApply(t, s, `{"id":"op-r","kind":"attach","messageId":"m4","topicId":"r","source":"reply","newTopics":[{"id":"r","title":"Retracted boiler"}]}`)
	mustApply(t, s, `{"id":"m6","kind":"route","messageId":"m6","topics":[{"topicId":"g"}],"newTopics":[{"id":"g","title":"Garden"}]}`)
	mustApply(t, s, `{"id":"op-g","kind":"attach","messageId":"m5","topicId":"g","source":"reply"}`)
	for _, id := range []string{"op-r", "op-g"} {
		if _, err := s.Undo(id); err != nil {
			t.Fatal(err)
		}
	}

	cases := []struct {
		query string
		want  []string
	}{
		// a by its own message and m3 merged in, old while archived; r is
		// retracted and m5 is in no topic, so neither counts.
		{"boiler", []string{"a", "old"}},
		{"plumbing", []string{"a"}},
		{"heating", []string{"a"}},
		{"invoice", []string{"old"}},
		{"BOILER, Valve!", []string{"a", "old"}},
		{"nothing matches this", nil},
		{"", nil},
		{`"`, nil},
		{`boiler*`, []string{"a", "old"}},
		{`NEAR(boiler valve)`, []string{"a", "old"}},
		{`boiler AND valve`, []string{"a", "old"}},
		{`^boiler`, []string{"a", "old"}},
		{`body:boiler`, []string{"a", "old"}},
		{`kind:topic`, nil},
		{`")( OR NOT -`, nil},
	}
	for _, c := range cases {
		if got := hitTopics(t, s, c.query); !reflect.DeepEqual(got, c.want) {
			t.Errorf("Retrieve(%q) topics %v, want %v", c.query, got, c.want)
		}
	}

	hits, err := s.Retrieve("boiler valve", 1)
	if err != nil || len(hits) != 1 || hits[0].TopicID != "a" {
		t.Fatalf("Retrieve limit 1: %+v %v, want the best match a", hits, err)
	}
}

func TestTouchesKeepTheNewest50(t *testing.T) {
	s := openAt(t, dbPath(t), migrations)
	addMsg(t, s, "m0")
	mustApply(t, s, `{"id":"m0","kind":"route","messageId":"m0","topics":[{"topicId":"a"}],"newTopics":[{"id":"a","title":"Budget"},{"id":"b","title":"Travel"}]}`)
	infos, err := s.TopicInfos([]string{"b", "nope"})
	if err != nil || len(infos) != 1 || infos["b"].Touches != nil || infos["b"].Status != route.StatusLive {
		t.Fatalf("TopicInfos of an untouched topic and a missing one: %+v %v", infos, err)
	}

	var times []int64
	for i := 1; i < 60; i++ {
		id := fmt.Sprintf("m%d", i)
		addMsg(t, s, id)
		res := mustApply(t, s, fmt.Sprintf(`{"id":"op%d","kind":"attach","messageId":%q,"topicId":"a","source":"reply"}`, i, id))
		times = append(times, res.CreatedAt)
	}
	infos, err = s.TopicInfos([]string{"a"})
	if err != nil {
		t.Fatal(err)
	}
	got := infos["a"].Touches
	want := slices.Clone(times[len(times)-route.MaxTouches:])
	slices.Reverse(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("touches %v, want the newest %d attach times %v", got, route.MaxTouches, want)
	}
	var stored int
	s.db.QueryRow(`SELECT count(*) FROM touches WHERE topic_id = 'a'`).Scan(&stored)
	if stored != route.MaxTouches {
		t.Fatalf("%d touch rows stored for a, want %d", stored, route.MaxTouches)
	}

	mustApply(t, s, `{"id":"op-move","kind":"move","messageId":"m1","from":"a","to":"b"}`)
	countB := func() (n int) {
		s.db.QueryRow(`SELECT count(*) FROM touches WHERE topic_id = 'b'`).Scan(&n)
		return n
	}
	if n := countB(); n != 1 {
		t.Fatalf("a move into b wrote %d touches, want 1", n)
	}
	if _, err := s.Undo("op-move"); err != nil {
		t.Fatal(err)
	}
	if n := countB(); n != 1 {
		t.Fatalf("undoing the move left %d touches on b, want 1", n)
	}
	infos, _ = s.TopicInfos([]string{"a"})
	if !reflect.DeepEqual(infos["a"].Touches, want) {
		t.Fatalf("undo restoring m1 into a wrote a touch: %v", infos["a"].Touches)
	}
}

func TestPlainRouteRequestBytesUnchanged(t *testing.T) {
	op := mustParse(t, `{"id":"m1","kind":"route","messageId":"m1","topics":[{"topicId":"a","confidence":0.9},{"topicId":"b"}],"newTopics":[{"id":"a","title":"Budget"}]}`)
	got, err := canonicalRequest(op)
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"id":"m1","kind":"route","newTopics":[{"id":"a","title":"Budget"}],"args":{"messageId":"m1","topics":[{"topicId":"a","confidence":0.9},{"topicId":"b"}]}}`
	if string(got) != want {
		t.Fatalf("canonical request\n%s\nwant\n%s", got, want)
	}
}

func TestRouteWithSignal(t *testing.T) {
	s := openAt(t, dbPath(t), migrations)
	seedFixture(t, s)
	if _, _, _, ok, err := s.StoredRoute("m4"); ok || err != nil {
		t.Fatalf("StoredRoute of an unrouted message: %v %v", ok, err)
	}
	if _, _, _, _, err := s.StoredRoute("nope"); err != nil {
		t.Fatalf("StoredRoute of an unknown id: %v", err)
	}

	body := `{"id":"m4","kind":"route","messageId":"m4","topics":[{"topicId":"n"}],"newTopics":[{"id":"n","title":"Leeds"}],"source":"reply","resolvedText":"the train to leeds","reactivate":"a"}`
	first := mustApply(t, s, body)
	rows := live(readMemberships(t, s))
	if v := rows[liveKey{"m4", "n"}]; v.source != "reply" || v.confidence.Valid {
		t.Fatalf("explicit route edge %+v, want source reply and no confidence", v)
	}
	if v := rows[liveKey{"m1", "a"}]; v.source != "route" {
		t.Fatalf("plain route edge source %q, want route", v.source)
	}
	var resolved string
	s.db.QueryRow(`SELECT resolved_text FROM messages WHERE id = 'm4'`).Scan(&resolved)
	if resolved != "the train to leeds" {
		t.Fatalf("resolved_text %q", resolved)
	}

	r, nts, res, ok, err := s.StoredRoute("m4")
	if err != nil || !ok {
		t.Fatalf("StoredRoute: %v %v", ok, err)
	}
	want := Route{MessageID: "m4", Topics: []RouteTopic{{TopicID: "n"}}, Source: "reply", ResolvedText: "the train to leeds", Reactivate: "a"}
	if !reflect.DeepEqual(r, want) || !reflect.DeepEqual(nts, []NewTopic{{ID: "n", Title: "Leeds"}}) || !reflect.DeepEqual(res, first) {
		t.Fatalf("StoredRoute = %+v %+v %+v, want %+v and the apply result %+v", r, nts, res, want, first)
	}

	if _, _, _, _, err := s.StoredRoute("m4"); err != nil {
		t.Fatal(err)
	}
	mustApply(t, s, `{"id":"op-x","kind":"archive","topicId":"b"}`)
	if _, _, _, _, err := s.StoredRoute("op-x"); err == nil {
		t.Fatal("StoredRoute of a non-route op answered no error")
	}
	if _, err := ParseOp([]byte(`{"id":"m9","kind":"route","messageId":"m9","topics":[{"topicId":"a"}],"source":"telepathy"}`)); err == nil {
		t.Fatal("an unknown route source parsed")
	}
}

func TestCorrectionsRecordMovesThatStand(t *testing.T) {
	s := openAt(t, dbPath(t), migrations)
	seedFixture(t, s)
	mustApply(t, s, `{"id":"m4","kind":"route","messageId":"m4","topics":[{"topicId":"a"}],"resolvedText":"resolved m4"}`)
	first := mustApply(t, s, `{"id":"op-move1","kind":"move","messageId":"m1","from":"a","to":"b"}`)
	second := mustApply(t, s, `{"id":"op-move2","kind":"move","messageId":"m4","from":"a","to":"b"}`)

	got, err := s.Corrections(50)
	if err != nil {
		t.Fatal(err)
	}
	want := []Correction{
		{MessageID: "m4", ResolvedText: "resolved m4", WrongTopicID: "a", RightTopicID: "b", OpID: "op-move2", CreatedAt: second.CreatedAt},
		{MessageID: "m1", ResolvedText: "text of m1", WrongTopicID: "a", RightTopicID: "b", OpID: "op-move1", CreatedAt: first.CreatedAt},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("corrections %+v, want %+v", got, want)
	}
	if got, _ := s.Corrections(1); !reflect.DeepEqual(got, want[:1]) {
		t.Fatalf("corrections limit 1: %+v", got)
	}

	if _, err := s.Undo("op-move2"); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Corrections(50); !reflect.DeepEqual(got, want[1:]) {
		t.Fatalf("corrections after undoing op-move2: %+v, want %+v", got, want[1:])
	}

	mustApply(t, s, `{"id":"op-move3","kind":"move","messageId":"m1","from":"b","to":"a"}`)
	addMsg(t, s, "m5")
	mustApply(t, s, `{"id":"m5","kind":"route","messageId":"m5","topics":[{"topicId":"a"}],"source":"reply"}`)
	mustApply(t, s, `{"id":"op-move4","kind":"move","messageId":"m5","from":"a","to":"b"}`)
	if got, _ := s.Corrections(50); !reflect.DeepEqual(got, want[1:]) {
		t.Fatalf("moves of a person's or a signal's edge logged a correction: %+v", got)
	}
}
