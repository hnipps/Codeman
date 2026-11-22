// Package route decides where a message is filed. It is pure: retrieval
// candidates come in through Retriever, scores come in from the model, and
// nothing here reads or writes the store.
package route

import (
	"math"
	"slices"
	"strings"
)

// Status is a topic's status, the same strings as topics.status.
type Status string

const (
	StatusLive      Status = "live"
	StatusArchived  Status = "archived"
	StatusMerged    Status = "merged"
	StatusRetracted Status = "retracted"
)

const (
	Decay = 0.5
	// SimilarityWeight is a placeholder: activation spans roughly 0 to -7
	// over a week, so w=5 lets a full text match outweigh a few days of
	// recency. It is to be tuned on the correction log.
	SimilarityWeight = 5
	MaxCandidates    = 5
	QuietAbove       = 0.8
	AttachAt         = 0.5
	MaxTouches       = 50
)

// Hit is one retriever answer: a topic and its raw relevance, higher is better.
type Hit struct {
	TopicID   string
	Relevance float64
}

// Retriever is the retrieval seam (spec Decision 4): v1 is BM25 in the store;
// a later retriever plugs in here without touching Rank, Decide or the store's ops.
type Retriever interface {
	Retrieve(query string, limit int) ([]Hit, error)
}

// TopicInfo is what Rank needs to know about a topic. Touches are in ms.
type TopicInfo struct {
	Title   string
	Status  Status
	Touches []int64
}

type Candidate struct {
	TopicID, Title string
	Status         Status
	Activation     float64 // math.Inf(-1) when never touched
	Similarity     float64 // relevance / max relevance in the hit set, 0..1
	RetrievalScore float64
}

// Activation is ACT-R base-level activation over a topic's touch times:
// B = ln sum (now - t_k)^(-d), with ages in seconds and clamped to at least 1.
func Activation(touches []int64, now int64, d float64) float64 {
	sum := 0.0
	for _, t := range touches {
		age := float64(now-t) / 1000
		if age < 1 {
			age = 1
		}
		sum += math.Pow(age, -d)
	}
	if sum == 0 {
		return math.Inf(-1)
	}
	return math.Log(sum)
}

func RetrievalScore(activation, similarity, w float64) float64 {
	return activation + w*similarity
}

// Rank turns hits into at most limit candidates, highest RetrievalScore
// first, ties by Similarity then TopicID. Hits whose topic is missing from
// infos are dropped; a topic hit twice keeps its best relevance.
func Rank(hits []Hit, infos map[string]TopicInfo, now int64, limit int) []Candidate {
	best := map[string]float64{}
	maxRel := 0.0
	for _, h := range hits {
		if _, ok := infos[h.TopicID]; !ok {
			continue
		}
		if r, seen := best[h.TopicID]; !seen || h.Relevance > r {
			best[h.TopicID] = h.Relevance
		}
		maxRel = math.Max(maxRel, h.Relevance)
	}
	out := make([]Candidate, 0, len(best))
	for id, rel := range best {
		info := infos[id]
		sim := 0.0
		if maxRel > 0 {
			sim = math.Max(rel, 0) / maxRel
		}
		act := Activation(info.Touches, now, Decay)
		out = append(out, Candidate{
			TopicID: id, Title: info.Title, Status: info.Status,
			Activation: act, Similarity: sim, RetrievalScore: RetrievalScore(act, sim, SimilarityWeight),
		})
	}
	slices.SortFunc(out, func(a, b Candidate) int {
		switch {
		case a.RetrievalScore != b.RetrievalScore:
			return descending(a.RetrievalScore, b.RetrievalScore)
		case a.Similarity != b.Similarity:
			return descending(a.Similarity, b.Similarity)
		}
		return strings.Compare(a.TopicID, b.TopicID)
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

func descending(a, b float64) int {
	if a > b {
		return -1
	}
	return 1
}

// Scored is one candidate as the model judged it. It carries no activation
// or retrieval value, so Decide cannot use one (invariant I4).
type Scored struct {
	TopicID string
	Status  Status
	Score   float64
}

type Band string

const (
	BandQuiet     Band = "quiet"     // score > QuietAbove
	BandProminent Band = "prominent" // AttachAt <= score <= QuietAbove
	BandExplicit  Band = "explicit"  // a reply, quote or chip: a hard edge
)

type Attachment struct {
	TopicID    string
	Confidence *float64
	Band       Band
}

// Decision: exactly one of Attach and New is set. Reactivate is set only with New.
type Decision struct {
	Attach     []Attachment
	New        bool
	Title      string
	Reactivate string
}

// BandFor is the band of a router attachment with this confidence.
func BandFor(score float64) Band {
	if score > QuietAbove {
		return BandQuiet
	}
	return BandProminent
}

// Decide files a message from the model's scores. Only live topics are
// attached (invariant I3); the best archived topic scoring AttachAt or more
// is offered for reactivation when a new topic results. Merged and retracted
// topics are never attached or offered.
func Decide(scored []Scored, title string) Decision {
	sorted := slices.Clone(scored)
	slices.SortFunc(sorted, func(a, b Scored) int {
		if a.Score != b.Score {
			return descending(a.Score, b.Score)
		}
		return strings.Compare(a.TopicID, b.TopicID)
	})
	var live []Scored
	reactivate := ""
	for _, c := range sorted {
		switch c.Status {
		case StatusLive:
			live = append(live, c)
		case StatusArchived:
			if reactivate == "" && c.Score >= AttachAt {
				reactivate = c.TopicID
			}
		}
	}
	switch {
	case len(live) >= 2 && live[1].Score > QuietAbove:
		return Decision{Attach: []Attachment{attachment(live[0]), attachment(live[1])}}
	case len(live) >= 1 && live[0].Score >= AttachAt:
		return Decision{Attach: []Attachment{attachment(live[0])}}
	}
	return Decision{New: true, Title: title, Reactivate: reactivate}
}

func attachment(c Scored) Attachment {
	score := c.Score
	return Attachment{TopicID: c.TopicID, Confidence: &score, Band: BandFor(score)}
}

// DecideExplicit files a message from an explicit signal. targets are the
// topics the signal names with their current status (a chip: one; a reply
// or quote: the replied message's live memberships' topics). Every live
// target is attached as a hard edge. With no live target, an archived one
// sends the message to a new topic and is offered for reactivation (I3).
// ok is false when no target is live or archived.
func DecideExplicit(targets []Scored, title string) (d Decision, ok bool) {
	sorted := slices.Clone(targets)
	slices.SortFunc(sorted, func(a, b Scored) int { return strings.Compare(a.TopicID, b.TopicID) })
	sorted = slices.CompactFunc(sorted, func(a, b Scored) bool { return a.TopicID == b.TopicID })
	archived := ""
	for _, t := range sorted {
		switch t.Status {
		case StatusLive:
			d.Attach = append(d.Attach, Attachment{TopicID: t.TopicID, Band: BandExplicit})
		case StatusArchived:
			if archived == "" {
				archived = t.TopicID
			}
		}
	}
	switch {
	case len(d.Attach) > 0:
		return d, true
	case archived != "":
		return Decision{New: true, Title: title, Reactivate: archived}, true
	}
	return Decision{}, false
}
