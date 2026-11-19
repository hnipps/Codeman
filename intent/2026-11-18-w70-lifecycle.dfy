// W-70 Work item lifecycle: a model of today's status machine and of the spec's changes.
// Spec: intent/2026-11-18-w70-in-progress-owner.md, section "Lifecycle". Code read on origin/master ce40f9af.
// One item at a time. Other items appear only as counts (open tickets). The model abstracts IDs, history text,
// ready-queue order, revisions and sessions other than the assignee. Verify with `dafny verify` (no axioms, no assume).
module W70Lifecycle {

  datatype Status = Backlog | NeedsRefinement | HumanRequired | Ready | InProgress | Done | NotDoing | Deleted
  // Who writes. In code a claim is written as the run's agent session (routine-runner.ts:251) and the W-70 release
  // pass is the server; both carry no quoted instruction.
  datatype Actor = Person | Agent | Routine | Server
  datatype Liveness = Live | Exited | Gone | Unknown
  datatype TaskState = Queued | Running | Waiting | Failed | Cancelled | Completed
  datatype Assignee = Nobody | APerson | Run(task: TaskState) | Interactive(state: Liveness)
  datatype Option<T> = None | Some(value: T)
  datatype Outcome = RDone | RSplit | RAsk | RContinue

  datatype Item = Item(
    status: Status, assignee: Assignee,
    openTickets: nat, ticketsTotal: nat, allTicketsDone: bool,   // items createdFrom this one
    hasPr: bool, changesPending: bool, needs: bool,
    cameFrom: Option<Status>,   // status it entered In progress from; None = created into it (spec I2)
    releases: nat,              // releases in a row since the last report or person's move (spec I4, read from history)
    claims: nat)                // routine claims since the last report or person's move (ghost counter for F2)

  datatype Path = Create | Edit | Answer | ReportDone | ReportAsk | Claim | RequestChanges | ApproveWork | ResyncDone
                | Release | ReleaseAsk | ParentDone | ParentAsk | SessionApprove
  datatype Node = Start | At(s: Status)
  datatype Edge = E(from: Node, to: Status, path: Path)

  const All: set<Status> := {Backlog, NeedsRefinement, HumanRequired, Ready, InProgress, Done, NotDoing, Deleted}
  lemma AllIsAll(s: Status) ensures s in All {}

  predicate Closed(s: Status) { s == Done || s == NotDoing || s == Deleted }          // work.ts:72
  predicate PersonOnlyExit(s: Status) { s == Backlog || s == Deleted }               // work.ts:484
  // work.ts:489-497 backlogRefusal: only an agent quoting the person's instruction may stand in for a person.
  predicate Refused(a: Actor, from: Status, to: Status, instruction: bool) {
    a != Person && PersonOnlyExit(from) && to != from
    && !(a == Agent && instruction) && !(from == Backlog && to == Deleted)
  }
  function Mover(a: Actor): Assignee { if a == Person then APerson else Interactive(Live) }
  function Reset(it: Item): Item { it.(releases := 0, claims := 0) }
  predicate Writer(a: Actor) { a == Person || a == Agent }   // route authors: human or agent (model.ts:8)

  // ---- Write paths. w70 = the spec's behaviour; false = today's code. ----

  // work.ts:570-604 createWork (status any but Deleted, default Backlog: work.ts:364). W-70 I1 assigns the creator.
  function CreateItem(a: Actor, s: Status, as_: Assignee, w70: bool): Option<Item> {
    if !Writer(a) || s == Deleted then None
    else
      var as2 := if w70 && s == InProgress && as_ == Nobody then Mover(a) else as_;
      Some(Item(s, as2, 0, 0, false, false, false, false, None, 0, 0))
  }

