package store

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
)

type Kind string

const (
	KindRoute   Kind = "route"
	KindAttach  Kind = "attach"
	KindMove    Kind = "move"
	KindMerge   Kind = "merge"
	KindSplit   Kind = "split"
	KindArchive Kind = "archive"
)

// Op is one lifecycle op. Its id is the idempotency key (invariant I5).
type Op struct {
	ID        string
	NewTopics []NewTopic
	Change    Change
}

type NewTopic struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// Change is one kind's arguments. apply runs inside the op's transaction
// and records every topic and membership it changes through opTx, which is
// what lets one generic Undo reverse any undoable kind.
type Change interface {
	Kind() Kind
	validate(opID string) error
	apply(t *opTx) error
}

var kinds = map[Kind]struct {
	parse func(raw []byte) (Change, error)
	// A route op files a message for the first time; undoing it would leave
	// the message on no topic (invariant I2), so it is fixed by a move instead.
	undoable bool
}{
	KindRoute:   {decode[Route], false},
	KindAttach:  {decode[Attach], true},
	KindMove:    {decode[Move], true},
	KindMerge:   {decode[Merge], true},
	KindSplit:   {decode[Split], true},
	KindArchive: {decode[Archive], true},
}

// Route's optional fields are omitempty so a plain route op's canonical
// request, and so its replay check, is unchanged from before they existed.
type Route struct {
	MessageID string       `json:"messageId"`
	Topics    []RouteTopic `json:"topics"`
	// Source is "" for the router, else the explicit signal: reply, quote or chip.
	Source       string `json:"source,omitempty"`
	ResolvedText string `json:"resolvedText,omitempty"`
	// Reactivate is the archived topic the new topic's chip offers back.
	// It is recorded in the request only, so a replay can describe it.
	Reactivate string `json:"reactivate,omitempty"`
}

var routeSources = map[string]bool{"": true, "reply": true, "quote": true, "chip": true}

type RouteTopic struct {
	TopicID    string   `json:"topicId"`
	Confidence *float64 `json:"confidence,omitempty"`
}

type Attach struct {
	MessageID  string   `json:"messageId"`
	TopicID    string   `json:"topicId"`
	Source     string   `json:"source"`
	Confidence *float64 `json:"confidence,omitempty"`
}

type Move struct {
	MessageID string `json:"messageId"`
	From      string `json:"from"`
	To        string `json:"to"`
}

type Merge struct {
	From string `json:"from"`
	Into string `json:"into"`
}

type Split struct {
	TopicID    string   `json:"topicId"`
	MessageIDs []string `json:"messageIds"`
	NewTopic   NewTopic `json:"newTopic"`
}

type Archive struct {
	TopicID string `json:"topicId"`
}

func (Route) Kind() Kind   { return KindRoute }
func (Attach) Kind() Kind  { return KindAttach }
func (Move) Kind() Kind    { return KindMove }
func (Merge) Kind() Kind   { return KindMerge }
func (Split) Kind() Kind   { return KindSplit }
func (Archive) Kind() Kind { return KindArchive }

