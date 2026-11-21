package store

import (
	"database/sql"
	"errors"
)

// opTx is one op's transaction. Every topic it changes is recorded in
// changes, which Apply stores in the op's payload for Undo.
type opTx struct {
	tx      *sql.Tx
	opID    string
	now     int64
	changes []topicChange
	seen    map[string]int // topic id -> index in changes
}

type topicRow struct {
	id    string
	state topicState
}

type edgeRow struct {
	RowID      int64
	MessageID  string
	TopicID    string
	Source     string
	Confidence *float64
}

func (t *opTx) topic(id string) (topicRow, error) {
	r := topicRow{id: id}
	var merged sql.NullString
	err := t.tx.QueryRow(`SELECT status, merged_into FROM topics WHERE id = ?`, id).Scan(&r.state.Status, &merged)
	if errors.Is(err, sql.ErrNoRows) {
		return r, notFound("topic %s", id)
	}
	r.state.MergedInto = merged.String
	return r, err
}

func (t *opTx) requireLive(id string) error {
	r, err := t.topic(id)
	if err != nil {
		return err
	}
	if r.state.Status != "live" {
		return conflict("topic %s is %s", id, r.state.Status)
	}
	return nil
}

func (t *opTx) createTopic(nt NewTopic) error {
	var n int
	if err := t.tx.QueryRow(`SELECT count(*) FROM topics WHERE id = ?`, nt.ID).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return conflict("topic %s already exists", nt.ID)
	}
	if _, err := t.tx.Exec(`INSERT INTO topics (id, title, status, last_active_at, created_by_op) VALUES (?, ?, 'live', ?, ?)`,
		nt.ID, nt.Title, t.now, t.opID); err != nil {
		return err
	}
	t.seen[nt.ID] = len(t.changes)
	t.changes = append(t.changes, topicChange{ID: nt.ID, After: topicState{Status: "live"}})
	return nil
}

func (t *opTx) setStatus(id string, s topicState) error {
	i, ok := t.seen[id]
	if !ok {
		cur, err := t.topic(id)
		if err != nil {
			return err
		}
		before := cur.state
		i = len(t.changes)
		t.seen[id] = i
		t.changes = append(t.changes, topicChange{ID: id, Before: &before})
	}
	t.changes[i].After = s
	return t.writeStatus(id, s)
}

func (t *opTx) writeStatus(id string, s topicState) error {
	_, err := t.tx.Exec(`UPDATE topics SET status = ?, merged_into = ? WHERE id = ?`,
		s.Status, sql.NullString{String: s.MergedInto, Valid: s.MergedInto != ""}, id)
	return err
}

// requireOnlyEdgesOf refuses to retract a topic that later ops filed
// messages to, which would hide those messages on a topic nobody sees.
func (t *opTx) requireOnlyEdgesOf(topicID, opID string) error {
	var n int
	if err := t.tx.QueryRow(`SELECT count(*) FROM memberships WHERE topic_id = ? AND removed_at IS NULL AND op_id != ?`,
		topicID, opID).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return conflict("topic %s has messages filed after op %s", topicID, opID)
	}
	return nil
}

func (t *opTx) liveEdge(messageID, topicID string) (edgeRow, bool, error) {
	edges, err := scanEdges(t.tx.Query(`SELECT id, message_id, topic_id, source, confidence FROM memberships
		WHERE message_id = ? AND topic_id = ? AND removed_at IS NULL`, messageID, topicID))
	if err != nil || len(edges) == 0 {
		return edgeRow{}, false, err
	}
	return edges[0], true, nil
}

func (t *opTx) liveEdges(topicID string) ([]edgeRow, error) {
	return scanEdges(t.tx.Query(`SELECT id, message_id, topic_id, source, confidence FROM memberships
		WHERE topic_id = ? AND removed_at IS NULL ORDER BY id`, topicID))
}

// addEdge files a message to a live topic it is not already in.
func (t *opTx) addEdge(messageID, topicID, source string, confidence *float64) error {
	var n int
	if err := t.tx.QueryRow(`SELECT count(*) FROM messages WHERE id = ?`, messageID).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return notFound("message %s", messageID)
	}
	if err := t.requireLive(topicID); err != nil {
		return err
	}
	if err := t.insertEdge(messageID, topicID, source, confidence); err != nil {
		return err
	}
	_, err := t.tx.Exec(`UPDATE topics SET last_active_at = max(last_active_at, ?) WHERE id = ?`, t.now, topicID)
	return err
}

func (t *opTx) insertEdge(messageID, topicID, source string, confidence *float64) error {
	if _, live, err := t.liveEdge(messageID, topicID); err != nil {
		return err
	} else if live {
		return conflict("message %s is already in topic %s", messageID, topicID)
	}
	_, err := t.tx.Exec(`INSERT INTO memberships (message_id, topic_id, source, confidence, op_id) VALUES (?, ?, ?, ?, ?)`,
		messageID, topicID, source, confidence, t.opID)
	return err
}

func (t *opTx) removeEdge(e edgeRow) error {
	_, err := t.tx.Exec(`UPDATE memberships SET removed_at = ?, removed_by = ? WHERE id = ? AND removed_at IS NULL`,
		t.now, t.opID, e.RowID)
	return err
}

func scanEdges(rows *sql.Rows, err error) ([]edgeRow, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []edgeRow
	for rows.Next() {
		var e edgeRow
		var c sql.NullFloat64
		if err := rows.Scan(&e.RowID, &e.MessageID, &e.TopicID, &e.Source, &c); err != nil {
			return nil, err
		}
		if c.Valid {
			e.Confidence = &c.Float64
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
