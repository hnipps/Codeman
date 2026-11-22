package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"unicode"

	"codeman/chat-graph/route"
)

const (
	maxQueryTerms = 64
	maxFTSRows    = 200
	maxAliasHops  = 16
)

var _ route.Retriever = (*Store)(nil)

// Now is the store's clock, in ms, so activation ages and touch times agree.
func (s *Store) Now() int64 { return s.now() }

// ftsQuery turns free text into an FTS5 expression the text cannot break:
// letter and digit runs only, each quoted, joined with OR. "" means no terms.
func ftsQuery(text string) string {
	seen := map[string]bool{}
	var terms []string
	for _, w := range strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	}) {
		if seen[w] {
			continue
		}
		seen[w] = true
		terms = append(terms, `"`+w+`"`)
		if len(terms) == maxQueryTerms {
			break
		}
	}
	return strings.Join(terms, " OR ")
}

// Retrieve is v1's route.Retriever: BM25 over message text and topic titles.
// A message hit counts for the topics it is live in. Merged topics resolve to
// the topic they merged into, and only live and archived topics are returned
// (archived is searched, never attached silently: Decide sees its status).
func (s *Store) Retrieve(query string, limit int) ([]route.Hit, error) {
	expr := ftsQuery(query)
	if expr == "" {
		return nil, nil
	}
	rows, err := s.db.Query(`WITH hits AS (
			SELECT kind, ref, -bm25(messages_fts) AS rel FROM messages_fts
			WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT ?)
		SELECT ref, rel FROM hits WHERE kind = 'topic'
		UNION ALL
		SELECT m.topic_id, h.rel FROM hits h JOIN memberships m ON m.message_id = h.ref AND m.removed_at IS NULL
		WHERE h.kind = 'message'`, expr, maxFTSRows)
	if err != nil {
		return nil, err
	}
	var raw []route.Hit
	for rows.Next() {
		var h route.Hit
		if err := rows.Scan(&h.TopicID, &h.Relevance); err != nil {
			rows.Close()
			return nil, err
		}
		raw = append(raw, h)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	resolved := map[string]ResolvedTopic{}
	best := map[string]float64{}
	for _, h := range raw {
		rt, ok := resolved[h.TopicID]
		if !ok {
			if rt, err = resolveTopic(s.db, h.TopicID); errors.Is(err, ErrConflict) {
				continue
			} else if err != nil {
				return nil, err
			}
			resolved[h.TopicID] = rt
		}
		if rt.Status != route.StatusLive && rt.Status != route.StatusArchived {
			continue
		}
		if r, seen := best[rt.ID]; !seen || h.Relevance > r {
			best[rt.ID] = h.Relevance
		}
	}
	out := make([]route.Hit, 0, len(best))
	for id, rel := range best {
		out = append(out, route.Hit{TopicID: id, Relevance: rel})
	}
	slices.SortFunc(out, func(a, b route.Hit) int {
		if a.Relevance != b.Relevance {
			if a.Relevance > b.Relevance {
				return -1
			}
			return 1
		}
		return strings.Compare(a.TopicID, b.TopicID)
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// ResolvedTopic is a topic with its merged_into aliases followed.
type ResolvedTopic struct {
	ID     string
	Title  string
	Status route.Status
}

// ResolveTopic follows id's merged_into chain to the topic it ends at.
func (s *Store) ResolveTopic(id string) (ResolvedTopic, error) { return resolveTopic(s.db, id) }

func resolveTopic(q querier, id string) (ResolvedTopic, error) {
	for hop := 0; hop <= maxAliasHops; hop++ {
		rt := ResolvedTopic{ID: id}
		var merged sql.NullString
		err := q.QueryRow(`SELECT title, status, merged_into FROM topics WHERE id = ?`, id).Scan(&rt.Title, &rt.Status, &merged)
		if errors.Is(err, sql.ErrNoRows) {
			return ResolvedTopic{}, notFound("topic %s", id)
		}
		if err != nil {
			return ResolvedTopic{}, err
		}
		if rt.Status != route.StatusMerged || !merged.Valid {
			return rt, nil
		}
		id = merged.String
	}
	return ResolvedTopic{}, conflict("topic %s merges more than %d deep", id, maxAliasHops)
}

// TopicInfos returns, for each id that exists, its title, status and newest
// route.MaxTouches touch times. Ids that do not exist are left out.
func (s *Store) TopicInfos(ids []string) (map[string]route.TopicInfo, error) {
	out := map[string]route.TopicInfo{}
	for _, id := range ids {
		var info route.TopicInfo
		err := s.db.QueryRow(`SELECT title, status FROM topics WHERE id = ?`, id).Scan(&info.Title, &info.Status)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, err
		}
		rows, err := s.db.Query(`SELECT at FROM touches WHERE topic_id = ? ORDER BY at DESC, id DESC LIMIT ?`, id, route.MaxTouches)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var at int64
			if err := rows.Scan(&at); err != nil {
				rows.Close()
				return nil, err
			}
			info.Touches = append(info.Touches, at)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		out[id] = info
	}
	return out, nil
}

// Message returns a stored message.
func (s *Store) Message(id string) (Message, error) {
	var m Message
	err := s.db.QueryRow(`SELECT id, text, ts, author, kind FROM messages WHERE id = ?`, id).
		Scan(&m.ID, &m.Text, &m.TS, &m.Author, &m.Kind)
	if errors.Is(err, sql.ErrNoRows) {
		return Message{}, notFound("message %s", id)
	}
	return m, err
}

// MessageTopics returns the topics a message is live in, by id.
func (s *Store) MessageTopics(messageID string) ([]string, error) {
	rows, err := s.db.Query(`SELECT topic_id FROM memberships WHERE message_id = ? AND removed_at IS NULL ORDER BY topic_id`, messageID)
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

// Correction is one move: the router filed MessageID to WrongTopicID and a
// person moved it to RightTopicID.
type Correction struct {
	MessageID    string `json:"messageId"`
	ResolvedText string `json:"resolvedText"`
	WrongTopicID string `json:"wrongTopicId"`
	RightTopicID string `json:"rightTopicId"`
	OpID         string `json:"opId"`
	CreatedAt    int64  `json:"createdAt"`
}

// Corrections returns the newest limit corrections whose move still stands.
func (s *Store) Corrections(limit int) ([]Correction, error) {
	rows, err := s.db.Query(`SELECT c.message_id, c.resolved_text, c.wrong_topic_id, c.right_topic_id, c.op_id, c.created_at
		FROM corrections c JOIN ops o ON o.id = c.op_id WHERE o.undone_at IS NULL
		ORDER BY c.created_at DESC, c.id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Correction{}
	for rows.Next() {
		var c Correction
		var text, wrong, right sql.NullString
		if err := rows.Scan(&c.MessageID, &text, &wrong, &right, &c.OpID, &c.CreatedAt); err != nil {
			return nil, err
		}
		c.ResolvedText, c.WrongTopicID, c.RightTopicID = text.String, wrong.String, right.String
		out = append(out, c)
	}
	return out, rows.Err()
}

// StoredRoute returns the route op stored under messageID, parsed back from
// its request, with its result. ok is false when there is none.
func (s *Store) StoredRoute(messageID string) (r Route, newTopics []NewTopic, res OpResult, ok bool, err error) {
	var kind, stored string
	err = s.db.QueryRow(`SELECT kind, payload FROM ops WHERE id = ?`, messageID).Scan(&kind, &stored)
	if errors.Is(err, sql.ErrNoRows) {
		return Route{}, nil, OpResult{}, false, nil
	}
	if err != nil {
		return Route{}, nil, OpResult{}, false, err
	}
	if Kind(kind) != KindRoute {
		return Route{}, nil, OpResult{}, false, conflict("op %s is a %s op", messageID, kind)
	}
	var p opPayload
	if err := json.Unmarshal([]byte(stored), &p); err != nil {
		return Route{}, nil, OpResult{}, false, err
	}
	var req struct {
		NewTopics []NewTopic `json:"newTopics"`
		Args      Route      `json:"args"`
	}
	if err := json.Unmarshal(p.Request, &req); err != nil {
		return Route{}, nil, OpResult{}, false, err
	}
	res, err = readOp(s.db, messageID)
	if err != nil {
		return Route{}, nil, OpResult{}, false, err
	}
	return req.Args, req.NewTopics, res, true, nil
}
