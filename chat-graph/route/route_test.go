package route

import (
	"fmt"
	"math"
	"math/rand"
	"reflect"
	"testing"
)

func conf(v float64) *float64 { return &v }

func TestDecide(t *testing.T) {
	cases := []struct {
		name   string
		scored []Scored
		want   Decision
	}{
		{"two live above 0.8 attach both, quietly",
			[]Scored{{"b", StatusLive, 0.85}, {"a", StatusLive, 0.95}, {"c", StatusLive, 0.9}},
			Decision{Attach: []Attachment{{"a", conf(0.95), BandQuiet}, {"c", conf(0.9), BandQuiet}}}},
		{"one quiet",
			[]Scored{{"a", StatusLive, 0.9}, {"b", StatusLive, 0.6}},
			Decision{Attach: []Attachment{{"a", conf(0.9), BandQuiet}}}},
		{"one prominent",
			[]Scored{{"a", StatusLive, 0.6}, {"b", StatusLive, 0.3}},
			Decision{Attach: []Attachment{{"a", conf(0.6), BandProminent}}}},
		{"exactly 0.8 is prominent", []Scored{{"a", StatusLive, 0.8}},
			Decision{Attach: []Attachment{{"a", conf(0.8), BandProminent}}}},
		{"exactly 0.5 attaches", []Scored{{"a", StatusLive, 0.5}},
			Decision{Attach: []Attachment{{"a", conf(0.5), BandProminent}}}},
		{"below 0.5 is a new topic", []Scored{{"a", StatusLive, 0.49}},
			Decision{New: true, Title: "Plumbing"}},
		{"empty list is a new topic", nil, Decision{New: true, Title: "Plumbing"}},
		{"ties broken by topic id", []Scored{{"z", StatusLive, 0.7}, {"m", StatusLive, 0.7}},
			Decision{Attach: []Attachment{{"m", conf(0.7), BandProminent}}}},
		{"archived alone offers reactivation", []Scored{{"old", StatusArchived, 0.9}, {"a", StatusLive, 0.2}},
			Decision{New: true, Title: "Plumbing", Reactivate: "old"}},
		{"best archived is offered", []Scored{{"x", StatusArchived, 0.6}, {"y", StatusArchived, 0.7}},
			Decision{New: true, Title: "Plumbing", Reactivate: "y"}},
		{"archived below 0.5 is not offered", []Scored{{"old", StatusArchived, 0.4}},
			Decision{New: true, Title: "Plumbing"}},
		{"live wins over a higher archived", []Scored{{"old", StatusArchived, 0.99}, {"a", StatusLive, 0.6}},
			Decision{Attach: []Attachment{{"a", conf(0.6), BandProminent}}}},
		{"merged and retracted are skipped and never offered",
			[]Scored{{"m", StatusMerged, 0.99}, {"r", StatusRetracted, 0.99}},
			Decision{New: true, Title: "Plumbing"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Decide(c.scored, "Plumbing"); !reflect.DeepEqual(got, c.want) {
				t.Fatalf("Decide = %s, want %s", show(got), show(c.want))
			}
		})
	}
}

func show(d Decision) string {
	s := fmt.Sprintf("{New:%v Title:%q Reactivate:%q Attach:[", d.New, d.Title, d.Reactivate)
	for _, a := range d.Attach {
		c := "nil"
		if a.Confidence != nil {
			c = fmt.Sprint(*a.Confidence)
		}
		s += fmt.Sprintf(" %s/%s/%s", a.TopicID, c, a.Band)
	}
	return s + " ]}"
}

func TestDecideExplicit(t *testing.T) {
	cases := []struct {
		name    string
		targets []Scored
		want    Decision
		ok      bool
	}{
		{"live targets attach as hard edges", []Scored{{"b", StatusLive, 0}, {"a", StatusLive, 0}, {"b", StatusLive, 0}},
			Decision{Attach: []Attachment{{"a", nil, BandExplicit}, {"b", nil, BandExplicit}}}, true},
		{"live beats archived", []Scored{{"old", StatusArchived, 0}, {"a", StatusLive, 0}},
			Decision{Attach: []Attachment{{"a", nil, BandExplicit}}}, true},
		{"archived only goes to a new topic", []Scored{{"old", StatusArchived, 0}},
			Decision{New: true, Title: "Plumbing", Reactivate: "old"}, true},
		{"retracted only is refused", []Scored{{"r", StatusRetracted, 0}}, Decision{}, false},
		{"no target is refused", nil, Decision{}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := DecideExplicit(c.targets, "Plumbing")
			if ok != c.ok || !reflect.DeepEqual(got, c.want) {
				t.Fatalf("DecideExplicit = %s %v, want %s %v", show(got), ok, show(c.want), c.ok)
			}
		})
	}
}

