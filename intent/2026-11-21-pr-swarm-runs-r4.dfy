// pr-swarm runs, revision 4 (T1-T5): when a review's run starts, and when it ends.
// One review. A tip is modelled by its changes: the patch id of `git diff <base>...<tip>`, so two tips with the same
// changes are the same work to review. Time is in watcher passes' units; SETTLE is T3's wait.
module SwarmRunsR4 {
  datatype Option<T> = None | Some(value: T)

  const SETTLE: nat := 5

  // An active run (queued or running): the changes its current round reviews.
  datatype Run = Run(roundCh: nat)

  datatype Review = Review(
    ch: nat,                 // the review's changes at the branch tip now
    reviewed: Option<nat>,   // the changes the newest finished run reviewed
    active: Option<Run>,     // at most one run (I1)
    owed: bool,              // a run is owed: new changes arrived while settling or held
    since: nat,              // when the current changes were first seen (T3)
    held: bool,              // the linked Work item is In progress (T4)
    decided: bool,           // merged, deploying, deployed or closed (T5)
    now: nat
  )

  datatype Event =
    | Submit(c: nat)              // a submit or resubmit at a tip with changes c
    | Push(c: nat)                // the watcher saw the tip move to one with changes c (own trailer commits included)
    | Tick                        // time passes
    | Pass                        // a watcher pass
    | Manual                      // a person's Run pr-swarm
    | Hold(b: bool)               // the Work item enters (true) or leaves (false) In progress
    | Report(c: nat)              // the run's session reports a round that reviewed changes c
    | RunFails
    | Decide

  predicate Free(r: Review) { r.active.None? && !r.decided }
  predicate New(r: Review, c: nat) { r.reviewed != Some(c) }
  function Start(r: Review): Review { r.(active := Some(Run(r.ch)), owed := false) }

  function Step(r: Review, e: Event): Review {
    match e
    case Submit(c) =>
      var r1 := r.(ch := c, since := if c != r.ch then r.now else r.since);
      if r.decided then r1
      else if r.active.Some? then r1                                   // I2: joins the running run
      else if !New(r1, c) then r1                                      // T1: tip already reviewed
      else if r.held then r1.(owed := true)                            // T4: waits for the builder
      else Start(r1)
    case Push(c) =>
      if c == r.ch then r                                              // T2: same changes, nothing to review
      else
        var r1 := r.(ch := c, since := r.now);
        if r.decided || r.active.Some? then r1                         // I2: joins; a decided review is not watched
        else r1.(owed := New(r1, c))                                   // T3: settles first
    case Tick => r.(now := r.now + 1)
    case Pass =>
      if Free(r) && r.owed && !r.held && New(r, r.ch) && r.now >= r.since + SETTLE then Start(r)
      else if Free(r) && r.owed && !New(r, r.ch) then r.(owed := false)
      else r
    case Manual => if Free(r) then Start(r) else r                       // a person may always ask again
    case Hold(b) => r.(held := b)
    case Report(c) =>
      if r.active.None? || r.active.value.roundCh != c then r
      else if c == r.ch then r.(active := None, reviewed := Some(c))   // finished on the branch tip
      else r.(active := Some(Run(r.ch)))                               // I2: another round on the new tip
    case RunFails => r.(active := None)
    case Decide => r.(decided := true, active := None, owed := false)  // T5
  }

  function Run_(r: Review, tr: seq<Event>): Review decreases |tr| {
    if |tr| == 0 then r else Run_(Step(r, tr[0]), tr[1..])
  }

  function Fresh(c: nat): Review { Review(c, None, None, false, 0, false, false, 0) }

  predicate Starts(r: Review, e: Event) { r.active.None? && Step(r, e).active.Some? }

  // ---- Safety ----