  // work.ts:618-662 updateWork, status and assignee parts. W-70 I1: moving an unassigned item in assigns the mover;
  // leaving one In progress with no owner is refused.
  function EditItem(a: Actor, it: Item, to: Status, newA: Option<Assignee>, instruction: bool, reason: bool, w70: bool): Option<Item> {
    if !Writer(a) then None
    else if to == Ready && it.status != Ready && it.needs then None                       // work.ts:642
    else if to == Deleted && it.status != Deleted && a == Agent && !reason then None       // work.ts:652
    else if to != it.status && Refused(a, it.status, to, instruction) then None           // work.ts:655
    else
      var moved := to != it.status;
      var as1 := if newA.Some? then newA.value else it.assignee;
      var ownerless := w70 && to == InProgress && as1 == Nobody && it.openTickets == 0;
      if ownerless && !moved then None                                                     // W-70 I1 refuse
      else
        var r := it.(status := to, assignee := if ownerless then Mover(a) else as1,
                     cameFrom := if moved && to == InProgress then Some(it.status) else it.cameFrom);
        Some(if moved && a == Person then Reset(r) else r)
  }

  // work.ts:636 an answered question sends Human required back to Needs refinement.
  function AnswerItem(a: Actor, it: Item): Option<Item> {
    if !Writer(a) || !it.needs then None
    else
      var r := it.(needs := false, status := if it.status == HumanRequired then NeedsRefinement else it.status);
      Some(if a == Person && r.status != it.status then Reset(r) else r)
  }

  // work.ts:733-812 reportWork: done/split -> Done, ask -> Human required, continue stays. A report resets I4.
  function ReportItem(a: Actor, it: Item, o: Outcome, instruction: bool): Option<Item> {
    if !Writer(a) then None
    else
      var to := if o == RContinue then it.status else if o == RAsk then HumanRequired else Done;
      if to != it.status && Refused(a, it.status, to, instruction) then None                // work.ts:747-750
      else Some(Reset(it.(status := to, needs := o == RAsk, changesPending := false)))
  }

  // routine-runner.ts:231-253 claim: an unassigned item still in the status the routine fired on goes In progress,
  // assigned to the run. Fire statuses are every status but Deleted (routines.ts). fixF2: refused after two releases.
  function ClaimItem(it: Item, fire: Status, w70: bool, fixF2: bool): Option<Item> {
    if fire == Deleted || it.status != fire || it.assignee != Nobody then None               // routine-runner.ts:241
    else if w70 && fixF2 && it.releases >= 2 then None
    else if it.status != InProgress && Refused(Routine, it.status, InProgress, false) then None
    else Some(it.(status := InProgress, assignee := Run(Queued), claims := it.claims + 1,
                  cameFrom := if it.status != InProgress then Some(it.status) else it.cameFrom))
  }

  // work.ts:816-835 requestChangesOnWork (a person's press on the Reviews page). W-70 I6 also unassigns.
  function RequestChangesItem(it: Item, w70: bool): Option<Item> {
    if Closed(it.status) then None
    else Some(Reset(it.(status := Ready, needs := false, changesPending := true,
                        assignee := if w70 then Nobody else it.assignee)))
  }

  // work.ts:838-855 approveWork (a person's Approve on a work review). Any status but Done goes to Done.
  function ApproveWorkItem(it: Item): Option<Item> {
    if it.status == Done then None
    else Some(Reset(it.(status := Done, needs := false, changesPending := false)))
  }

  // work-reviews.ts:136-137 sync: an open item whose work review already merged is marked Done by the server, written
  // as the review's owner (the person whose Approve recorded the merge). It runs after every write to an item with a PR.
  function ResyncItem(it: Item): Option<Item> {
    if Closed(it.status) then None
    else Some(Reset(it.(status := Done, needs := false, changesPending := false)))
  }

  // W-70 I8: Approve of a session review closes the In progress items that link its session.
  function SessionApproveItem(it: Item, w70: bool): Option<Item> {
    if !w70 || it.status != InProgress then None else Some(Reset(it.(status := Done)))
  }

  // ---- The W-70 release pass (I2, I3, I4, I7). ----

