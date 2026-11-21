package store

import (
	"database/sql"
	"errors"
)

type TopicSummary struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	Status       string `json:"status"`
	MergedInto   string `json:"mergedInto,omitempty"`
	LastActiveAt int64  `json:"lastActiveAt"`
	LiveMembers  int    `json:"liveMembers"`
}

type TopicDetail struct {
	TopicSummary
	MessageIDs []string `json:"messageIds"`
}

const topicColumns = `t.id, t.title, t.status, t.merged_into, t.last_active_at,
	(SELECT count(*) FROM memberships m WHERE m.topic_id = t.id AND m.removed_at IS NULL)`

func scanTopic(scan func(...any) error) (TopicSummary, error) {
	var s TopicSummary
	var merged sql.NullString
	err := scan(&s.ID, &s.Title, &s.Status, &merged, &s.LastActiveAt, &s.LiveMembers)
	s.MergedInto = merged.String
	return s, err
}

// Topics lists every topic, most recently active first.
func (s *Store) Topics() ([]TopicSummary, error) {
	rows, err := s.db.Query(`SELECT ` + topicColumns + ` FROM topics t ORDER BY t.last_active_at DESC, t.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TopicSummary{}
	for rows.Next() {
		t, err := scanTopic(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// Topic returns one topic and the ids of its live messages in time order.
func (s *Store) Topic(id string) (TopicDetail, error) {
	sum, err := scanTopic(s.db.QueryRow(`SELECT `+topicColumns+` FROM topics t WHERE t.id = ?`, id).Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return TopicDetail{}, notFound("topic %s", id)
	}
	if err != nil {
		return TopicDetail{}, err
	}
	d := TopicDetail{TopicSummary: sum, MessageIDs: []string{}}
	rows, err := s.db.Query(`SELECT m.message_id FROM memberships m JOIN messages g ON g.id = m.message_id
		WHERE m.topic_id = ? AND m.removed_at IS NULL ORDER BY g.ts, g.id`, id)
	if err != nil {
		return TopicDetail{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var mid string
		if err := rows.Scan(&mid); err != nil {
			return TopicDetail{}, err
		}
		d.MessageIDs = append(d.MessageIDs, mid)
	}
	return d, rows.Err()
}
