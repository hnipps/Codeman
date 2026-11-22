package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"

	"codeman/chat-graph/route"
	"codeman/chat-graph/store"
)

// retrieveHits is how many retriever hits Rank chooses from: more than
// route.MaxCandidates, so a recently active topic with a weaker text match
// can still outrank a stale strong one.
const retrieveHits = 50

const (
	defaultCorrections = 50
	maxCorrections     = 500
)

func invalidf(format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{store.ErrInvalid}, args...)...)
}

func conflictf(format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{store.ErrConflict}, args...)...)
}

func notFoundf(format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{store.ErrNotFound}, args...)...)
}

// unsortedID is the topic a message lands in when routing fails or times
// out (invariant I2). It is created by the first message filed there.
const (
	unsortedID    = "unsorted"
	unsortedTitle = "Unsorted"
)

func registerRouting(mux *http.ServeMux, st *store.Store, dl *deadlines) {
	mux.HandleFunc("POST /messages/{id}/candidates", func(w http.ResponseWriter, r *http.Request) {
		body, err := parseBody(w, r, parseCandidatesBody)
		var out candidatesAnswer
		if err == nil {
			out, err = candidates(st, r.PathValue("id"), body.Query)
		}
		respond(w, out, err)
	})
	mux.HandleFunc("POST /messages/{id}/route", func(w http.ResponseWriter, r *http.Request) {
		body, err := parseBody(w, r, parseRouteBody)
		var out routeAnswer
		if err == nil {
			out, err = routeMessage(st, r.PathValue("id"), body)
		}
		if err == nil {
			dl.done(r.PathValue("id"))
		}
		respond(w, out, err)
	})
	mux.HandleFunc("GET /corrections", func(w http.ResponseWriter, r *http.Request) {
		limit := defaultCorrections
		var err error
		if q := r.URL.Query().Get("limit"); q != "" {
			if limit, err = strconv.Atoi(q); err != nil || limit < 1 || limit > maxCorrections {
				err = invalidf("limit must be 1 to %d", maxCorrections)
			}
		}
		var out struct {
			Corrections []store.Correction `json:"corrections"`
		}
		if err == nil {
			out.Corrections, err = st.Corrections(limit)
		}
		respond(w, out, err)
	})
}

type candidatesBody struct {
	Query *string `json:"query"`
}

func parseCandidatesBody(raw []byte) (candidatesBody, error) {
	var b candidatesBody
	if len(raw) == 0 {
		return b, nil
	}
	if err := json.Unmarshal(raw, &b); err != nil {
		return b, invalidf("candidates body is not JSON")
	}
	return b, nil
}

// wireCandidate's pointers are null for -Inf (a topic never touched), which
// encoding/json cannot encode.
type wireCandidate struct {
	TopicID        string       `json:"topicId"`
	Title          string       `json:"title"`
	Status         route.Status `json:"status"`
	Activation     *float64     `json:"activation"`
	Similarity     float64      `json:"similarity"`
	RetrievalScore *float64     `json:"retrievalScore"`
}

type candidatesAnswer struct {
	Candidates []wireCandidate `json:"candidates"`
}

func finite(v float64) *float64 {
	if math.IsInf(v, 0) || math.IsNaN(v) {
		return nil
	}
	return &v
}

func candidates(st *store.Store, messageID string, query *string) (candidatesAnswer, error) {
	m, err := st.Message(messageID)
	if err != nil {
		return candidatesAnswer{}, err
	}
	q := m.Text
	if query != nil {
		q = *query
	}
	hits, err := st.Retrieve(q, retrieveHits)
	if err != nil {
		return candidatesAnswer{}, err
	}
	ids := make([]string, len(hits))
	for i, h := range hits {
		ids[i] = h.TopicID
	}
	infos, err := st.TopicInfos(ids)
	if err != nil {
		return candidatesAnswer{}, err
	}
	out := candidatesAnswer{Candidates: []wireCandidate{}}
	for _, c := range route.Rank(hits, infos, st.Now(), route.MaxCandidates) {
		out.Candidates = append(out.Candidates, wireCandidate{
			TopicID: c.TopicID, Title: c.Title, Status: c.Status,
			Activation: finite(c.Activation), Similarity: c.Similarity, RetrievalScore: finite(c.RetrievalScore),
		})
	}
	return out, nil
}

type signalKind string

const (
	signalReply signalKind = "reply"
	signalQuote signalKind = "quote"
	signalChip  signalKind = "chip"
)