  predicate ActiveTask(t: TaskState) { t == Queued || t == Running || t == Waiting }
  predicate OwnerLive(it: Item) {
    match it.assignee
    case APerson => true
    case Run(t) => ActiveTask(t)
    case Interactive(l) => l == Live || l == Unknown
    case Nobody => it.openTickets > 0
  }
  // fixF1 (Verification finding F1): never release back into a closed status.
  function BackTo(c: Option<Status>, fixF1: bool): Status {
    if c.None? then NeedsRefinement
    else if fixF1 && Closed(c.value) then NeedsRefinement
    else c.value
  }
  predicate IsParent(it: Item) { it.assignee == Nobody && it.ticketsTotal > 0 }
  function ReleasePath(it: Item): Path {
    if IsParent(it) then (if it.allTicketsDone then ParentDone else ParentAsk)
    else if it.releases >= 1 || (it.hasPr && !it.changesPending) then ReleaseAsk
    else Release
  }
  function ReleaseFor(it: Item, fixF1: bool): Option<Item> {
    if it.status != InProgress || OwnerLive(it) then None
    else if IsParent(it) then
      Some(it.(status := if it.allTicketsDone then Done else HumanRequired, needs := it.needs || !it.allTicketsDone))
    else
      var to := if ReleasePath(it) == ReleaseAsk then HumanRequired else BackTo(it.cameFrom, fixF1);
      Some(it.(status := to, assignee := Nobody, releases := it.releases + 1, needs := it.needs || to == HumanRequired))
  }

  // ---- Environment: facts change without a write to the item. ----
  function TaskEnds(it: Item, t: TaskState): Item { if it.assignee.Run? then it.(assignee := Run(t)) else it }
  function SessionBecomes(it: Item, l: Liveness): Item { if it.assignee.Interactive? then it.(assignee := Interactive(l)) else it }
  function TicketCloses(it: Item, done: bool): Item
    requires it.openTickets > 0
  { it.(openTickets := it.openTickets - 1, allTicketsDone := if it.openTickets == 1 then it.allTicketsDone && done else it.allTicketsDone) }

  // ======================================================================================================
  // Edge sets. Model edges are defined from the write paths; the Diagram* literals are generated from the spec's
  // Mermaid blocks (scripted check, see the spec) and proved equal to them.
  // ======================================================================================================

  function ModelToday(): set<Edge> {
    (set t | t in All && t != Deleted :: E(Start, t, Create))
    + (set f, t | f in All && t in All && f != t :: E(At(f), t, Edit))
    + {E(At(HumanRequired), NeedsRefinement, Answer)}
    + (set f | f in All && f != Done :: E(At(f), Done, ReportDone))
    + (set f | f in All && f != HumanRequired :: E(At(f), HumanRequired, ReportAsk))
    + (set f | f in All && f != Deleted && f != Backlog && f != InProgress :: E(At(f), InProgress, Claim))
    + (set f | f in All && !Closed(f) && f != Ready :: E(At(f), Ready, RequestChanges))
    + (set f | f in All && f != Done :: E(At(f), Done, ApproveWork))
    + (set f | f in All && !Closed(f) :: E(At(f), Done, ResyncDone))
  }
  function ReleaseTargets(fixF1: bool): set<Status> {
    if fixF1 then {Backlog, NeedsRefinement, HumanRequired, Ready}
    else {Backlog, NeedsRefinement, HumanRequired, Ready, Done, NotDoing, Deleted}
  }
  function ModelW70New(fixF1: bool): set<Edge> {
    (set t | t in ReleaseTargets(fixF1) :: E(At(InProgress), t, Release))
    + {E(At(InProgress), HumanRequired, ReleaseAsk), E(At(InProgress), Done, ParentDone),
       E(At(InProgress), HumanRequired, ParentAsk), E(At(InProgress), Done, SessionApprove)}
  }
  function ModelW70(fixF1: bool): set<Edge> { ModelToday() + ModelW70New(fixF1) }

