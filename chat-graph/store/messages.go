package store

import (
	"database/sql"
	"encoding/json"
	"errors"
)

type MessageKind string

const (
	KindChat    MessageKind = "chat"
	KindCapture MessageKind = "capture"
)

type Message struct {
	ID     string      `json:"id"`
	Text   string      `json:"text"`
	TS     int64       `json:"ts"`
	Author string      `json:"author"`
	Kind   MessageKind `json:"kind"`
}

// ParseMessage reads a message from a request body. kind defaults to chat.
func ParseMessage(raw []byte) (Message, error) {
	var m Message
	if err := json.Unmarshal(raw, &m); err != nil {
		return Message{}, invalid("message body is not a JSON message")
	}
	if m.Kind == "" {
		m.Kind = KindChat
	}
	switch {
	case !validID(m.ID):
		return Message{}, invalid("message id %q", m.ID)
	case m.Text == "":
		return Message{}, invalid("message %s has no text", m.ID)
	case m.TS <= 0:
		return Message{}, invalid("message %s has no ts", m.ID)
	case m.Author == "":
		return Message{}, invalid("message %s has no author", m.ID)
	case m.Kind != KindChat && m.Kind != KindCapture:
		return Message{}, invalid("message %s kind %q", m.ID, m.Kind)
	}
	return m, nil
}

// AddMessage stores m. Storing the same message again writes nothing; a
// different message under a stored id is ErrConflict.
func (s *Store) AddMessage(m Message) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var old Message
	err = tx.QueryRow(`SELECT id, text, ts, author, kind FROM messages WHERE id = ?`, m.ID).
		Scan(&old.ID, &old.Text, &old.TS, &old.Author, &old.Kind)
	switch {
	case err == nil && old == m:
		return nil
	case err == nil:
		return conflict("message %s is stored with a different body", m.ID)
	case !errors.Is(err, sql.ErrNoRows):
		return err
	}
	if _, err := tx.Exec(`INSERT INTO messages (id, text, ts, author, kind) VALUES (?, ?, ?, ?, ?)`,
		m.ID, m.Text, m.TS, m.Author, m.Kind); err != nil {
		return err
	}
	return tx.Commit()
}

// UnroutedMessages returns the ids of stored messages with no route op. A
// route op's id is its message id.
func (s *Store) UnroutedMessages() ([]string, error) {
	rows, err := s.db.Query(`SELECT m.id FROM messages m LEFT JOIN ops o ON o.id = m.id WHERE o.id IS NULL ORDER BY m.ts, m.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// Routed reports whether a route op is stored for messageID.
func (s *Store) Routed(messageID string) (bool, error) {
	var n int
	err := s.db.QueryRow(`SELECT count(*) FROM ops WHERE id = ? AND kind = 'route'`, messageID).Scan(&n)
	return n > 0, err
}