type routeBody struct {
	Signal *struct {
		Kind      signalKind `json:"kind"`
		MessageID string     `json:"messageId"`
		TopicID   string     `json:"topicId"`
	} `json:"signal"`
	Scores []struct {
		TopicID string   `json:"topicId"`
		Score   *float64 `json:"score"`
	} `json:"scores"`
	Title    *string `json:"title"`
	NewTopic *struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	} `json:"newTopic"`
	ResolvedText string `json:"resolvedText"`
	Unsorted     bool   `json:"unsorted"`
}

func parseRouteBody(raw []byte) (routeBody, error) {
	var b routeBody
	if err := json.Unmarshal(raw, &b); err != nil {
		return b, invalidf("route body is not JSON")
	}
	scored := b.Scores != nil || b.Title != nil
	shapes := 0
	for _, has := range []bool{b.Signal != nil, scored, b.Unsorted} {
		if has {
			shapes++
		}
	}
	if shapes != 1 {
		return b, invalidf("a route body carries exactly one of signal, scores with title, and unsorted")
	}
	if b.Unsorted {
		return b, nil
	}
	if s := b.Signal; s != nil {
		switch {
		case (s.Kind == signalReply || s.Kind == signalQuote) && s.MessageID != "" && s.TopicID == "":
		case s.Kind == signalChip && s.TopicID != "" && s.MessageID == "":
		default:
			return b, invalidf("signal needs kind reply or quote with messageId, or chip with topicId")
		}
		return b, nil
	}
	if b.Title == nil || *b.Title == "" {
		return b, invalidf("scores need a non-empty title")
	}
	seen := map[string]bool{}
	for _, s := range b.Scores {
		if s.TopicID == "" || seen[s.TopicID] || s.Score == nil || *s.Score < 0 || *s.Score > 1 {
			return b, invalidf("score for %q: each topic once, with a score in [0, 1]", s.TopicID)
		}
		seen[s.TopicID] = true
	}
	return b, nil
}

type wireAttachment struct {
	TopicID    string     `json:"topicId"`
	Confidence *float64   `json:"confidence"`
	Band       route.Band `json:"band"`
}

type wireDecision struct {
	Attach     []wireAttachment `json:"attach"`
	NewTopic   *store.NewTopic  `json:"newTopic,omitempty"`
	Reactivate string           `json:"reactivate,omitempty"`
	// Unsorted says the router did not file this message: the chip says so.
	Unsorted bool `json:"unsorted,omitempty"`
}

type routeAnswer struct {
	Op       store.OpResult `json:"op"`
	Decision wireDecision   `json:"decision"`
}

// describe renders a stored route op. The first answer and every replay
// both come from here, so a retry after a timeout gets the same body (I5).
func describe(r store.Route, newTopics []store.NewTopic, res store.OpResult) routeAnswer {
	d := wireDecision{Attach: []wireAttachment{}, Reactivate: r.Reactivate, Unsorted: r.Source == "unsorted"}
	created := map[string]bool{}
	for i := range newTopics {
		created[newTopics[i].ID] = true
		if d.NewTopic == nil {
			d.NewTopic = &newTopics[i]
		}
	}
	for _, rt := range r.Topics {
		if created[rt.TopicID] {
			continue
		}
		band := route.BandExplicit
		if r.Source == "" {
			band = route.BandProminent
			if rt.Confidence != nil {
				band = route.BandFor(*rt.Confidence)
			}
		}
		d.Attach = append(d.Attach, wireAttachment{TopicID: rt.TopicID, Confidence: rt.Confidence, Band: band})
	}
	return routeAnswer{Op: res, Decision: d}
}

// routeMessage files a message once. A message already routed answers with
// its stored decision whatever this body says: the first decision stands.
func routeMessage(st *store.Store, messageID string, b routeBody) (routeAnswer, error) {
	if r, nts, res, ok, err := st.StoredRoute(messageID); err != nil || ok {
		return describe(r, nts, res), err
	}
	if _, err := st.Message(messageID); err != nil {
		return routeAnswer{}, err
	}
	if b.Unsorted {
		return routeUnsorted(st, messageID)
	}
	var d route.Decision
	var source string
	var err error
	if b.Signal != nil {
		source = string(b.Signal.Kind)
		d, err = decideExplicit(st, messageID, b)
	} else {
		d, err = decideScores(st, b)
	}
	if err != nil {
		return routeAnswer{}, err
	}

	r := store.Route{MessageID: messageID, Source: source, ResolvedText: b.ResolvedText, Reactivate: d.Reactivate}
	var newTopics []store.NewTopic
	if d.New {
		nt := store.NewTopic{ID: messageID, Title: d.Title}
		if b.NewTopic != nil && b.NewTopic.ID != "" {
			nt.ID = b.NewTopic.ID
		}
		newTopics = []store.NewTopic{nt}
		r.Topics = []store.RouteTopic{{TopicID: nt.ID}}
	}
	for _, a := range d.Attach {
		r.Topics = append(r.Topics, store.RouteTopic{TopicID: a.TopicID, Confidence: a.Confidence})
	}
	op, err := store.NewOp(messageID, newTopics, r)
	if err != nil {
		return routeAnswer{}, err
	}
	res, err := st.Apply(op)
	if errors.Is(err, store.ErrConflict) {
		// A retry that overlapped the first call can decide differently and
		// lose the race; it answers with the decision that won (I5).
		if r, nts, res, ok, rerr := st.StoredRoute(messageID); rerr == nil && ok {
			return describe(r, nts, res), nil
		}
	}
	if err != nil {
		return routeAnswer{}, err
	}
	return describe(r, newTopics, res), nil
}