  const DiagramToday: set<Edge> :=
    {E(At(Backlog), Deleted, Edit), E(At(Backlog), Done, ApproveWork), E(At(Backlog), Done, Edit), E(At(Backlog), Done, ReportDone), E(At(Backlog), Done, ResyncDone), E(At(Backlog), HumanRequired, Edit), E(At(Backlog), HumanRequired, ReportAsk), E(At(Backlog), InProgress, Edit), E(At(Backlog), NeedsRefinement, Edit), E(At(Backlog), NotDoing, Edit), E(At(Backlog), Ready, Edit), E(At(Backlog), Ready, RequestChanges), E(At(Deleted), Backlog, Edit), E(At(Deleted), Done, ApproveWork), E(At(Deleted), Done, Edit), E(At(Deleted), Done, ReportDone), E(At(Deleted), HumanRequired, Edit), E(At(Deleted), HumanRequired, ReportAsk), E(At(Deleted), InProgress, Edit), E(At(Deleted), NeedsRefinement, Edit), E(At(Deleted), NotDoing, Edit), E(At(Deleted), Ready, Edit), E(At(Done), Backlog, Edit), E(At(Done), Deleted, Edit), E(At(Done), HumanRequired, Edit), E(At(Done), HumanRequired, ReportAsk), E(At(Done), InProgress, Claim), E(At(Done), InProgress, Edit), E(At(Done), NeedsRefinement, Edit), E(At(Done), NotDoing, Edit), E(At(Done), Ready, Edit), E(At(HumanRequired), Backlog, Edit), E(At(HumanRequired), Deleted, Edit), E(At(HumanRequired), Done, ApproveWork), E(At(HumanRequired), Done, Edit), E(At(HumanRequired), Done, ReportDone), E(At(HumanRequired), Done, ResyncDone), E(At(HumanRequired), InProgress, Claim), E(At(HumanRequired), InProgress, Edit), E(At(HumanRequired), NeedsRefinement, Answer), E(At(HumanRequired), NeedsRefinement, Edit), E(At(HumanRequired), NotDoing, Edit), E(At(HumanRequired), Ready, Edit), E(At(HumanRequired), Ready, RequestChanges), E(At(InProgress), Backlog, Edit), E(At(InProgress), Deleted, Edit), E(At(InProgress), Done, ApproveWork), E(At(InProgress), Done, Edit), E(At(InProgress), Done, ReportDone), E(At(InProgress), Done, ResyncDone), E(At(InProgress), HumanRequired, Edit), E(At(InProgress), HumanRequired, ReportAsk), E(At(InProgress), NeedsRefinement, Edit), E(At(InProgress), NotDoing, Edit), E(At(InProgress), Ready, Edit), E(At(InProgress), Ready, RequestChanges), E(At(NeedsRefinement), Backlog, Edit), E(At(NeedsRefinement), Deleted, Edit), E(At(NeedsRefinement), Done, ApproveWork), E(At(NeedsRefinement), Done, Edit), E(At(NeedsRefinement), Done, ReportDone), E(At(NeedsRefinement), Done, ResyncDone), E(At(NeedsRefinement), HumanRequired, Edit), E(At(NeedsRefinement), HumanRequired, ReportAsk), E(At(NeedsRefinement), InProgress, Claim), E(At(NeedsRefinement), InProgress, Edit), E(At(NeedsRefinement), NotDoing, Edit), E(At(NeedsRefinement), Ready, Edit), E(At(NeedsRefinement), Ready, RequestChanges), E(At(NotDoing), Backlog, Edit), E(At(NotDoing), Deleted, Edit), E(At(NotDoing), Done, ApproveWork), E(At(NotDoing), Done, Edit), E(At(NotDoing), Done, ReportDone), E(At(NotDoing), HumanRequired, Edit), E(At(NotDoing), HumanRequired, ReportAsk), E(At(NotDoing), InProgress, Claim), E(At(NotDoing), InProgress, Edit), E(At(NotDoing), NeedsRefinement, Edit), E(At(NotDoing), Ready, Edit), E(At(Ready), Backlog, Edit), E(At(Ready), Deleted, Edit), E(At(Ready), Done, ApproveWork), E(At(Ready), Done, Edit), E(At(Ready), Done, ReportDone), E(At(Ready), Done, ResyncDone), E(At(Ready), HumanRequired, Edit), E(At(Ready), HumanRequired, ReportAsk), E(At(Ready), InProgress, Claim), E(At(Ready), InProgress, Edit), E(At(Ready), NeedsRefinement, Edit), E(At(Ready), NotDoing, Edit), E(Start, Backlog, Create), E(Start, Done, Create), E(Start, HumanRequired, Create), E(Start, InProgress, Create), E(Start, NeedsRefinement, Create), E(Start, NotDoing, Create), E(Start, Ready, Create)}
  
