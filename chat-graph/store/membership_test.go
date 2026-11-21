package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"math/rand"
	"os"
	"strconv"
	"testing"
)

type membership struct {
	id                           int64
	message, topic, source, opID string
	confidence                   sql.NullFloat64
	removedAt                    sql.NullInt64
	removedBy                    sql.NullString
}

type liveKey struct{ message, topic string }

type liveVal struct {
	source     string
	confidence sql.NullFloat64
}

func readMemberships(t *testing.T, s *Store) map[int64]membership {
	t.Helper()
	rows, err := s.db.Query(`SELECT id, message_id, topic_id, source, confidence, op_id, removed_at, removed_by FROM memberships`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[int64]membership{}
	for rows.Next() {
		var m membership
		if err := rows.Scan(&m.id, &m.message, &m.topic, &m.source, &m.confidence, &m.opID, &m.removedAt, &m.removedBy); err != nil {
			t.Fatal(err)
		}
		out[m.id] = m
	}
	return out
}

func live(rows map[int64]membership) map[liveKey]liveVal {
	out := map[liveKey]liveVal{}
	for _, m := range rows {
		if !m.removedAt.Valid {
			out[liveKey{m.message, m.topic}] = liveVal{m.source, m.confidence}
		}
	}
	return out
}

// diff returns what b has that a lacks.
func diff(a, b map[liveKey]liveVal) map[liveKey]liveVal {
	out := map[liveKey]liveVal{}
	for k, v := range b {
		if av, ok := a[k]; !ok || av != v {
			out[k] = v
		}
	}
	return out
}

type appliedOp struct {
	id                      string
	kind                    Kind
	before, after           map[liveKey]liveVal
	added, removed          map[liveKey]liveVal
	stateBefore, stateAfter string
	undone                  bool
}

// unwound reports whether the store is exactly what op left once the ops
// applied after it are accounted for: every one of them is undone, and the
// visible state matches the state op left.
func (m *model) unwound(op *appliedOp) bool {
	if op.undone || !kinds[op.kind].undoable {
		return false
	}
	later := false
	for _, h := range m.history {
		if later && !h.undone {
			return false
		}
		later = later || h == op
	}
	return visibleState(m.t, m.s) == op.stateAfter
}

type model struct {
	t       *testing.T
	seed    int64
	rng     *rand.Rand
	s       *Store
	msgs    []string
	nextID  int
	history []*appliedOp
}

func (m *model) fresh(prefix string) string {
	m.nextID++
	return prefix + strconv.Itoa(m.nextID)
}

func (m *model) topicsByStatus() (all, alive []string) {
	rows, err := m.s.db.Query(`SELECT id, status FROM topics ORDER BY id`)
	if err != nil {
		m.t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, st string
		rows.Scan(&id, &st)
		all = append(all, id)
		if st == "live" {
			alive = append(alive, id)
		}
	}
	return all, alive
}

// topic mostly picks a live topic and sometimes any topic, so ops on
// archived, merged and retracted topics get tried too.
func (m *model) topic(all, alive []string) string {
	if len(alive) > 0 && m.rng.Intn(5) > 0 {
		return alive[m.rng.Intn(len(alive))]
	}
	if len(all) == 0 {
		return "none"
	}
	return all[m.rng.Intn(len(all))]
}

func (m *model) conf() *float64 {
	if m.rng.Intn(3) == 0 {
		return nil
	}
	c := float64(m.rng.Intn(101)) / 100
	return &c
}

func (m *model) nextOp(rows map[int64]membership) Op {
	all, alive := m.topicsByStatus()
	edges := make([]membership, 0, len(rows))
	for _, r := range rows {
		if !r.removedAt.Valid {
			edges = append(edges, r)
		}
	}
	slicesSortByID(edges)
	id := m.fresh("op")
	switch n := m.rng.Intn(77); {
	case n < 30 || len(m.msgs) == 0:
		msg := m.fresh("m")
		if err := m.s.AddMessage(Message{ID: msg, Text: "message " + msg, TS: int64(m.nextID), Author: "harry", Kind: KindChat}); err != nil {
			m.t.Fatal(err)
		}
		m.msgs = append(m.msgs, msg)
		op := Op{ID: msg}
		r := Route{MessageID: msg}
		if len(alive) == 0 || m.rng.Intn(3) == 0 {
			nt := NewTopic{ID: m.fresh("t"), Title: "topic"}
			op.NewTopics = []NewTopic{nt}
			r.Topics = append(r.Topics, RouteTopic{TopicID: nt.ID, Confidence: m.conf()})
		}
		if t := m.topic(all, alive); m.rng.Intn(2) == 0 && t != "none" {
			r.Topics = append(r.Topics, RouteTopic{TopicID: t, Confidence: m.conf()})
		}
		if len(r.Topics) == 0 {
			r.Topics = []RouteTopic{{TopicID: m.topic(all, alive)}}
		}
		op.Change = r
		return op
	case n < 42:
		return Op{ID: id, Change: Attach{MessageID: m.msgs[m.rng.Intn(len(m.msgs))], TopicID: m.topic(all, alive), Source: "reply", Confidence: m.conf()}}
	case n < 54 && len(edges) > 0:
		e := edges[m.rng.Intn(len(edges))]
		return Op{ID: id, Change: Move{MessageID: e.message, From: e.topic, To: m.topic(all, alive)}}
	case n < 62:
		return Op{ID: id, Change: Merge{From: m.topic(all, alive), Into: m.topic(all, alive)}}
	case n < 72 && len(edges) > 0:
		from := edges[m.rng.Intn(len(edges))].topic
		var ids []string
		for _, e := range edges {
			if e.topic == from && (len(ids) == 0 || m.rng.Intn(2) == 0) {
				ids = append(ids, e.message)
			}
		}
		return Op{ID: id, Change: Split{TopicID: from, MessageIDs: ids, NewTopic: NewTopic{ID: m.fresh("t"), Title: "split"}}}
	default:
		return Op{ID: id, Change: Archive{TopicID: m.topic(all, alive)}}
	}
}

// opBody renders op as the request body the sidecar receives, so the model's
// ops pass the same parser as real ones.
func opBody(op Op) []byte {
	b, err := json.Marshal(op.Change)
	if err != nil {
		panic(err)
	}
	var body map[string]any
	if err := json.Unmarshal(b, &body); err != nil {
		panic(err)
	}
	body["id"], body["kind"] = op.ID, op.Change.Kind()
	if len(op.NewTopics) > 0 {
		body["newTopics"] = op.NewTopics
	}
	out, err := json.Marshal(body)
	if err != nil {
		panic(err)
	}
	return out
}

func slicesSortByID(ms []membership) {
	for i := 1; i < len(ms); i++ {
		for j := i; j > 0 && ms[j].id < ms[j-1].id; j-- {
			ms[j], ms[j-1] = ms[j-1], ms[j]
		}
	}
}

func (m *model) fail(step int, format string, args ...any) {
	m.t.Helper()
	m.t.Fatalf("seed %d step %d (replay with CHAT_GRAPH_SEED=%d): %s", m.seed, step, m.seed, fmt.Sprintf(format, args...))
}

// checkAppendOnly fails unless every row in before is in after, unchanged
// except for removed_at and removed_by going from NULL to set.
func (m *model) checkAppendOnly(step int, before, after map[int64]membership) {
	m.t.Helper()
	if len(after) < len(before) {
		m.fail(step, "membership rows went from %d to %d", len(before), len(after))
	}
	for id, b := range before {
		a, ok := after[id]
		if !ok {
			m.fail(step, "membership row %d disappeared", id)
		}
		if b.removedAt.Valid {
			if a != b {
				m.fail(step, "removed row %d changed: %+v -> %+v", id, b, a)
			}
			continue
		}
		a.removedAt, a.removedBy = b.removedAt, b.removedBy
		if a != b {
			m.fail(step, "row %d changed a field other than removed_at/removed_by: %+v -> %+v", id, b, after[id])
		}
	}
}

// dump covers the tables ops write; messages_fts follows them by trigger.
func (m *model) dump() string {
	return dumpTables(m.t, m.s, []string{"memberships", "messages", "ops", "topics"})
}

func (m *model) run(steps int) (undos, exact, unwound int) {
	rows := readMemberships(m.t, m.s)
	for step := 0; step < steps; step++ {
		var before map[liveKey]liveVal
		var tables string

		var target *appliedOp
		var mustUndo bool
		var err error
		if len(m.history) > 0 && m.rng.Intn(100) < 23 {
			effective := []*appliedOp{}
			for _, h := range m.history {
				if !h.undone {
					effective = append(effective, h)
				}
			}
			if len(effective) > 0 && m.rng.Intn(2) == 0 {
				target = effective[len(effective)-1]
			} else {
				target = m.history[m.rng.Intn(len(m.history))]
			}
			before, tables = live(rows), m.dump()
			mustUndo = m.unwound(target)
			_, err = m.s.Undo(target.id)
		} else {
			op := m.nextOp(rows)
			rows = readMemberships(m.t, m.s)
			before, tables = live(rows), m.dump()
			stateBefore := visibleState(m.t, m.s)
			op, err = ParseOp(opBody(op))
			if err == nil {
				_, err = m.s.Apply(op)
			}
			if err == nil {
				after := live(readMemberships(m.t, m.s))
				m.history = append(m.history, &appliedOp{id: op.ID, kind: op.Change.Kind(), before: before, after: after,
					added: diff(before, after), removed: diff(after, before),
					stateBefore: stateBefore, stateAfter: visibleState(m.t, m.s)})
			}
		}

		after := readMemberships(m.t, m.s)
		m.checkAppendOnly(step, rows, after)
		switch {
		case mustUndo && err != nil:
			m.fail(step, "undo of %s refused although every later op is undone and the store is what %s left: %v", target.id, target.id, err)
		case err != nil:
			if !errors.Is(err, ErrConflict) && !errors.Is(err, ErrNotFound) && !errors.Is(err, ErrInvalid) {
				m.fail(step, "unexpected error %v", err)
			}
			if got := m.dump(); got != tables {
				m.fail(step, "a refused op or undo wrote to the store: %v", err)
			}
		case target != nil && target.undone:
			if got := m.dump(); got != tables {
				m.fail(step, "undoing %s a second time wrote to the store", target.id)
			}
		case target != nil:
			want := maps.Clone(before)
			for k := range target.added {
				delete(want, k)
			}
			maps.Copy(want, target.removed)
			got := live(after)
			if !maps.Equal(got, want) {
				m.fail(step, "undo %s left live set %v, want %v", target.id, got, want)
			}
			if maps.Equal(before, target.after) {
				if !maps.Equal(got, target.before) {
					m.fail(step, "undo of %s from the state it left gave %v, want the set before it %v", target.id, got, target.before)
				}
				exact++
			}
			if mustUndo {
				if got := visibleState(m.t, m.s); got != target.stateBefore {
					m.fail(step, "unwinding to %s and undoing it left\n%s\nwant\n%s", target.id, got, target.stateBefore)
				}
				unwound++
			}
			target.undone = true
			undos++
		}
		rows = after
	}
	return undos, exact, unwound
}

// Invariant I1: MembershipIsAppendOnly
func TestMembershipIsAppendOnly(t *testing.T) {
	seeds := []int64{}
	for i := int64(1); i <= 12; i++ {
		seeds = append(seeds, i)
	}
	if v := os.Getenv("CHAT_GRAPH_SEED"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			t.Fatal(err)
		}
		seeds = []int64{n}
	}
	var undos, exact, unwound int
	for _, seed := range seeds {
		m := &model{t: t, seed: seed, rng: rand.New(rand.NewSource(seed)), s: openAt(t, dbPath(t), migrations)}
		u, e, w := m.run(150)
		undos, exact, unwound = undos+u, exact+e, unwound+w
		m.s.Close()
	}
	if undos < 10*len(seeds) || exact < 5*len(seeds) || unwound < 3*len(seeds) {
		t.Fatalf("only %d undos succeeded (%d from the state the op left, %d after unwinding later ops) across %d seeds",
			undos, exact, unwound, len(seeds))
	}
	t.Logf("%d successful undos, %d from the state the op left, %d after unwinding later ops, across %d seeds",
		undos, exact, unwound, len(seeds))
}