// routeUnsorted files a message to the Unsorted topic, creating it with the
// same op when it does not exist. When Unsorted is archived or merged it is
// left alone and the message gets an Unsorted topic of its own (I3).
func routeUnsorted(st *store.Store, messageID string) (routeAnswer, error) {
	for attempt := 0; ; attempt++ {
		r := store.Route{MessageID: messageID, Source: "unsorted", Topics: []store.RouteTopic{{TopicID: unsortedID}}}
		var newTopics []store.NewTopic
		info, err := st.TopicInfos([]string{unsortedID})
		if err != nil {
			return routeAnswer{}, err
		}
		if existing, ok := info[unsortedID]; !ok {
			newTopics = []store.NewTopic{{ID: unsortedID, Title: unsortedTitle}}
		} else if existing.Status != route.StatusLive {
			own := unsortedID + "-" + messageID
			newTopics = []store.NewTopic{{ID: own, Title: unsortedTitle}}
			r.Topics = []store.RouteTopic{{TopicID: own}}
		}
		op, err := store.NewOp(messageID, newTopics, r)
		if err != nil {
			return routeAnswer{}, err
		}
		res, err := st.Apply(op)
		if errors.Is(err, store.ErrConflict) {
			if r, nts, res, ok, rerr := st.StoredRoute(messageID); rerr == nil && ok {
				return describe(r, nts, res), nil
			}
			// Another message created Unsorted between the read and the
			// write: read again and attach to it.
			if attempt == 0 {
				continue
			}
		}
		if err != nil {
			return routeAnswer{}, err
		}
		return describe(r, newTopics, res), nil
	}
}

// decideScores reads every scored topic's status from the store: the body
// supplies scores only (invariants I3, I4).
func decideScores(st *store.Store, b routeBody) (route.Decision, error) {
	ids := make([]string, len(b.Scores))
	for i, s := range b.Scores {
		ids[i] = s.TopicID
	}
	infos, err := st.TopicInfos(ids)
	if err != nil {
		return route.Decision{}, err
	}
	scored := make([]route.Scored, len(b.Scores))
	for i, s := range b.Scores {
		info, ok := infos[s.TopicID]
		if !ok {
			return route.Decision{}, notFoundf("topic %s", s.TopicID)
		}
		scored[i] = route.Scored{TopicID: s.TopicID, Status: info.Status, Score: *s.Score}
	}
	return route.Decide(scored, *b.Title), nil
}

func decideExplicit(st *store.Store, messageID string, b routeBody) (route.Decision, error) {
	sig := b.Signal
	var named []string
	if sig.Kind == signalChip {
		named = []string{sig.TopicID}
	} else {
		if sig.MessageID == messageID {
			return route.Decision{}, invalidf("a message cannot reply to or quote itself")
		}
		if _, err := st.Message(sig.MessageID); err != nil {
			return route.Decision{}, err
		}
		var err error
		if named, err = st.MessageTopics(sig.MessageID); err != nil {
			return route.Decision{}, err
		}
	}
	titles := map[string]string{}
	targets := make([]route.Scored, 0, len(named))
	for _, id := range named {
		rt, err := st.ResolveTopic(id)
		if err != nil {
			return route.Decision{}, err
		}
		titles[rt.ID] = rt.Title
		targets = append(targets, route.Scored{TopicID: rt.ID, Status: rt.Status})
	}
	title := ""
	if b.NewTopic != nil {
		title = b.NewTopic.Title
	}
	d, ok := route.DecideExplicit(targets, title)
	if !ok {
		return route.Decision{}, conflictf("the %s names no live or archived topic", sig.Kind)
	}
	if d.New && d.Title == "" {
		d.Title = titles[d.Reactivate]
	}
	return d, nil
}