  const DiagramW70New: set<Edge> :=
    {E(At(InProgress), Backlog, Release), E(At(InProgress), Done, ParentDone), E(At(InProgress), Done, SessionApprove), E(At(InProgress), HumanRequired, ParentAsk), E(At(InProgress), HumanRequired, Release), E(At(InProgress), HumanRequired, ReleaseAsk), E(At(InProgress), NeedsRefinement, Release), E(At(InProgress), Ready, Release)}

  lemma DiagramTodayIsModel() ensures DiagramToday == ModelToday() {
  }
  lemma DiagramW70IsModel() ensures DiagramW70New == ModelW70New(true) && ModelToday() + DiagramW70New == ModelW70(true) {}

  // ---- Soundness: every status change a write path makes is an edge of the model. ----
  lemma SoundToday(a: Actor, it: Item, to: Status, s: Status, as_: Assignee, newA: Option<Assignee>, ins: bool, rsn: bool,
                   o: Outcome, fire: Status, w70: bool, fixF2: bool)
    ensures var r := CreateItem(a, s, as_, w70); r.Some? ==> E(Start, r.value.status, Create) in ModelToday()
    ensures var r := EditItem(a, it, to, newA, ins, rsn, w70); r.Some? && r.value.status != it.status ==> E(At(it.status), r.value.status, Edit) in ModelToday()
    ensures var r := AnswerItem(a, it); r.Some? && r.value.status != it.status ==> E(At(it.status), r.value.status, Answer) in ModelToday()
    ensures var r := ReportItem(a, it, o, ins); r.Some? && r.value.status != it.status ==>
              E(At(it.status), r.value.status, if o == RAsk then ReportAsk else ReportDone) in ModelToday()
    ensures var r := ClaimItem(it, fire, w70, fixF2); r.Some? && r.value.status != it.status ==> E(At(it.status), r.value.status, Claim) in ModelToday()
    ensures var r := RequestChangesItem(it, w70); r.Some? && r.value.status != it.status ==> E(At(it.status), r.value.status, RequestChanges) in ModelToday()
    ensures var r := ApproveWorkItem(it); r.Some? ==> E(At(it.status), r.value.status, ApproveWork) in ModelToday()
    ensures var r := ResyncItem(it); r.Some? ==> E(At(it.status), r.value.status, ResyncDone) in ModelToday()
  { AllIsAll(it.status); AllIsAll(to); AllIsAll(s); }

  lemma SoundW70(it: Item, fixF1: bool)
    requires it.cameFrom != Some(InProgress)   // part of Inv1
    ensures var r := ReleaseFor(it, fixF1); r.Some? ==> E(At(it.status), r.value.status, ReleasePath(it)) in ModelW70New(fixF1)
    ensures var r := SessionApproveItem(it, true); r.Some? ==> E(At(it.status), r.value.status, SessionApprove) in ModelW70New(fixF1)
  {
    var r := ReleaseFor(it, fixF1);
    if r.Some? && ReleasePath(it) == Release {
      var t := BackTo(it.cameFrom, fixF1);
      if it.cameFrom.Some? { AllIsAll(it.cameFrom.value); }
      assert t != InProgress;
      assert fixF1 ==> !Closed(t);
      assert t in ReleaseTargets(fixF1);
      assert E(At(InProgress), t, Release) in (set t | t in ReleaseTargets(fixF1) :: E(At(InProgress), t, Release));
    }
  }