var statuses = []Status{StatusLive, StatusArchived, StatusMerged, StatusRetracted}

func randomScored(rng *rand.Rand) []Scored {
	out := make([]Scored, rng.Intn(7))
	for i := range out {
		out[i] = Scored{
			TopicID: fmt.Sprintf("t%d", rng.Intn(9)),
			Status:  statuses[rng.Intn(len(statuses))],
			Score:   float64(rng.Intn(101)) / 100,
		}
	}
	return out
}

func statusOf(scored []Scored) map[string]Status {
	out := map[string]Status{}
	for _, s := range scored {
		out[s.TopicID] = s.Status
	}
	return out
}

// Invariant I3: ArchivedNeverAttachedSilently
func TestDecideNeverAttachesANonLiveTopic(t *testing.T) {
	rng := rand.New(rand.NewSource(3))
	var attached, reactivated, plainNew int
	for i := 0; i < 20000; i++ {
		scored := randomScored(rng)
		// Unique ids, so each id has one status.
		seen := map[string]bool{}
		uniq := scored[:0]
		for _, s := range scored {
			if !seen[s.TopicID] {
				seen[s.TopicID] = true
				uniq = append(uniq, s)
			}
		}
		status := statusOf(uniq)
		d := Decide(uniq, "title")
		bestLive, bestArchived := -1.0, -1.0
		for _, s := range uniq {
			if s.Status == StatusLive {
				bestLive = math.Max(bestLive, s.Score)
			}
			if s.Status == StatusArchived {
				bestArchived = math.Max(bestArchived, s.Score)
			}
		}
		if d.New == (len(d.Attach) > 0) {
			t.Fatalf("%v: decision %s sets both or neither of Attach and New", uniq, show(d))
		}
		for _, a := range d.Attach {
			if status[a.TopicID] != StatusLive {
				t.Fatalf("%v: Decide attached %s topic %s", uniq, status[a.TopicID], a.TopicID)
			}
		}
		if d.Reactivate != "" && (!d.New || status[d.Reactivate] != StatusArchived) {
			t.Fatalf("%v: Reactivate %q on %s", uniq, d.Reactivate, show(d))
		}
		if bestLive < AttachAt && bestArchived >= AttachAt && (!d.New || d.Reactivate == "") {
			t.Fatalf("%v: best live %v, archived %v, but decision %s", uniq, bestLive, bestArchived, show(d))
		}
		switch {
		case len(d.Attach) > 0:
			attached++
		case d.Reactivate != "":
			reactivated++
		default:
			plainNew++
		}
	}
	if attached < 1000 || reactivated < 1000 || plainNew < 1000 {
		t.Fatalf("vacuous run: %d attached, %d reactivated, %d plain new", attached, reactivated, plainNew)
	}
}

// Invariant I3: ArchivedNeverAttachedSilently
func TestDecideExplicitNeverAttachesANonLiveTopic(t *testing.T) {
	rng := rand.New(rand.NewSource(4))
	var attached, reactivated, refused int
	for i := 0; i < 20000; i++ {
		targets := randomScored(rng)
		for j := range targets {
			targets[j].TopicID = fmt.Sprintf("t%d", j)
		}
		status := statusOf(targets)
		d, ok := DecideExplicit(targets, "title")
		hasLive, hasArchived := false, false
		for _, s := range targets {
			hasLive = hasLive || s.Status == StatusLive
			hasArchived = hasArchived || s.Status == StatusArchived
		}
		for _, a := range d.Attach {
			if status[a.TopicID] != StatusLive || a.Band != BandExplicit || a.Confidence != nil {
				t.Fatalf("%v: DecideExplicit attached %+v (%s)", targets, a, status[a.TopicID])
			}
		}
		switch {
		case !ok:
			if hasLive || hasArchived {
				t.Fatalf("%v: refused with a live or archived target", targets)
			}
			refused++
		case hasLive:
			if len(d.Attach) == 0 || d.New {
				t.Fatalf("%v: live target but %s", targets, show(d))
			}
			attached++
		default:
			if !d.New || status[d.Reactivate] != StatusArchived || len(d.Attach) > 0 {
				t.Fatalf("%v: archived target but %s", targets, show(d))
			}
			reactivated++
		}
	}
	if attached < 1000 || reactivated < 1000 || refused < 1000 {
		t.Fatalf("vacuous run: %d attached, %d reactivated, %d refused", attached, reactivated, refused)
	}
}

