// W-70 I8 revision 2: which items Approve of session S's review closes.
// One item, every kind of write that can change it, and who wrote each history line.
// Companion to 2026-11-18-w70-lifecycle.dfy, which models statuses and releases but not who wrote what.
module W70I8 {
  type Sid = nat
  datatype Option<T> = None | Some(value: T)
  datatype Status = Backlog | NeedsRefinement | HumanRequired | Ready | InProgress | Done | NotDoing | Deleted
  datatype Assignee = Nobody | Person | Session(id: Sid)
  datatype Asker = AskedBy(id: Sid) | AskedByServer
  datatype Actor = PersonActs | Agent(id: Sid)

  // newestBy: the author of the newest history line (work.ts log() stamps ctx.author on every line).
  // newestRelease: that line is `Released: session <id> ...` (applyRelease logs it last, authored by the session).
  // lines: how many lines were logged, so a write that logged something can be told from a refused one.
  datatype Item = Item(
    status: Status,
    assignee: Assignee,
    needs: Option<Asker>,
    sessions: set<Sid>,
    pr: bool,
    newestBy: Option<Actor>,
    newestRelease: Option<Sid>,
    lines: nat
  )

  datatype Event =
    | Claim(x: Sid)                          // updateWork by agent x: In progress, assigned to x, from any open status
    | Move(who: Actor, to: Status)            // updateWork status by anyone (setStatus): keeps needs and assignee
    | Assign(who: Actor, a: Assignee)         // updateWork assignee by anyone, any status; a session gets linked
    | Ask(x: Sid)                            // reportWork ask by x (work.ts:808): Human required, x's question
    | SessionEnds(x: Sid, dest: Status)      // I2 release of an interactive session, to where the item came from
    | RunEnds(x: Sid, dest: Status)          // I2 release of a routine run: `Released: run ...`, x unlinked
    | RequestChanges                         // I6, a person: Ready, no assignee, question cleared
    | Answer(who: Actor)                      // needs null: Needs refinement, question cleared
    | Comment(who: Actor)                     // commentWork logs `Commented`
    | SetPr(who: Actor)
    | Link(who: Actor, x: Sid)
    | Unlink(who: Actor, x: Sid)              // clears the assignee when it was x (work.ts updateWork)

  predicate Closed(s: Status) { s == Done || s == NotDoing || s == Deleted }

  function Log(it: Item, who: Actor): Item { it.(newestBy := Some(who), newestRelease := None, lines := it.lines + 1) }

  function Holder(who: Actor): Assignee { match who case PersonActs => Person case Agent(x) => Session(x) }

  // A refused write logs nothing and changes nothing.
  function Step(it: Item, e: Event): Item {
    match e
    case Claim(x) =>
      if Closed(it.status) || it.assignee.Person? || (it.assignee.Session? && it.assignee.id != x) then it
      else Log(it.(status := InProgress, assignee := Session(x), sessions := it.sessions + {x}), Agent(x))
    case Move(who, to) =>
      if to == it.status then it
      else
        // I1: entering In progress with nobody on it assigns the mover.
        var a := if to == InProgress && it.assignee == Nobody then Holder(who) else it.assignee;
        var linked := if a.Session? then it.sessions + {a.id} else it.sessions;
        Log(it.(status := to, assignee := a, sessions := linked), who)
    case Assign(who, a) =>
      if a == it.assignee || (it.status == InProgress && a == Nobody) then it
      else Log(it.(assignee := a, sessions := if a.Session? then it.sessions + {a.id} else it.sessions), who)
    case Ask(x) =>
      if Closed(it.status) then it
      else Log(it.(status := HumanRequired, needs := Some(AskedBy(x)), sessions := it.sessions + {x}), Agent(x))
    case SessionEnds(x, dest) =>
      if it.status != InProgress || it.assignee != Session(x) || dest == InProgress || Closed(dest) then it
      else
        var released := it.(status := if it.pr then HumanRequired else dest, assignee := Nobody,
                            needs := if it.pr then Some(AskedByServer) else it.needs);
        Log(released, Agent(x)).(newestRelease := Some(x))
    case RunEnds(x, dest) =>
      if it.status != InProgress || it.assignee != Session(x) || dest == InProgress || Closed(dest) then it
      else Log(it.(status := if it.pr then HumanRequired else dest, assignee := Nobody,
                   needs := if it.pr then Some(AskedByServer) else it.needs, sessions := it.sessions - {x}), Agent(x))
    case RequestChanges =>
      if Closed(it.status) then it
      else Log(it.(status := Ready, assignee := Nobody, needs := None), PersonActs)
    case Answer(who) =>
      if it.needs.None? || Closed(it.status) then it
      else Log(it.(status := if it.status == HumanRequired then NeedsRefinement else it.status, needs := None), who)
    case Comment(who) => Log(it, who)
    case SetPr(who) => Log(it.(pr := true), who)
    case Link(who, x) => if x in it.sessions then it else Log(it.(sessions := it.sessions + {x}), who)
    case Unlink(who, x) =>
      if x !in it.sessions then it
      else Log(it.(sessions := it.sessions - {x}, assignee := if it.assignee == Session(x) then Nobody else it.assignee), who)
  }