  // ---- Completeness: every model edge is made by some write on some item (explicit witness). ----
  function Plain(s: Status): Item { Item(s, APerson, 0, 0, false, false, false, false, None, 0, 0) }
  function Dead(c: Option<Status>, releases: nat): Item {
    Item(InProgress, Run(Failed), 0, 0, false, false, false, false, c, releases, 1)
  }
  function Parent(allDone: bool): Item { Item(InProgress, Nobody, 0, 2, allDone, false, false, false, None, 0, 0) }
  function Witness(e: Edge, fixF1: bool): (Item, Option<Item>) {
    var f := if e.from.At? then e.from.s else Backlog;
    match e.path
    case Create => (Plain(e.to), CreateItem(Person, e.to, APerson, true))
    case Edit => (Plain(f), EditItem(Person, Plain(f), e.to, None, false, false, true))
    case Answer => (Plain(f).(needs := true), AnswerItem(Person, Plain(f).(needs := true)))
    case ReportDone => (Plain(f), ReportItem(Person, Plain(f), RDone, false))
    case ReportAsk => (Plain(f), ReportItem(Person, Plain(f), RAsk, false))
    case Claim => (Plain(f).(assignee := Nobody), ClaimItem(Plain(f).(assignee := Nobody), f, true, true))
    case RequestChanges => (Plain(f), RequestChangesItem(Plain(f), true))
    case ApproveWork => (Plain(f), ApproveWorkItem(Plain(f)))
    case ResyncDone => (Plain(f), ResyncItem(Plain(f)))
    case SessionApprove => (Plain(f), SessionApproveItem(Plain(f), true))
    case Release => (Dead(Some(e.to), 0), ReleaseFor(Dead(Some(e.to), 0), fixF1))
    case ReleaseAsk => (Dead(Some(Ready), 1), ReleaseFor(Dead(Some(Ready), 1), fixF1))
    case ParentDone => (Parent(true), ReleaseFor(Parent(true), fixF1))
    case ParentAsk => (Parent(false), ReleaseFor(Parent(false), fixF1))
  }
  lemma Complete(fixF1: bool)
    ensures forall e | e in ModelW70(fixF1) ::
      var (input, r) := Witness(e, fixF1);
      r.Some? && r.value.status == e.to && (e.from.At? ==> input.status == e.from.s)
  {}

  // ======================================================================================================
  // Properties
  // ======================================================================================================

  // I1 (as a state invariant): In progress has an owner, and an item never "came from" In progress.
  predicate Inv1(it: Item) {
    (it.status == InProgress ==> it.assignee != Nobody || it.openTickets > 0) && it.cameFrom != Some(InProgress)
  }
  lemma I1_EveryWritePreservesOwner(a: Actor, it: Item, to: Status, s: Status, as_: Assignee, newA: Option<Assignee>,
                                     ins: bool, rsn: bool, o: Outcome, fire: Status, fixF1: bool, fixF2: bool)
    requires Inv1(it)
    ensures var r := CreateItem(a, s, as_, true); r.Some? ==> Inv1(r.value)
    ensures var r := EditItem(a, it, to, newA, ins, rsn, true); r.Some? ==> Inv1(r.value)
    ensures var r := AnswerItem(a, it); r.Some? ==> Inv1(r.value)
    ensures var r := ReportItem(a, it, o, ins); r.Some? ==> Inv1(r.value)
    ensures var r := ClaimItem(it, fire, true, fixF2); r.Some? ==> Inv1(r.value)
    ensures var r := RequestChangesItem(it, true); r.Some? ==> Inv1(r.value)
    ensures var r := ApproveWorkItem(it); r.Some? ==> Inv1(r.value)
    ensures var r := ResyncItem(it); r.Some? ==> Inv1(r.value)
    ensures var r := SessionApproveItem(it, true); r.Some? ==> Inv1(r.value)
    ensures var r := ReleaseFor(it, fixF1); r.Some? ==> Inv1(r.value)
    ensures Inv1(TaskEnds(it, Failed)) && forall l :: Inv1(SessionBecomes(it, l))
  {}

