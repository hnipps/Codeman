package store

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"testing"
)

// visibleState renders what a reader of the store can see: every topic that
// is not retracted with its status, and every live membership with its
// source and confidence.
func visibleState(t *testing.T, s *Store) string {
	t.Helper()
	var lines []string
	rows, err := s.db.Query(`SELECT id, status, coalesce(merged_into, '') FROM topics WHERE status != 'retracted'`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id, st, into string
		if err := rows.Scan(&id, &st, &into); err != nil {
			t.Fatal(err)
		}
		lines = append(lines, fmt.Sprintf("topic %s %s %s", id, st, into))
	}
	rows.Close()
	for k, v := range live(readMemberships(t, s)) {
		lines = append(lines, fmt.Sprintf("edge %s %s %s %v", k.message, k.topic, v.source, v.confidence))
	}
	sort.Strings(lines)
	return strings.Join(lines, "\n")
}

// applyAll applies bodies in order and returns the visible state before each
// op and after the last.
func applyAll(t *testing.T, s *Store, bodies ...string) []string {
	t.Helper()
	states := []string{visibleState(t, s)}
	for _, b := range bodies {
		mustApply(t, s, b)
		states = append(states, visibleState(t, s))
	}
	return states
}

// undoLIFO undoes ids from last to first and checks each undo brings back
// the state before that op.
func undoLIFO(t *testing.T, s *Store, ids []string, states []string) {
	t.Helper()
	for i := len(ids) - 1; i >= 0; i-- {
		if _, err := s.Undo(ids[i]); err != nil {
			t.Fatalf("undo %s: %v", ids[i], err)
		}
		if got := visibleState(t, s); got != states[i] {
			t.Fatalf("after undo %s the store is\n%s\nwant\n%s", ids[i], got, states[i])
		}
	}
}

// Invariant I1: MembershipIsAppendOnly
func TestUndoFollowsUndoneLaterMoves(t *testing.T) {
	s := openAt(t, dbPath(t), migrations)
	defer s.Close()
	seedFixture(t, s)
	states := applyAll(t, s,
		`{"id":"mv1","kind":"move","messageId":"m1","from":"a","to":"b"}`,
		`{"id":"mv2","kind":"move","messageId":"m1","from":"b","to":"c","newTopics":[{"id":"c","title":"C"}]}`,
		`{"id":"mv3","kind":"move","messageId":"m1","from":"c","to":"d","newTopics":[{"id":"d","title":"D"}]}`,
	)
	undoLIFO(t, s, []string{"mv1", "mv2", "mv3"}, states)
}

// Invariant I1: MembershipIsAppendOnly
func TestUndoFollowsUndoneLaterMerges(t *testing.T) {
	s := openAt(t, dbPath(t), migrations)
	defer s.Close()
	seedFixture(t, s)
	states := applyAll(t, s,
		`{"id":"mg1","kind":"merge","from":"a","into":"b"}`,
		`{"id":"mg2","kind":"merge","from":"b","into":"c","newTopics":[{"id":"c","title":"C"}]}`,
	)
	undoLIFO(t, s, []string{"mg1", "mg2"}, states)
}

// assertUndoRefused checks Undo(id) answers ErrConflict and writes nothing.
func assertUndoRefused(t *testing.T, s *Store, id string) {
	t.Helper()
	before := dump(t, s)
	if _, err := s.Undo(id); !errors.Is(err, ErrConflict) {
		t.Fatalf("undo %s answered %v, want ErrConflict", id, err)
	}
	if got := dump(t, s); got != before {
		t.Fatalf("a refused undo of %s wrote to the store", id)
	}
}

// Invariant I1: MembershipIsAppendOnly
func TestUndoRefusesWhenALaterOpStillStands(t *testing.T) {
	s := openAt(t, dbPath(t), migrations)
	defer s.Close()
	seedFixture(t, s)
	mustApply(t, s, `{"id":"mv1","kind":"move","messageId":"m1","from":"a","to":"b"}`)
	mustApply(t, s, `{"id":"mv2","kind":"move","messageId":"m1","from":"b","to":"c","newTopics":[{"id":"c","title":"C"}]}`)
	mustApply(t, s, `{"id":"mv3","kind":"move","messageId":"m1","from":"c","to":"b"}`)
	assertUndoRefused(t, s, "mv1")
}

func TestUndoRefusesWhenACreatedTopicChanged(t *testing.T) {
	s := openAt(t, dbPath(t), migrations)
	defer s.Close()
	seedFixture(t, s)
	mustApply(t, s, `{"id":"op-split","kind":"split","topicId":"a","messageIds":["m1","m3"],"newTopic":{"id":"c","title":"Budget, Q3"}}`)
	mustApply(t, s, `{"id":"op-archive","kind":"archive","topicId":"c"}`)
	assertUndoRefused(t, s, "op-split")
}

func TestUndoRefusesToRetractATopicWithLaterMessages(t *testing.T) {
	s := openAt(t, dbPath(t), migrations)
	defer s.Close()
	seedFixture(t, s)
	mustApply(t, s, `{"id":"op-split","kind":"split","topicId":"a","messageIds":["m1","m3"],"newTopic":{"id":"c","title":"Budget, Q3"}}`)
	mustApply(t, s, `{"id":"m4","kind":"route","messageId":"m4","topics":[{"topicId":"c"}]}`)
	assertUndoRefused(t, s, "op-split")
}

// Undo restores history exactly, so a membership goes back to its topic even
// when that topic has been archived since.
func TestUndoRestoresIntoAnArchivedTopic(t *testing.T) {
	s := openAt(t, dbPath(t), migrations)
	defer s.Close()
	seedFixture(t, s)
	mustApply(t, s, `{"id":"mv1","kind":"move","messageId":"m1","from":"a","to":"b"}`)
	mustApply(t, s, `{"id":"op-archive","kind":"archive","topicId":"a"}`)
	if _, err := s.Undo("mv1"); err != nil {
		t.Fatal(err)
	}
	a, err := s.Topic("a")
	if err != nil {
		t.Fatal(err)
	}
	if a.Status != "archived" || strings.Join(a.MessageIDs, ",") != "m1,m2,m3" {
		t.Fatalf("after undo topic a is %+v, want archived with m1,m2,m3", a)
	}
}