// ParseOp reads an op from a request body: {"id", "kind", "newTopics"?,
// plus the kind's own fields}.
func ParseOp(raw []byte) (Op, error) {
	var env struct {
		ID        string     `json:"id"`
		Kind      Kind       `json:"kind"`
		NewTopics []NewTopic `json:"newTopics"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return Op{}, invalid("op body is not a JSON op")
	}
	k, ok := kinds[env.Kind]
	if !ok {
		return Op{}, invalid("op kind %q", env.Kind)
	}
	change, err := k.parse(raw)
	if err != nil {
		return Op{}, err
	}
	return NewOp(env.ID, env.NewTopics, change)
}

// NewOp checks an op built in code exactly as ParseOp checks one from a body.
func NewOp(id string, newTopics []NewTopic, change Change) (Op, error) {
	if !validID(id) {
		return Op{}, invalid("op id %q", id)
	}
	seen := map[string]bool{}
	for _, nt := range newTopics {
		if err := nt.validate(); err != nil {
			return Op{}, err
		}
		if seen[nt.ID] {
			return Op{}, invalid("new topic %s listed twice", nt.ID)
		}
		seen[nt.ID] = true
	}
	if err := change.validate(id); err != nil {
		return Op{}, err
	}
	return Op{ID: id, NewTopics: newTopics, Change: change}, nil
}

func decode[C Change](raw []byte) (Change, error) {
	var c C
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, invalid("%s op fields", c.Kind())
	}
	return c, nil
}

func (nt NewTopic) validate() error {
	if !validID(nt.ID) {
		return invalid("new topic id %q", nt.ID)
	}
	if nt.Title == "" {
		return invalid("new topic %s has no title", nt.ID)
	}
	return nil
}

func validConfidence(c *float64) bool { return c == nil || (*c >= 0 && *c <= 1) }

func (r Route) validate(opID string) error {
	if r.MessageID != opID {
		return invalid("a route op's id must be its message id")
	}
	if len(r.Topics) == 0 {
		return invalid("route op %s names no topic", opID)
	}
	if !routeSources[r.Source] {
		return invalid("route op %s source %q", opID, r.Source)
	}
	if r.Reactivate != "" && !validID(r.Reactivate) {
		return invalid("route op %s reactivate %q", opID, r.Reactivate)
	}
	seen := map[string]bool{}
	for _, rt := range r.Topics {
		if !validID(rt.TopicID) || seen[rt.TopicID] || !validConfidence(rt.Confidence) {
			return invalid("route op %s topic %q", opID, rt.TopicID)
		}
		seen[rt.TopicID] = true
	}
	return nil
}

func (a Attach) validate(string) error {
	if !validID(a.MessageID) || !validID(a.TopicID) || a.Source == "" || !validConfidence(a.Confidence) {
		return invalid("attach needs messageId, topicId, source and a confidence in [0, 1] if any")
	}
	return nil
}

func (m Move) validate(string) error {
	if !validID(m.MessageID) || !validID(m.From) || !validID(m.To) || m.From == m.To {
		return invalid("move needs messageId and two different topics")
	}
	return nil
}

func (m Merge) validate(string) error {
	if !validID(m.From) || !validID(m.Into) || m.From == m.Into {
		return invalid("merge needs two different topics")
	}
	return nil
}

func (s Split) validate(string) error {
	if !validID(s.TopicID) || len(s.MessageIDs) == 0 {
		return invalid("split needs topicId and messageIds")
	}
	if err := s.NewTopic.validate(); err != nil {
		return err
	}
	if s.NewTopic.ID == s.TopicID {
		return invalid("split's new topic must differ from %s", s.TopicID)
	}
	seen := map[string]bool{}
	for _, id := range s.MessageIDs {
		if !validID(id) || seen[id] {
			return invalid("split message %q", id)
		}
		seen[id] = true
	}
	return nil
}

func (a Archive) validate(string) error {
	if !validID(a.TopicID) {
		return invalid("archive needs topicId")
	}
	return nil
}

func (r Route) apply(t *opTx) error {
	source := r.Source
	if source == "" {
		source = "route"
	}
	for _, rt := range r.Topics {
		if err := t.addEdge(r.MessageID, rt.TopicID, source, rt.Confidence); err != nil {
			return err
		}
	}
	if r.ResolvedText == "" {
		return nil
	}
	_, err := t.tx.Exec(`UPDATE messages SET resolved_text = ? WHERE id = ? AND resolved_text IS NULL`, r.ResolvedText, r.MessageID)
	return err
}

func (a Attach) apply(t *opTx) error {
	return t.addEdge(a.MessageID, a.TopicID, a.Source, a.Confidence)
}

// A move is a person overriding where a message was filed, so the new edge
// is the person's ("move") and carries no router confidence, and the
// correction log records what the router got wrong.
func (m Move) apply(t *opTx) error {
	e, ok, err := t.liveEdge(m.MessageID, m.From)
	if err != nil {
		return err
	}
	if !ok {
		return conflict("message %s is not in topic %s", m.MessageID, m.From)
	}
	if err := t.removeEdge(e); err != nil {
		return err
	}
	if err := t.addEdge(m.MessageID, m.To, "move", nil); err != nil {
		return err
	}
	_, err = t.tx.Exec(`INSERT INTO corrections (message_id, resolved_text, wrong_topic_id, right_topic_id, op_id, created_at)
		SELECT id, coalesce(resolved_text, text), ?, ?, ?, ? FROM messages WHERE id = ?`,
		m.From, m.To, t.opID, t.now, m.MessageID)
	return err
}

// Merge and split relocate memberships as they are, source and confidence included.
func (m Merge) apply(t *opTx) error {
	if err := t.requireLive(m.From); err != nil {
		return err
	}
	if err := t.requireLive(m.Into); err != nil {
		return err
	}
	edges, err := t.liveEdges(m.From)
	if err != nil {
		return err
	}
	for _, e := range edges {
		if err := t.removeEdge(e); err != nil {
			return err
		}
		_, there, err := t.liveEdge(e.MessageID, m.Into)
		if err != nil {
			return err
		}
		if !there {
			if err := t.addEdge(e.MessageID, m.Into, e.Source, e.Confidence); err != nil {
				return err
			}
		}
	}
	return t.setStatus(m.From, topicState{Status: "merged", MergedInto: m.Into})
}

func (s Split) apply(t *opTx) error {
	if err := t.requireLive(s.TopicID); err != nil {
		return err
	}
	if err := t.createTopic(s.NewTopic); err != nil {
		return err
	}
	for _, id := range s.MessageIDs {
		e, ok, err := t.liveEdge(id, s.TopicID)
		if err != nil {
			return err
		}
		if !ok {
			return conflict("message %s is not in topic %s", id, s.TopicID)
		}
		if err := t.removeEdge(e); err != nil {
			return err
		}
		if err := t.addEdge(id, s.NewTopic.ID, e.Source, e.Confidence); err != nil {
			return err
		}
	}
	return nil
}

func (a Archive) apply(t *opTx) error {
	if err := t.requireLive(a.TopicID); err != nil {
		return err
	}
	return t.setStatus(a.TopicID, topicState{Status: "archived"})
}

// Edge is one membership as an op result reports it.
type Edge struct {
	MessageID string `json:"messageId"`
	TopicID   string `json:"topicId"`
}

// OpResult is an op as stored. It is read back from the rows the op wrote,
// so a replay of the op returns the same answer as the first apply.
type OpResult struct {
	ID        string `json:"id"`
	Kind      Kind   `json:"kind"`
	CreatedAt int64  `json:"createdAt"`
	UndoneAt  *int64 `json:"undoneAt,omitempty"`
	Added     []Edge `json:"added"`
	Removed   []Edge `json:"removed"`
}

type topicState struct {
	Status     string `json:"status"`
	MergedInto string `json:"mergedInto,omitempty"`
}

// topicChange is one topic an op changed. Before is nil for a topic the op created.
type topicChange struct {
	ID     string      `json:"id"`
	Before *topicState `json:"before"`
	After  topicState  `json:"after"`
}

// opPayload is ops.payload: the request, for the replay check, and the
// topic states the op changed, for an exact undo.
type opPayload struct {
	Request json.RawMessage `json:"request"`
	Topics  []topicChange   `json:"topics"`
}

func canonicalRequest(op Op) ([]byte, error) {
	return json.Marshal(struct {
		ID        string     `json:"id"`
		Kind      Kind       `json:"kind"`
		NewTopics []NewTopic `json:"newTopics,omitempty"`
		Args      Change     `json:"args"`
	}{op.ID, op.Change.Kind(), op.NewTopics, op.Change})
}

// afterOpRow lets the crash test kill the process between the op row and the
// rows the op writes.
var afterOpRow func()

// Apply runs op in one transaction. Applying an op id again with the same
// request writes nothing and returns the stored result; a different request
// under that id is ErrConflict (invariant I5).
func (s *Store) Apply(op Op) (OpResult, error) {
	req, err := canonicalRequest(op)
	if err != nil {
		return OpResult{}, err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return OpResult{}, err
	}
	defer tx.Rollback()

	var stored string
	err = tx.QueryRow(`SELECT payload FROM ops WHERE id = ?`, op.ID).Scan(&stored)
	if err == nil {
		var p opPayload
		if err := json.Unmarshal([]byte(stored), &p); err != nil {
			return OpResult{}, err
		}
		if !bytes.Equal(p.Request, req) {
			return OpResult{}, conflict("op %s is stored with a different request", op.ID)
		}
		return readOp(tx, op.ID)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return OpResult{}, err
	}

	now := s.now()
	placeholder, err := json.Marshal(opPayload{Request: req})
	if err != nil {
		return OpResult{}, err
	}
	if _, err := tx.Exec(`INSERT INTO ops (id, kind, payload, created_at) VALUES (?, ?, ?, ?)`,
		op.ID, op.Change.Kind(), string(placeholder), now); err != nil {
		return OpResult{}, err
	}
	if afterOpRow != nil {
		afterOpRow()
	}
	t := &opTx{tx: tx, opID: op.ID, now: now, seen: map[string]int{}}
	for _, nt := range op.NewTopics {
		if err := t.createTopic(nt); err != nil {
			return OpResult{}, err
		}
	}
	if err := op.Change.apply(t); err != nil {
		return OpResult{}, err
	}
	payload, err := json.Marshal(opPayload{Request: req, Topics: t.changes})
	if err != nil {
		return OpResult{}, err
	}
	if _, err := tx.Exec(`UPDATE ops SET payload = ? WHERE id = ?`, string(payload), op.ID); err != nil {
		return OpResult{}, err
	}
	res, err := readOp(tx, op.ID)
	if err != nil {
		return OpResult{}, err
	}
	return res, tx.Commit()
}

func undoID(opID string) string { return "undo:" + opID }

// Undo reverses op id exactly: the topics it changed go back to their
// states before it (a topic it created becomes retracted), the memberships
// it added are removed, and fresh copies of the ones it removed are added.
// Undoing an undone op is a no-op. Undo refuses with ErrConflict, writing
// nothing, when a later op that still stands has built on what id did.
func (s *Store) Undo(id string) (OpResult, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return OpResult{}, err
	}
	defer tx.Rollback()

	var kind, stored string
	var undone sql.NullInt64
	err = tx.QueryRow(`SELECT kind, payload, undone_at FROM ops WHERE id = ?`, id).Scan(&kind, &stored, &undone)
	if errors.Is(err, sql.ErrNoRows) {
		return OpResult{}, notFound("op %s", id)
	}
	if err != nil {
		return OpResult{}, err
	}
	if undone.Valid {
		return readOp(tx, id)
	}
	if !kinds[Kind(kind)].undoable {
		return OpResult{}, conflict("a %s op cannot be undone", kind)
	}
	var p opPayload
	if err := json.Unmarshal([]byte(stored), &p); err != nil {
		return OpResult{}, err
	}
	now := s.now()
	t := &opTx{tx: tx, opID: undoID(id), now: now}
	standing, err := t.standingRows(id)
	if err != nil {
		return OpResult{}, err
	}

	for i := len(p.Topics) - 1; i >= 0; i-- {
		c := p.Topics[i]
		cur, err := t.topic(c.ID)
		if err != nil {
			return OpResult{}, err
		}
		if cur.state != c.After {
			return OpResult{}, conflict("topic %s changed after op %s", c.ID, id)
		}
		before := topicState{Status: "retracted"}
		if c.Before != nil {
			before = *c.Before
		} else if err := t.requireOnlyEdgesOf(c.ID, id, standing); err != nil {
			return OpResult{}, err
		}
		if err := t.writeStatus(c.ID, before); err != nil {
			return OpResult{}, err
		}
	}

	for rowID := range standing {
		if err := t.removeEdge(edgeRow{RowID: rowID}); err != nil {
			return OpResult{}, err
		}
	}

	removed, err := scanEdges(tx.Query(`SELECT id, message_id, topic_id, source, confidence FROM memberships
		WHERE removed_by = ? ORDER BY id`, id))
	if err != nil {
		return OpResult{}, err
	}
	for _, e := range removed {
		cur, err := t.topic(e.TopicID)
		if err != nil {
			return OpResult{}, err
		}
		if cur.state.Status != "live" && cur.state.Status != "archived" {
			return OpResult{}, conflict("topic %s is %s", e.TopicID, cur.state.Status)
		}
		if err := t.insertEdge(e.MessageID, e.TopicID, e.Source, e.Confidence); err != nil {
			return OpResult{}, err
		}
	}

	if _, err := tx.Exec(`UPDATE ops SET undone_at = ? WHERE id = ?`, now, id); err != nil {
		return OpResult{}, err
	}
	res, err := readOp(tx, id)
	if err != nil {
		return OpResult{}, err
	}
	return res, tx.Commit()
}

type rowQuerier interface {
	querier
	Query(query string, args ...any) (*sql.Rows, error)
}

func readOp(q rowQuerier, id string) (OpResult, error) {
	r := OpResult{ID: id, Added: []Edge{}, Removed: []Edge{}}
	var undone sql.NullInt64
	if err := q.QueryRow(`SELECT kind, created_at, undone_at FROM ops WHERE id = ?`, id).
		Scan(&r.Kind, &r.CreatedAt, &undone); err != nil {
		return OpResult{}, err
	}
	if undone.Valid {
		r.UndoneAt = &undone.Int64
	}
	for _, side := range []struct {
		where string
		into  *[]Edge
	}{{"op_id = ?", &r.Added}, {"removed_by = ?", &r.Removed}} {
		edges, err := scanEdges(q.Query(`SELECT id, message_id, topic_id, source, confidence FROM memberships
			WHERE `+side.where+` ORDER BY id`, id))
		if err != nil {
			return OpResult{}, err
		}
		for _, e := range edges {
			*side.into = append(*side.into, Edge{MessageID: e.MessageID, TopicID: e.TopicID})
		}
	}
	return r, nil
}