  // T5: a decided review never has a run, and nothing starts one afterwards, not even a person's press.
  predicate Inv(r: Review) { r.decided ==> r.active.None? && !r.owed }
  lemma StepInv(r: Review, e: Event) requires Inv(r) ensures Inv(Step(r, e)) {}
  lemma DecidedNeverRuns(r: Review, e: Event) requires r.decided ensures !Starts(r, e) {}
  lemma DecidingEndsTheRun(r: Review) ensures Step(r, Decide).active.None? {}

  // T1 + T2: a run that starts by itself reviews changes no finished run has reviewed.
  lemma OnlyNewChangesStart(r: Review, e: Event)
    requires e != Manual && Starts(r, e)
    ensures Step(r, e).reviewed != Some(Step(r, e).active.value.roundCh)
  {}

  // T4: nothing starts by itself while the builder holds the item.
  lemma HeldStartsNothing(r: Review, e: Event)
    requires r.held && e != Manual && !e.Hold?
    ensures !Starts(r, e)
  {}

  // T2: a move to a tip with the same changes changes nothing, so it does not restart T3's wait either.
  lemma SameChangesChangeNothing(r: Review, c: nat) requires c == r.ch ensures Step(r, Push(c)) == r {}

  // T3: a push never starts a run itself; the pass that does has waited SETTLE since the changes last moved.
  lemma PushesSettle(r: Review, c: nat) ensures !Starts(r, Push(c)) {}
  lemma PassWaited(r: Review) requires Starts(r, Pass) ensures r.now >= r.since + SETTLE {}

  // ---- Progress ----

  // Time passing changes nothing but the clock.
  lemma TickOnlyMovesTime(r: Review) ensures Step(r, Tick) == r.(now := r.now + 1) {}
  function Later(r: Review, n: nat): Review { r.(now := r.now + n) }   // what n Ticks leave

  // A push of new changes, with nobody building and no run going, is reviewed by the first pass SETTLE later.
  lemma NewPushGetsReviewed(r: Review, c: nat)
    requires Free(r) && !r.held && c != r.ch && r.reviewed != Some(c)
    ensures Step(Later(Step(r, Push(c)), SETTLE), Pass).active == Some(Run(c))
  {}

  // T4: work submitted while held is reviewed by the first settled pass after the item leaves In progress.
  lemma HeldWorkReviewedOnRelease(r: Review, c: nat)
    requires Free(r) && r.held && c != r.ch && r.reviewed != Some(c)
    ensures Step(Later(Step(Step(r, Submit(c)), Hold(false)), SETTLE), Pass).active == Some(Run(c))
  {}

  // ---- The waste the run records showed, as traces that now start nothing ----

  // 1. Merging the base in leaves the branch's changes as they were.
  lemma BaseMergeStartsNothing() {
    var r := Run_(Fresh(1), [Submit(1)]);
    assert r.active == Some(Run(1));
    var done := Step(r, Report(1));
    assert done.active.None? && done.reviewed == Some(1);
    var merged := Step(done, Push(1));
    assert merged == done;
    assert !Starts(Later(merged, SETTLE), Pass);
  }

  // 2. A burst of pushes is one run, on the last one.
  lemma BurstIsOneRun() {
    var r := Fresh(0).(reviewed := Some(0));
    var b := Run_(r, [Push(1), Tick, Tick, Pass, Push(2), Tick, Tick, Pass, Push(3)]);
    assert b.active.None? && b.owed && b.ch == 3;
  }

  // 4. A resubmit at the tip just reviewed.
  lemma ResubmitStartsNothing() {
    var done := Fresh(1).(reviewed := Some(1));
    assert !Starts(done, Submit(1));
    assert Starts(done, Manual);
  }

  // 5. A builder still pushing.
  lemma BuilderPushesStartNothing() {
    var r := Fresh(0).(reviewed := Some(0), held := true);
    var b := Run_(r, [Submit(1), Push(2), Tick, Tick, Tick, Tick, Tick, Pass, Push(3), Pass]);
    assert b.active.None?;
  }
}
