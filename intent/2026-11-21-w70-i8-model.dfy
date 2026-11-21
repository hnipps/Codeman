// W-70 I8 revision 2: which items Approve of session S's review closes.
// One item, the writes that change who it waits on, and the session that made each one.
// Companion to 2026-11-18-w70-lifecycle.dfy, which models statuses and releases but not session identity.
module W70I8 {
  type Sid = nat
  datatype Option<T> = None | Some(value: T)
  datatype Status = Backlog | NeedsRefinement | HumanRequired | Ready | InProgress | Done
  datatype Assignee = Nobody | Person | Session(id: Sid)
  datatype Asker = AskedBy(id: Sid) | AskedByServer

  // newestRelease: the newest history line is `Released: session <id> ...` (work.ts applyRelease logs it last).
  // lastActing, lastWasActing: model-only, what the trace says. An acting write changes status, assignee or question.
  datatype Item = Item(
    status: Status,
    assignee: Assignee,
    needs: Option<Asker>,
    sessions: set<Sid>,
    pr: bool,
    newestRelease: Option<Sid>,
    lastActing: Option<Sid>,
    lastWasActing: bool
  )

  datatype Event =
    | Claim(x: Sid)          // a session picks it up from Ready (routine claim or an agent's update)
    | PersonTakes            // the person moves it to In progress for themselves
    | Ask(x: Sid)            // reportWork outcome ask by x (work.ts:808): Human required, x's question, assignee kept
    | SessionEnds(x: Sid)    // I2 release of an interactive session (work.ts releaseFor/applyRelease)
    | RunEnds(x: Sid)        // I2 release of a routine run: `Released: run ...`, its session unlinked
    | RequestChanges         // I6: Ready, no assignee, question cleared
    | Answer                 // the person answers: Needs refinement, question cleared
    | Comment                // a comment or any other logged write that changes none of the three
    | SetPr(x: Sid)
    | Link(x: Sid)

  predicate Closed(s: Status) { s == Done }
  function Back(it: Item): Status { if it.pr then HumanRequired else NeedsRefinement }

  // A refused write logs nothing and changes nothing.
  function Step(it: Item, e: Event): Item {
    match e
    case Claim(x) =>
      if it.status != Ready then it
      else it.(status := InProgress, assignee := Session(x), sessions := it.sessions + {x},
               newestRelease := None, lastActing := Some(x), lastWasActing := true)
    case PersonTakes =>
      if Closed(it.status) then it
      else it.(status := InProgress, assignee := Person, newestRelease := None, lastActing := None, lastWasActing := true)
    case Ask(x) =>
      if Closed(it.status) then it
      else it.(status := HumanRequired, needs := Some(AskedBy(x)), sessions := it.sessions + {x},
               newestRelease := None, lastActing := Some(x), lastWasActing := true)
    case SessionEnds(x) =>
      if it.status != InProgress || it.assignee != Session(x) then it
      else it.(status := Back(it), assignee := Nobody, needs := if it.pr then Some(AskedByServer) else it.needs,
               newestRelease := Some(x), lastActing := Some(x), lastWasActing := true)
    case RunEnds(x) =>
      if it.status != InProgress || it.assignee != Session(x) then it
      else it.(status := Back(it), assignee := Nobody, needs := if it.pr then Some(AskedByServer) else it.needs,
               sessions := it.sessions - {x}, newestRelease := None, lastActing := Some(x), lastWasActing := true)
    case RequestChanges =>
      if Closed(it.status) then it
      else it.(status := Ready, assignee := Nobody, needs := None, newestRelease := None,
               lastActing := None, lastWasActing := true)
    case Answer =>
      if it.needs.None? || Closed(it.status) then it
      else it.(status := NeedsRefinement, needs := None, newestRelease := None, lastActing := None, lastWasActing := true)
    case Comment => it.(newestRelease := None, lastWasActing := false)
    case SetPr(x) => it.(pr := true, newestRelease := None, lastWasActing := false)
    case Link(x) => it.(sessions := it.sessions + {x}, newestRelease := None, lastWasActing := false)
  }

  function Run(it: Item, tr: seq<Event>): Item decreases |tr| {
    if |tr| == 0 then it else Run(Step(it, tr[0]), tr[1..])
  }

  function Fresh(s: Status): Item { Item(s, Nobody, None, {}, false, None, None, true) }

  // The code: waitsOnSessionReview (work.ts).
  predicate WaitsOn(it: Item, s: Sid) {
    !Closed(it.status) && s in it.sessions &&
    ((it.status == InProgress && it.assignee == Session(s)) ||
     (it.status == HumanRequired && it.needs == Some(AskedBy(s))) ||
     it.newestRelease == Some(s))
  }

  // Revision 1, merged as 7f623c63: (a) was any In progress item.
  predicate Rev1(it: Item, s: Sid) {
    !Closed(it.status) && s in it.sessions &&
    (it.status == InProgress ||
     (it.status == HumanRequired && it.needs == Some(AskedBy(s))) ||
     it.newestRelease == Some(s))
  }