// Invariant I4: BandsUseRerankScoresOnly
// Activation and retrieval pick the candidates; once the model has scored
// them, different activations and relevances must not change the decision.
func TestDecisionIgnoresActivationAndRetrieval(t *testing.T) {
	rng := rand.New(rand.NewSource(5))
	const now = int64(10_000_000_000)
	world := func(ids []string, stat map[string]Status) ([]Hit, map[string]TopicInfo) {
		hits := make([]Hit, len(ids))
		infos := map[string]TopicInfo{}
		for i, id := range ids {
			hits[i] = Hit{TopicID: id, Relevance: rng.Float64() * 20}
			touches := make([]int64, rng.Intn(4))
			for j := range touches {
				touches[j] = now - rng.Int63n(7*24*3600*1000)
			}
			infos[id] = TopicInfo{Title: id, Status: stat[id], Touches: touches}
		}
		return hits, infos
	}
	var differed, decided int
	for i := 0; i < 5000; i++ {
		ids := make([]string, 1+rng.Intn(8))
		stat := map[string]Status{}
		score := map[string]float64{}
		for j := range ids {
			ids[j] = fmt.Sprintf("t%d", j)
			stat[ids[j]] = statuses[rng.Intn(2)]
			score[ids[j]] = float64(rng.Intn(101)) / 100
		}
		decide := func() (Decision, []Candidate) {
			hits, infos := world(ids, stat)
			cands := Rank(hits, infos, now, len(ids))
			scored := make([]Scored, len(cands))
			for j, c := range cands {
				scored[j] = Scored{TopicID: c.TopicID, Status: c.Status, Score: score[c.TopicID]}
			}
			return Decide(scored, "title"), cands
		}
		d1, c1 := decide()
		d2, c2 := decide()
		if !reflect.DeepEqual(d1, d2) {
			t.Fatalf("same scores and statuses, different decisions: %s vs %s", show(d1), show(d2))
		}
		if len(c1) != len(ids) {
			t.Fatalf("Rank kept %d of %d candidates", len(c1), len(ids))
		}
		if c1[0].TopicID != c2[0].TopicID || c1[0].RetrievalScore != c2[0].RetrievalScore {
			differed++
		}
		if len(d1.Attach) > 0 {
			decided++
		}
	}
	if differed < 1000 || decided < 1000 {
		t.Fatalf("vacuous run: %d runs had different rankings, %d attached", differed, decided)
	}
}

func TestActivation(t *testing.T) {
	const now = int64(1_000_000_000)
	if a := Activation(nil, now, Decay); !math.IsInf(a, -1) {
		t.Fatalf("never touched: %v, want -Inf", a)
	}
	recent := Activation([]int64{now - 60_000}, now, Decay)
	old := Activation([]int64{now - 86_400_000}, now, Decay)
	if !(recent > old) {
		t.Fatalf("a minute ago %v is not above a day ago %v", recent, old)
	}
	if more := Activation([]int64{now - 86_400_000, now - 86_400_000}, now, Decay); !(more > old) {
		t.Fatalf("two touches %v is not above one %v", more, old)
	}
	for _, age := range []int64{0, 500, -5000} {
		if a := Activation([]int64{now - age}, now, Decay); a != 0 {
			t.Fatalf("age %d ms: %v, want 0 (age clamps to 1 s, ln 1 = 0)", age, a)
		}
	}
}

func TestRank(t *testing.T) {
	const now = int64(1_000_000_000)
	infos := map[string]TopicInfo{
		"fresh": {Title: "Fresh", Status: StatusLive, Touches: []int64{now - 1000}},
		"stale": {Title: "Stale", Status: StatusArchived, Touches: []int64{now - 30*86_400_000}},
		"never": {Title: "Never", Status: StatusLive},
		"tie-a": {Title: "A", Status: StatusLive, Touches: []int64{now - 1000}},
		"tie-b": {Title: "B", Status: StatusLive, Touches: []int64{now - 1000}},
	}
	hits := []Hit{{"stale", 10}, {"fresh", 5}, {"never", 10}, {"gone", 50}, {"tie-b", 5}, {"tie-a", 5}, {"stale", 2}}
	got := Rank(hits, infos, now, 10)
	var order []string
	for _, c := range got {
		order = append(order, c.TopicID)
	}
	if want := []string{"fresh", "tie-a", "tie-b", "stale", "never"}; !reflect.DeepEqual(order, want) {
		t.Fatalf("order %v, want %v", order, want)
	}
	if got[3].Similarity != 1 || got[0].Similarity != 0.5 {
		t.Fatalf("similarity not normalised to the best kept hit: %+v", got)
	}
	if never := got[4]; !math.IsInf(never.Activation, -1) || !math.IsInf(never.RetrievalScore, -1) {
		t.Fatalf("never-touched candidate %+v", never)
	}
	if n := len(Rank(hits, infos, now, 2)); n != 2 {
		t.Fatalf("limit 2 returned %d", n)
	}
}