  function Run(it: Item, tr: seq<Event>): Item decreases |tr| {
    if |tr| == 0 then it else Run(Step(it, tr[0]), tr[1..])
  }

  // An item as a person files it.
  function Fresh(s: Status): Item { Item(s, Nobody, None, {}, false, Some(PersonActs), None, 1) }

  // The code: waitsOnSessionReview (work.ts).
  predicate WaitsOn(it: Item, s: Sid) {
    !Closed(it.status) && s in it.sessions && it.newestBy == Some(Agent(s)) &&
    ((it.status == InProgress && it.assignee == Session(s)) ||
     (it.status == HumanRequired && it.needs == Some(AskedBy(s))) ||
     it.newestRelease == Some(s))
  }

  // Revision 2 as first submitted: the same three cases on the current state alone.
  predicate StateOnly(it: Item, s: Sid) {
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

  function ActorOf(e: Event): Actor {
    match e
    case Claim(x) => Agent(x)
    case Move(who, _) => who
    case Assign(who, _) => who
    case Ask(x) => Agent(x)
    case SessionEnds(x, _) => Agent(x)
    case RunEnds(x, _) => Agent(x)
    case RequestChanges => PersonActs
    case Answer(who) => who
    case Comment(who) => who
    case SetPr(who) => who
    case Link(who, _) => who
    case Unlink(who, _) => who
  }

  predicate Inv(it: Item) {
    (it.assignee.Session? ==> it.assignee.id in it.sessions) &&
    (it.newestRelease.Some? ==> it.newestBy == Some(Agent(it.newestRelease.value))) &&
    it.newestBy.Some?
  }

  lemma FreshInv(s: Status) ensures Inv(Fresh(s)) {}
  lemma StepInv(it: Item, e: Event) requires Inv(it) ensures Inv(Step(it, e)) {}
  lemma RunInv(it: Item, tr: seq<Event>) requires Inv(it) ensures Inv(Run(it, tr)) decreases |tr| {
    if |tr| > 0 { StepInv(it, tr[0]); RunInv(Step(it, tr[0]), tr[1..]); }
  }

  // Every write that changes anything logs a line, signed by whoever made it. So the state an item is in was left by
  // the author of its newest line: nothing changes an item without becoming its newest line.
  lemma EveryChangeIsSigned(it: Item, e: Event)
    ensures Step(it, e) != it ==> Step(it, e).lines == it.lines + 1 && Step(it, e).newestBy == Some(ActorOf(e))
  {}

  // Soundness: a write by anyone but S, after whatever S did, means Approve of S's review leaves the item alone.
  lemma I8_AnyOtherWriteKeepsItOpen(it: Item, e: Event, s: Sid)
    requires ActorOf(e) != Agent(s) && Step(it, e) != it
    ensures !WaitsOn(Step(it, e), s)
  {
    EveryChangeIsSigned(it, e);
  }

  // So whenever Approve closes an item, the newest write was S's, and the state is the one S's write left.
  lemma I8_ClosesOnlyWhatSLeft(start: Status, tr: seq<Event>, s: Sid)
    ensures WaitsOn(Run(Fresh(start), tr), s) ==> Run(Fresh(start), tr).newestBy == Some(Agent(s))
  {}

  // Completeness: S's claim, question or exit, if it took effect, leaves the item waiting on S's review.
  lemma I8_ClosesWhatSJustLeft(it: Item, s: Sid, e: Event)
    requires Inv(it) && e in {Claim(s), Ask(s)} + (set d: Status | true :: SessionEnds(s, d)) && Step(it, e) != it
    ensures WaitsOn(Step(it, e), s)
  {}

  // Closing ends the wait: Done is closed, so a second Approve finds nothing.
  lemma I8_Idempotent(it: Item, s: Sid) ensures !WaitsOn(it.(status := Done), s) {}

  // ---- What the verifier found in revision 2 as first submitted: the state alone closed these ----

  // P1: S asks, then the person takes the item. S's question stays on it.
  lemma P1_PersonTakesAskedItem() {
    var it := Run(Fresh(Ready), [Claim(1), Ask(1), Assign(PersonActs, Person)]);
    assert it.status == HumanRequired && it.needs == Some(AskedBy(1));
    assert StateOnly(it, 1) && !WaitsOn(it, 1);
  }

  // P2: S asks, then session 7 moves the item to In progress and back. S's question and assignee stay.
  lemma P2_OtherSessionMovesItBackAndForth() {
    var it := Run(Fresh(Ready), [Claim(1), Ask(1), Move(Agent(7), InProgress), Move(Agent(7), HumanRequired)]);
    assert it.needs == Some(AskedBy(1));
    assert StateOnly(it, 1) && !WaitsOn(it, 1);
  }

  // P3: S asks, then the person parks it in Backlog and brings it back without answering.
  lemma P3_PersonParksAndReturnsIt() {
    var it := Run(Fresh(Ready), [Claim(1), Ask(1), Move(PersonActs, Backlog), Move(PersonActs, HumanRequired)]);
    assert StateOnly(it, 1) && !WaitsOn(it, 1);
  }

  // The person puts S on an item In progress; S never writes to it. It stays open until S does.
  lemma AssignedButUntouched() {
    var it := Run(Fresh(Ready), [Assign(PersonActs, Session(1)), Move(PersonActs, InProgress)]);
    assert it.assignee == Session(1) && it.status == InProgress;
    assert StateOnly(it, 1) && !WaitsOn(it, 1);
  }

  // ---- Revision 1's gaps, as counterexamples ----

  // Gap 1: S's work came back for changes and session 7 picked it up; revision 1 closes 7's live item.
  lemma Gap1_Rev1ClosesAnotherSessionsWork() {
    var it := Run(Fresh(Ready), [Claim(1), RequestChanges, Claim(7)]);
    assert it.status == InProgress && it.assignee == Session(7) && 1 in it.sessions;
    assert Rev1(it, 1) && !WaitsOn(it, 1);
  }

  // Gap 2: S ends while its pull request waits. The release asks Codeman's question, so revision 1's (c)
  // closes it while its "not closed" rule (a Human required item whose question someone else asked) keeps it.
  predicate Rev1NotClosedRule(it: Item, s: Sid) {
    it.status == HumanRequired && it.needs.Some? && it.needs != Some(AskedBy(s))
  }
  lemma Gap2_Rev1ContradictsItself() {
    var it := Run(Fresh(Ready), [Claim(1), SetPr(Agent(1)), SessionEnds(1, Ready)]);
    assert it.newestRelease == Some(1) && it.needs == Some(AskedByServer);
    assert Rev1(it, 1) && Rev1NotClosedRule(it, 1);
    assert WaitsOn(it, 1);   // revision 2 says these close
  }

  // Gap 3 (a non-goal in revision 2): a routine run's release unlinks its session, so nothing ties the item to S.
  lemma Gap3_RunWorkIsOutOfReach() {
    var it := Run(Fresh(Ready), [Claim(1), RunEnds(1, Ready)]);
    assert it.newestBy == Some(Agent(1)) && !Closed(it.status);
    assert !WaitsOn(it, 1) && !Rev1(it, 1);
  }

  // Now one rule for all three cases: a comment by anyone else, after S's claim, question or release, keeps it open.
  lemma CommentAfterAnyOfThemKeepsItOpen() {
    var claimed := Run(Fresh(Ready), [Claim(1)]);
    var asked := Run(Fresh(Ready), [Claim(1), Ask(1)]);
    var released := Run(Fresh(Ready), [Claim(1), SessionEnds(1, Ready)]);
    assert WaitsOn(claimed, 1) && WaitsOn(asked, 1) && WaitsOn(released, 1);
    assert !WaitsOn(Step(claimed, Comment(PersonActs)), 1);
    assert !WaitsOn(Step(asked, Comment(PersonActs)), 1);
    assert !WaitsOn(Step(released, Comment(PersonActs)), 1);
  }
}
