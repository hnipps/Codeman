package store

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"reflect"
	"testing"
)

func seedFixture(t *testing.T, s *Store) {
	t.Helper()
	for _, id := range []string{"m1", "m2", "m3", "m4"} {
		addMsg(t, s, id)
	}
	mustApply(t, s, `{"id":"m1","kind":"route","messageId":"m1","topics":[{"topicId":"a","confidence":0.9}],"newTopics":[{"id":"a","title":"Budget"}]}`)
	mustApply(t, s, `{"id":"m2","kind":"route","messageId":"m2","topics":[{"topicId":"a"},{"topicId":"b","confidence":0.4}],"newTopics":[{"id":"b","title":"Travel"}]}`)
	mustApply(t, s, `{"id":"m3","kind":"route","messageId":"m3","topics":[{"topicId":"a","confidence":0.7}]}`)
}

var everyKind = []struct{ kind, body, other string }{
	{"route",
		`{"id":"m4","kind":"route","messageId":"m4","topics":[{"topicId":"b","confidence":0.8}]}`,
		`{"id":"m4","kind":"route","messageId":"m4","topics":[{"topicId":"a","confidence":0.8}]}`},
	{"route with signal",
		`{"id":"m4","kind":"route","messageId":"m4","topics":[{"topicId":"b"}],"source":"reply","resolvedText":"the train to leeds","reactivate":"a"}`,
		`{"id":"m4","kind":"route","messageId":"m4","topics":[{"topicId":"b"}],"source":"quote","resolvedText":"the train to leeds","reactivate":"a"}`},
	{"attach",
		`{"id":"op-attach","kind":"attach","messageId":"m1","topicId":"b","source":"reply","confidence":0.5}`,
		`{"id":"op-attach","kind":"attach","messageId":"m3","topicId":"b","source":"reply"}`},
	{"move",
		`{"id":"op-move","kind":"move","messageId":"m1","from":"a","to":"b"}`,
		`{"id":"op-move","kind":"move","messageId":"m3","from":"a","to":"b"}`},
	{"merge",
		`{"id":"op-merge","kind":"merge","from":"a","into":"b"}`,
		`{"id":"op-merge","kind":"merge","from":"b","into":"a"}`},
	{"split",
		`{"id":"op-split","kind":"split","topicId":"a","messageIds":["m1","m3"],"newTopic":{"id":"c","title":"Budget, Q3"}}`,
		`{"id":"op-split","kind":"split","topicId":"a","messageIds":["m1"],"newTopic":{"id":"c","title":"Budget, Q3"}}`},
	{"archive",
		`{"id":"op-archive","kind":"archive","topicId":"b"}`,
		`{"id":"op-archive","kind":"archive","topicId":"a"}`},
}

func fileBytes(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// Invariant I5: OpsAreIdempotent
func TestEveryOpKindAppliedTwiceChangesNothing(t *testing.T) {
	for _, k := range everyKind {
		t.Run(k.kind, func(t *testing.T) {
			path := dbPath(t)
			s := openAt(t, path, migrations)
			seedFixture(t, s)
			first := mustApply(t, s, k.body)
			if len(first.Added)+len(first.Removed) == 0 && k.kind != "archive" {
				t.Fatalf("%s op changed no membership: %+v", k.kind, first)
			}
			tables := dump(t, s)
			s.Close()
			before := fileBytes(t, path)

			s = openAt(t, path, migrations)
			again := mustApply(t, s, k.body)
			if !reflect.DeepEqual(first, again) {
				t.Fatalf("replay answered %+v, first apply %+v", again, first)
			}
			if got := dump(t, s); got != tables {
				t.Fatalf("tables changed on replay:\n%s\nwant:\n%s", got, tables)
			}
			if _, err := s.Apply(mustParse(t, k.other)); !errors.Is(err, ErrConflict) {
				t.Fatalf("a different request under op id answered %v, want ErrConflict", err)
			}
			s.Close()
			if !bytes.Equal(before, fileBytes(t, path)) {
				t.Fatal("graph.sqlite bytes changed after the replay")
			}
		})
	}
}

// Invariant I5: OpsAreIdempotent
func TestMessageStoredTwiceChangesNothing(t *testing.T) {
	path := dbPath(t)
	s := openAt(t, path, migrations)
	m := Message{ID: "m1", Text: "book the train", TS: 5, Author: "harry", Kind: KindChat}
	if err := s.AddMessage(m); err != nil {
		t.Fatal(err)
	}
	s.Close()
	before := fileBytes(t, path)

	s = openAt(t, path, migrations)
	if err := s.AddMessage(m); err != nil {
		t.Fatalf("same message again: %v", err)
	}
	changed := m
	changed.Text = "book the plane"
	if err := s.AddMessage(changed); !errors.Is(err, ErrConflict) {
		t.Fatalf("different body under a stored id answered %v, want ErrConflict", err)
	}
	s.Close()
	if !bytes.Equal(before, fileBytes(t, path)) {
		t.Fatal("graph.sqlite bytes changed after storing the same message again")
	}
}

func TestRouteOpIDMustBeTheMessageID(t *testing.T) {
	_, err := ParseOp([]byte(`{"id":"other","kind":"route","messageId":"m1","topics":[{"topicId":"a"}]}`))
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("got %v, want ErrInvalid", err)
	}
}

const crashDirEnv = "CHAT_GRAPH_CRASH_DIR"

// Invariant I5: OpsAreIdempotent
func TestCrashBetweenOpRowAndMemberships(t *testing.T) {
	const op = `{"id":"op-attach","kind":"attach","messageId":"m1","topicId":"b","source":"reply"}`
	if dir := os.Getenv(crashDirEnv); dir != "" {
		s, err := Open(dir+"/graph.sqlite", (&clock{n: 5000}).now)
		if err != nil {
			os.Exit(2)
		}
		afterOpRow = func() { os.Exit(7) }
		s.Apply(mustParse(t, op))
		os.Exit(3)
	}

	dir := t.TempDir()
	path := dir + "/graph.sqlite"
	s := openAt(t, path, migrations)
	seedFixture(t, s)
	s.Close()

	cmd := exec.Command(os.Args[0], "-test.run=^TestCrashBetweenOpRowAndMemberships$")
	cmd.Env = append(os.Environ(), crashDirEnv+"="+dir)
	err := cmd.Run()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 7 {
		t.Fatalf("child did not die at the hook: %v", err)
	}

	s, err = Open(path, (&clock{n: 9000}).now)
	if err != nil {
		t.Fatalf("the store left by the crash did not open: %v", err)
	}
	defer s.Close()
	var check string
	if err := s.db.QueryRow(`PRAGMA integrity_check`).Scan(&check); err != nil || check != "ok" {
		t.Fatalf("integrity_check: %q %v", check, err)
	}
	var ops, edges int
	s.db.QueryRow(`SELECT count(*) FROM ops WHERE id = 'op-attach'`).Scan(&ops)
	s.db.QueryRow(`SELECT count(*) FROM memberships WHERE op_id = 'op-attach'`).Scan(&edges)
	if ops != 0 || edges != 0 {
		t.Fatalf("half an op survived the crash: %d op rows, %d membership rows", ops, edges)
	}
	res := mustApply(t, s, op)
	if !reflect.DeepEqual(res.Added, []Edge{{MessageID: "m1", TopicID: "b"}}) {
		t.Fatalf("the op did not apply after the crash: %+v", res)
	}
}