  // Today's code does not keep I1: an unassigned create into In progress (W-56) is accepted.
  lemma I1_TodayCounterexample()
    ensures CreateItem(Agent, InProgress, Nobody, false).Some? && !Inv1(CreateItem(Agent, InProgress, Nobody, false).value)
  {}

  // F3: a ticket closing is a write to ANOTHER item, and it can leave a parent In progress with no owner.
  // The next tick's release always restores I1.
  lemma F3_TicketCloseBreaksI1()
    ensures var p := Item(InProgress, Nobody, 1, 1, true, false, false, false, None, 0, 0);
      Inv1(p) && !Inv1(TicketCloses(p, true))
  {}
  lemma F3_NextTickRestoresI1(it: Item, fixF1: bool)
    requires it.status == InProgress && it.assignee == Nobody && it.openTickets == 0 && it.cameFrom != Some(InProgress)
    ensures ReleaseFor(it, fixF1).Some? && Inv1(ReleaseFor(it, fixF1).value)
  {}

  // Only a person (or an agent quoting the person's instruction) moves an item out of Backlog or Deleted.
  // Deleting a Backlog item is not that move. Routines and the server never do it.
  predicate PersonOnlyOk(a: Actor, from: Status, to: Status, instruction: bool) {
    from == to || !PersonOnlyExit(from) || (from == Backlog && to == Deleted) || a == Person || (a == Agent && instruction)
  }
  lemma OnlyAPersonLeavesBacklogOrDeleted(a: Actor, it: Item, to: Status, newA: Option<Assignee>, ins: bool, rsn: bool,
                                          o: Outcome, fire: Status, w70: bool, fixF1: bool, fixF2: bool)
    ensures var r := EditItem(a, it, to, newA, ins, rsn, w70); r.Some? ==> PersonOnlyOk(a, it.status, r.value.status, ins)
    ensures var r := AnswerItem(a, it); r.Some? ==> PersonOnlyOk(a, it.status, r.value.status, false)
    ensures var r := ReportItem(a, it, o, ins); r.Some? ==> PersonOnlyOk(a, it.status, r.value.status, ins)
    ensures var r := ClaimItem(it, fire, w70, fixF2); r.Some? ==> PersonOnlyOk(Routine, it.status, r.value.status, false)
    ensures var r := ReleaseFor(it, fixF1); r.Some? ==> PersonOnlyOk(Server, it.status, r.value.status, false)
    // RequestChanges, ApproveWork and SessionApprove are a person's press on the Reviews page.
    ensures var r := RequestChangesItem(it, w70); r.Some? ==> PersonOnlyOk(Person, it.status, r.value.status, false)
    ensures var r := ApproveWorkItem(it); r.Some? ==> PersonOnlyOk(Person, it.status, r.value.status, false)
    // Resync moves Backlog to Done with no press now; it counts as the earlier Approve of the person it names.
    ensures var r := ResyncItem(it); r.Some? ==> PersonOnlyOk(Person, it.status, r.value.status, false)
    ensures var r := SessionApproveItem(it, w70); r.Some? ==> PersonOnlyOk(Person, it.status, r.value.status, false)
  {}

  // I3: a release never fires on a live owner.
  lemma I3_LiveOwnersAreNeverReleased(it: Item, fixF1: bool)
    ensures ReleaseFor(it, fixF1).Some? ==> !OwnerLive(it)
    ensures it.assignee == APerson ==> ReleaseFor(it, fixF1).None?
    ensures it.assignee.Run? && ActiveTask(it.assignee.task) ==> ReleaseFor(it, fixF1).None?
    ensures it.assignee in {Interactive(Live), Interactive(Unknown)} ==> ReleaseFor(it, fixF1).None?
    ensures it.assignee == Nobody && it.openTickets > 0 ==> ReleaseFor(it, fixF1).None?
  {}