  predicate Inv(it: Item) {
    (it.assignee.Session? ==> it.assignee.id in it.sessions) &&
    (it.newestRelease.Some? ==> it.lastActing == it.newestRelease && it.lastWasActing) &&
    (it.status == InProgress && it.assignee.Session? ==> it.lastActing == Some(it.assignee.id)) &&
    (it.status == HumanRequired && it.needs.Some? && it.needs.value.AskedBy? ==> it.lastActing == Some(it.needs.value.id))
  }

  lemma FreshInv(s: Status) ensures Inv(Fresh(s)) {}

  lemma StepInv(it: Item, e: Event) requires Inv(it) ensures Inv(Step(it, e)) {}

  lemma RunInv(it: Item, tr: seq<Event>) requires Inv(it) ensures Inv(Run(it, tr)) decreases |tr| {
    if |tr| > 0 { StepInv(it, tr[0]); RunInv(Step(it, tr[0]), tr[1..]); }
  }

  // Soundness: Approve of S's review closes an item only if the last write that moved it was S's.
  lemma I8_ClosesOnlyWhatSLeftWaiting(start: Status, tr: seq<Event>, s: Sid)
    ensures WaitsOn(Run(Fresh(start), tr), s) ==> Run(Fresh(start), tr).lastActing == Some(s)
  {
    FreshInv(start); RunInv(Fresh(start), tr);
  }

  // Completeness: when the newest write is S's claim, question or exit, and S is still linked, it closes.
  lemma I8_ClosesWhatSJustLeft(start: Status, tr: seq<Event>, s: Sid)
    ensures var it := Run(Fresh(start), tr);
      !Closed(it.status) && s in it.sessions && it.lastActing == Some(s) && it.lastWasActing &&
      |tr| > 0 && tr[|tr| - 1] in {Claim(s), Ask(s), SessionEnds(s)} &&
      Run(Fresh(start), tr[..|tr| - 1]) != it
      ==> WaitsOn(it, s)
  {
    if |tr| > 0 { RunSplit(Fresh(start), tr[..|tr| - 1], tr[|tr| - 1]); assert tr == tr[..|tr| - 1] + [tr[|tr| - 1]]; }
  }

  lemma RunSplit(it: Item, a: seq<Event>, e: Event) ensures Run(it, a + [e]) == Step(Run(it, a), e) decreases |a| {
    if |a| > 0 { assert (a + [e])[1..] == a[1..] + [e]; RunSplit(Step(it, a[0]), a[1..], e); }
  }

  // Closing ends the wait: Done is closed, so a second Approve finds nothing.
  lemma I8_Idempotent(it: Item, s: Sid) ensures !WaitsOn(it.(status := Done), s) {}

  // ---- Revision 1's gaps, as counterexamples ----

  // Gap 1: S's work came back for changes and session 7 picked it up; revision 1 closes 7's live item.
  lemma Gap1_Rev1ClosesAnotherSessionsWork() {
    var tr := [Claim(1), RequestChanges, Claim(7)];
    var it := Run(Fresh(Ready), tr);
    assert it.status == InProgress && it.assignee == Session(7) && 1 in it.sessions;
    assert Rev1(it, 1) && it.lastActing == Some(7);
    assert !WaitsOn(it, 1);
  }

  // Gap 2: S ends while its pull request waits. The release asks Codeman's question, so revision 1's (c)
  // closes it while its "not closed" rule (a Human required item whose question someone else asked) keeps it.
  predicate Rev1NotClosedRule(it: Item, s: Sid) {
    it.status == HumanRequired && it.needs.Some? && it.needs != Some(AskedBy(s))
  }
  lemma Gap2_Rev1ContradictsItself() {
    var tr := [Claim(1), SetPr(1), SessionEnds(1)];
    var it := Run(Fresh(Ready), tr);
    assert it.newestRelease == Some(1) && it.needs == Some(AskedByServer);
    assert Rev1(it, 1) && Rev1NotClosedRule(it, 1);
    assert WaitsOn(it, 1);   // revision 2 says these close
  }

  // Gap 3 (a non-goal in revision 2): a routine run's release unlinks its session, so nothing ties the item to S.
  lemma Gap3_RunWorkIsOutOfReach() {
    var tr := [Claim(1), RunEnds(1)];
    var it := Run(Fresh(Ready), tr);
    assert it.lastActing == Some(1) && it.lastWasActing && !Closed(it.status);
    assert !WaitsOn(it, 1) && !Rev1(it, 1);
  }

  // Found by the model, kept on purpose: a comment after S's release keeps the item open (the release line is no
  // longer newest), while a comment after S's claim or question does not. Conservative, and what the spec says.
  lemma Note_CommentAfterReleaseKeepsItOpen() {
    var released := Run(Fresh(Ready), [Claim(1), SessionEnds(1)]);
    assert WaitsOn(released, 1);
    assert !WaitsOn(Step(released, Comment), 1);
    var asked := Run(Fresh(Ready), [Claim(1), Ask(1)]);
    assert WaitsOn(asked, 1) && WaitsOn(Step(asked, Comment), 1);
  }
}