// Invariant I1: MembershipIsAppendOnly
func TestSchemaRefusesToRewriteAMembership(t *testing.T) {
	s := openAt(t, dbPath(t), migrations)
	defer s.Close()
	seedFixture(t, s)
	for _, stmt := range []string{
		`DELETE FROM memberships`,
		`UPDATE memberships SET topic_id = 'b' WHERE message_id = 'm1'`,
		`UPDATE memberships SET removed_at = NULL`,
	} {
		if _, err := s.db.Exec(stmt); err == nil {
			t.Fatalf("the schema allowed %s", stmt)
		}
	}
	if _, err := s.db.Exec(`UPDATE memberships SET removed_at = 1, removed_by = 'x' WHERE message_id = 'm1'`); err != nil {
		t.Fatalf("setting removed_at once was refused: %v", err)
	}
	if _, err := s.db.Exec(`UPDATE memberships SET removed_at = 2 WHERE message_id = 'm1'`); err == nil {
		t.Fatal("the schema allowed removed_at to be set twice")
	}
}

// Invariant I1: MembershipIsAppendOnly
func TestUndoRestoresAMergeExactly(t *testing.T) {
	s := openAt(t, dbPath(t), migrations)
	defer s.Close()
	seedFixture(t, s)
	before := live(readMemberships(t, s))
	mustApply(t, s, `{"id":"op-merge","kind":"merge","from":"a","into":"b"}`)
	if got, _ := s.Topic("a"); got.Status != "merged" || got.MergedInto != "b" || len(got.MessageIDs) != 0 {
		t.Fatalf("after merge topic a is %+v", got)
	}
	if _, err := s.Undo("op-merge"); err != nil {
		t.Fatal(err)
	}
	if got := live(readMemberships(t, s)); !maps.Equal(got, before) {
		t.Fatalf("after undo the live memberships are %v, want %v", got, before)
	}
	if got, _ := s.Topic("a"); got.Status != "live" || got.MergedInto != "" {
		t.Fatalf("after undo topic a is %+v", got)
	}
	if _, err := s.Undo("m1"); !errors.Is(err, ErrConflict) {
		t.Fatalf("undoing a route op answered %v, want ErrConflict", err)
	}
}