  // I5: the release applied to its own output writes nothing more.
  lemma I5_ReleaseIsIdempotent(it: Item, fixF1: bool)
    requires it.cameFrom != Some(InProgress)
    ensures ReleaseFor(it, fixF1).Some? ==> ReleaseFor(ReleaseFor(it, fixF1).value, fixF1).None?
  {}

  // F1: as written, a release goes back to ANY status the item came from, so the server can re-delete a restored
  // item or re-close a reopened one. Reachable: a person restores a Deleted item straight into In progress for a
  // session, and that session exits. With the fix it goes to Needs refinement.
  lemma F1_ReleaseCanDelete()
    ensures var restored := EditItem(Person, Plain(Deleted), InProgress, Some(Interactive(Live)), false, false, true);
      restored.Some? &&
      var exited := SessionBecomes(restored.value, Exited);
      ReleaseFor(exited, false).Some? && ReleaseFor(exited, false).value.status == Deleted
      && ReleaseFor(exited, true).value.status == NeedsRefinement
  {}
  lemma F1_FixedReleaseNeverCloses(it: Item)
    requires it.cameFrom != Some(InProgress)
    ensures var r := ReleaseFor(it, true); r.Some? && r.value.status != Done ==> !Closed(r.value.status)
    ensures var r := ReleaseFor(it, true); r.Some? && r.value.status == Done ==> ReleasePath(it) == ParentDone
  {}

  // I4 (no run storm). The autonomous loop is: a routine claims, its task ends, the server releases; no report and
  // no person acts. With fixF2 every reachable state has at most two releases and at most two claims in a row.
  predicate InvAuto(it: Item) {
    it.releases <= 2 && it.claims <= 2
    && it.claims <= it.releases + (if it.assignee.Run? then 1 else 0)
    && (it.status == InProgress ==> it.releases <= 1)
    && it.cameFrom != Some(InProgress)
  }
  lemma I4_ResetStateIsInvAuto(it: Item)
    requires it.cameFrom != Some(InProgress) && !it.assignee.Run?
    ensures InvAuto(Reset(it))
  {}
  lemma I4_AutonomousStepsPreserveBound(it: Item, fire: Status, t: TaskState, l: Liveness, fixF1: bool)
    requires InvAuto(it)
    ensures var r := ClaimItem(it, fire, true, true); r.Some? ==> InvAuto(r.value)
    ensures var r := ReleaseFor(it, fixF1); r.Some? ==> InvAuto(r.value)
    ensures InvAuto(TaskEnds(it, t)) && InvAuto(SessionBecomes(it, l))
    ensures var r := ResyncItem(it); r.Some? ==> InvAuto(r.value)
    ensures it.openTickets > 0 ==> InvAuto(TicketCloses(it, true)) && InvAuto(TicketCloses(it, false))
  {}
  lemma I4_LaterReleasesNeverRequeue(it: Item, fixF1: bool)
    requires it.releases >= 1
    ensures var r := ReleaseFor(it, fixF1); r.Some? && !IsParent(it) ==> r.value.status == HumanRequired
  {}

  // F2: without the claim refusal, a routine that fires on Human required re-claims an item released twice, and
  // the loop runs again: a third run and a third release, and so on.
  lemma F2_StormWithoutFix()
    ensures var hr := Item(HumanRequired, Nobody, 0, 0, false, false, false, true, Some(Ready), 2, 2);
      var c := ClaimItem(hr, HumanRequired, true, false);
      c.Some? && ReleaseFor(TaskEnds(c.value, Failed), true).Some?
      && var back := ReleaseFor(TaskEnds(c.value, Failed), true).value;
      back.status == HumanRequired && back.releases == 3 && back.claims == 3 && back.assignee == Nobody
      && ClaimItem(back, HumanRequired, true, false).Some?
      && ClaimItem(hr, HumanRequired, true, true).None?
  {}
}
