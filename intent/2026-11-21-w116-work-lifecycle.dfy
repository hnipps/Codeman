// W-116 Work lifecycle: Blocked with dependencies, real tickets, no person In progress, ended assignees outside
// In progress, and Approve of a spec review filing its tickets (W-68).
// Spec: intent/2026-11-21-w116-work-lifecycle.md. Code read on origin/master bb31d4dc.
//
// A MULTI-ITEM model. The board is a map of items. The server's tick decides every item from one snapshot of the
// board and writes each changed item once, as RoutineRunner.release() does (it reads work.json once, then makes one
// guarded changeWork() per item). Dependency release and parent closing read OTHER items, which is why the two
// single-item models (2026-11-18-w70-lifecycle.dfy, 2026-11-21-w70-i8-model.dfy) cannot express them. Both stay as
// they are; this model restates the W-70 invariants it keeps (I1 to I8) over the whole board and proves them again.
//
// Abstracted: history text (the newest line's author and whether it is a session's own `Released: session S` line
// are kept, as in the I8 model), ready-queue order, revisions and expectedRevision races, requested changes, comments
// other than their author, and the 50-line history cap. Server writes are written as the canvas owner in the code; the
// model names that author Server so the I8 lemmas can tell it from a session. Verify with `dafny verify` (no axioms,
// no assume).
module W116 {
  type Id = nat
  type Sid = nat
  datatype Option<T> = None | Some(value: T)
  datatype Status = Backlog | NeedsRefinement | HumanRequired | Ready | Blocked | InProgress | Done | NotDoing | Deleted
  // run: the session of a routine run (its release unlinks it and writes `Released: run ...`).
  datatype Assignee = Nobody | Person | Session(sid: Sid, run: bool)
  datatype Actor = PersonActs | Agent(sid: Sid) | Server
  datatype Asker = AskedBy(sid: Sid) | AskedByServer
  datatype Liveness = Live | Ended | Unknown
  datatype Outcome = RDone | RAsk | RContinue

  datatype Item = Item(
    status: Status, assignee: Assignee, needs: Option<Asker>, sessions: set<Sid>,
    createdFrom: Option<Id>,   // provenance only (W-116): never makes an item a ticket
    ticketOf: Option<Id>,      // the parent this item is a ticket of (W-116)
    deps: set<Id>,             // dependsOn (W-116)
    merged: bool,              // a merge of the item's work is recorded (W-116)
    hasPr: bool, filed: bool,  // filed: this item's spec tickets were filed (W-68)
    cameFrom: Option<Status>,  // the status it entered In progress from (W-70 I2)
    releases: nat,             // `Released:` lines in a row since a report or a person's move (W-70 I4)
    claims: nat,               // ghost: routine claims in a row (W-70 F2)
    newestBy: Actor,           // author of the newest history line (W-70 I8)
    newestRelease: Option<Sid>,// that line is the session's own `Released: session S ...` line
    followed: bool)            // a parent: it already followed its tickets since one was last open (W-116 I7)

  datatype Board = Board(items: map<Id, Item>, next: Id)

  predicate Closed(s: Status) { s == Done || s == NotDoing || s == Deleted }

  // ---------------------------------------------------------------------------------------------------------------
  // Dependencies as a graph, and the cycle check `SetDeps` runs at write time.
  // ---------------------------------------------------------------------------------------------------------------

  // The graph the cycle check runs on: an item points at what it depends on AND at its own tickets, since a parent
  // waits on its tickets. A ticket that depends on its parent, at any depth, is a cycle here.
  ghost function TicketsOf(m: map<Id, Item>, p: Id): set<Id> { set t | t in m && m[t].ticketOf == Some(p) }
  ghost function Deps(m: map<Id, Item>): map<Id, set<Id>> { map i | i in m :: m[i].deps + TicketsOf(m, i) }

  least predicate Reach(g: map<Id, set<Id>>, a: Id, c: Id) {
    a in g && (c in g[a] || exists k :: k in g[a] && Reach(g, k, c))
  }
  ghost predicate Acyclic(g: map<Id, set<Id>>) { forall x :: !Reach(g, x, x) }
  ghost predicate EdgesInDom(g: map<Id, set<Id>>) { forall a, d :: a in g && d in g[a] ==> d in g }

  least lemma ReachTrans(g: map<Id, set<Id>>, a: Id, b: Id)
    requires Reach(g, a, b)
    ensures forall c :: Reach(g, b, c) ==> Reach(g, a, c)
  {
    if b in g[a] {
    } else {
      var k :| k in g[a] && Reach(g, k, b);
      ReachTrans(g, k, b);
    }
  }

  least lemma ReachEndsInDom(g: map<Id, set<Id>>, a: Id, c: Id)
    requires Reach(g, a, c) && EdgesInDom(g)
    ensures c in g
  {
    if c !in g[a] {
      var k :| k in g[a] && Reach(g, k, c);
      ReachEndsInDom(g, k, c);
    }
  }

  lemma ReachStep(g: map<Id, set<Id>>, a: Id, k: Id, c: Id)
    requires a in g && k in g[a] && (k == c || Reach(g, k, c))
    ensures Reach(g, a, c)
  {}

  // A path in g[x := D] either avoids x's new edges, or reaches x in g and continues from some d in D.
  ghost predicate UpdPost(g: map<Id, set<Id>>, x: Id, D: set<Id>, a: Id, c: Id) {
    Reach(g, a, c) || ((a == x || Reach(g, a, x)) && exists d :: d in D && (d == c || Reach(g, d, c)))
  }
  lemma UpdStep(g: map<Id, set<Id>>, x: Id, D: set<Id>, a: Id, k: Id, c: Id)
    requires a != x && a in g && k in g[a] && UpdPost(g, x, D, k, c)
    ensures UpdPost(g, x, D, a, c)
  {
    if Reach(g, k, c) { ReachStep(g, a, k, c); } else { ReachStep(g, a, k, x); }
  }
  // By induction on the path (a least lemma). Inside a least lemma body Dafny reads Reach as its prefix predicate,
  // so the case split lives in UpdStep.
  least lemma ReachUpdate(g: map<Id, set<Id>>, x: Id, D: set<Id>, a: Id, c: Id)
    requires Reach(g[x := D], a, c)
    ensures UpdPost(g, x, D, a, c)
  {
    var h := g[x := D];
    if c in h[a] {
      if a == x { assert c in D; } else { ReachStep(g, a, c, c); }
    } else {
      var k :| k in h[a] && Reach(h, k, c);
      ReachUpdate(g, x, D, k, c);
      if a != x { UpdStep(g, x, D, a, k, c); }
    }
  }

  // The write-time check keeps the graph acyclic: no new dependency d of x may reach x.
  lemma UpdateKeepsAcyclic(g: map<Id, set<Id>>, x: Id, D: set<Id>)
    requires Acyclic(g)
    requires forall d :: d in D ==> d != x && !Reach(g, d, x)
    ensures Acyclic(g[x := D])
  {
    forall y | Reach(g[x := D], y, y) ensures false {
      ReachUpdate(g, x, D, y, y);
      if !Reach(g, y, y) {
        var d :| d in D && (d == y || Reach(g, d, y));
        if y == x {
        } else {
          assert Reach(g, y, x);
          if d == y { } else { ReachTrans(g, d, y); }
        }
      }
    }
  }

  // A fresh item has no incoming edges, so any dependencies it starts with keep the graph acyclic.
  lemma FreshKeepsAcyclic(g: map<Id, set<Id>>, x: Id, D: set<Id>)
    requires Acyclic(g) && EdgesInDom(g) && x !in g && D <= g.Keys
    ensures Acyclic(g[x := D]) && EdgesInDom(g[x := D])
  {
    forall d | d in D ensures d != x && !Reach(g, d, x) {
      if Reach(g, d, x) { ReachEndsInDom(g, d, x); }
    }
    UpdateKeepsAcyclic(g, x, D);
  }

  lemma AcyclicNoSelfDep(g: map<Id, set<Id>>, x: Id)
    requires Acyclic(g) && x in g
    ensures x !in g[x]
  {
    if x in g[x] { assert Reach(g, x, x); }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Reading other items: tickets, dependencies, and what a session's review is waiting on.
  // ---------------------------------------------------------------------------------------------------------------

  ghost predicate IsTicketOf(m: map<Id, Item>, t: Id, p: Id) { t in m && m[t].ticketOf == Some(p) }
  ghost predicate HasTickets(m: map<Id, Item>, p: Id) { exists t :: IsTicketOf(m, t, p) }
  ghost predicate OpenTicket(m: map<Id, Item>, p: Id) { exists t :: IsTicketOf(m, t, p) && !Closed(m[t].status) }
  ghost predicate AllTicketsDone(m: map<Id, Item>, p: Id) { forall t :: IsTicketOf(m, t, p) ==> m[t].status == Done }
  ghost predicate AllTicketsMerged(m: map<Id, Item>, p: Id) { forall t :: IsTicketOf(m, t, p) ==> m[t].merged }
  // The rule before W-116 (`openTickets()` on `createdFrom`): every item created from p held it open.
  ghost predicate OpenCreatedFrom(m: map<Id, Item>, p: Id) {
    exists t :: t in m && m[t].createdFrom == Some(p) && !Closed(m[t].status)
  }

  // A dependency is satisfied when it is Done AND a merge of its work is recorded.
  ghost predicate Satisfied(m: map<Id, Item>, d: Id) { d in m && m[d].status == Done && m[d].merged }
  ghost predicate SatisfiedAll(m: map<Id, Item>, D: set<Id>) { forall d :: d in D ==> Satisfied(m, d) }
  // Given up: Not doing, Deleted, or Done with neither a merge nor a pull request that could still merge.
  ghost predicate GivenUp(m: map<Id, Item>, d: Id) {
    d in m && (m[d].status == NotDoing || m[d].status == Deleted || (m[d].status == Done && !m[d].merged && !m[d].hasPr))
  }
  ghost predicate AnyGivenUp(m: map<Id, Item>, D: set<Id>) { exists d :: d in D && GivenUp(m, d) }

  // W-70 I8 revision 2 (waitsOnSessionReview), plus W-116: an item its open tickets own is never closed by it.
  ghost predicate WaitsOn(m: map<Id, Item>, x: Id, s: Sid) {
    x in m && !Closed(m[x].status) && s in m[x].sessions && m[x].newestBy == Agent(s) && !OpenTicket(m, x) &&
    ((m[x].status == InProgress && m[x].assignee.Session? && m[x].assignee.sid == s) ||
     (m[x].status == HumanRequired && m[x].needs == Some(AskedBy(s))) ||
     m[x].newestRelease == Some(s))
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Item bookkeeping shared by every write.
  // ---------------------------------------------------------------------------------------------------------------

  // Every write logs a line signed by its author; only a session's own release marks it `Released: session S`.
  function Log(it: Item, who: Actor): Item { it.(newestBy := who, newestRelease := None) }
  // setStatus(): records where an item entered In progress from, and leaving Done drops the merge record.
  function Mv(it: Item, to: Status): Item {
    it.(status := to,
        cameFrom := if to == InProgress && it.status != InProgress then Some(it.status) else it.cameFrom,
        merged := if it.status == Done && to != Done then false else it.merged)
  }
  // A report, or a move written as a person (the server writes as the canvas owner), restarts the I4 count.
  function Reset(it: Item): Item { it.(releases := 0, claims := 0) }
  function Holder(a: Actor): Assignee { if a.Agent? then Session(a.sid, false) else Nobody }
  function Link(it: Item, a: Assignee): Item { if a.Session? then it.(sessions := it.sessions + {a.sid}) else it }
  function AskOf(it: Item): Option<Asker> { if it.needs.Some? then it.needs else Some(AskedByServer) }

  // Only a person moves an item out of Backlog or Deleted, and (W-116) out of Blocked into Ready for work or In
  // progress; an agent may when it quotes the person. Deleting a Backlog item is not that move.
  predicate Refused(a: Actor, from: Status, to: Status, instr: bool) {
    a.Agent? && !instr && from != to &&
    ((from == Backlog && to != Deleted) || from == Deleted || (from == Blocked && (to == Ready || to == InProgress)))
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Write paths. Each returns None when refused.
  // ---------------------------------------------------------------------------------------------------------------

  // createWork. An item is never created Deleted. W-116: Blocked needs dependencies and no assignee; Ready never
  // holds the person, and an agent creates into Ready only with every dependency satisfied (or the person's words);
  // In progress never holds the person, and an unassigned create into it assigns the creating agent (I1).
  ghost function Create(b: Board, a: Actor, s: Status, as_: Assignee, tOf: Option<Id>, cf: Option<Id>, D: set<Id>,
                        instr: bool): Option<Board> {
    var m := b.items;
    if a == Server || s == Deleted || !(D <= m.Keys) || b.next in m then None
    else if tOf.Some? && tOf.value !in m then None
    else if cf.Some? && cf.value !in m then None
    else if tOf.Some? && (tOf.value in D || exists d :: d in D && Reach(Deps(m), d, tOf.value)) then None
    else if s == Blocked && (D == {} || as_ != Nobody) then None
    else if s == Ready && as_ == Person then None
    else if s == Ready && a.Agent? && !instr && !SatisfiedAll(m, D) then None
    else if s == InProgress && (as_ == Person || (as_ == Nobody && !a.Agent?)) then None
    else
      var as2 := if s == InProgress && as_ == Nobody then Holder(a) else as_;
      var it := Item(s, as2, None, {}, cf, tOf, D, false, false, false, None, 0, 0, a, None, false);
      Some(Board(m[b.next := Link(it, as2)], b.next + 1))
  }

  // updateWork, status and assignee. `named` is the assignee the same write names, if any.
  ghost function Edit(b: Board, a: Actor, x: Id, to: Status, named: Option<Assignee>, instr: bool, reason: bool)
    : Option<Board>
  {
    if a == Server || x !in b.items then None
    else
      var m := b.items;
      var it := m[x];
      var moved := to != it.status;
      if moved && Refused(a, it.status, to, instr) then None
      else if moved && to == Ready && it.needs.Some? then None
      else if moved && to == Blocked && (it.needs.Some? || it.deps == {}) then None
      else if moved && to == Ready && a.Agent? && !instr && !SatisfiedAll(m, it.deps) then None
      else if moved && to == Deleted && a.Agent? && !reason then None
      else if (to == Ready || to == Blocked) && named == Some(Person) then None
      else if to == Blocked && named.Some? && named.value != Nobody then None
      else
        // W-116: entering Ready for work clears the assignee unless the same write names a session (generalises I6);
        // entering Blocked clears it.
        var as1 :=
          if moved && to == Ready then (if named.Some? && named.value.Session? then named.value else Nobody)
          else if moved && to == Blocked then Nobody
          else if named.Some? then named.value else it.assignee;
        if to == InProgress && as1 == Person then None        // W-116: no person In progress
        else
          var ownerless := to == InProgress && as1 == Nobody && !OpenTicket(m, x);
          if ownerless && !(moved && a.Agent?) then None      // I1: refused, except an agent's move assigns it
          else
            var as2 := if ownerless then Holder(a) else as1;
            if !moved && as2 == it.assignee then None
            else
              var r := Log(Link(Mv(it, to).(assignee := as2), as2), a);
              Some(b.(items := m[x := if moved && a == PersonActs then Reset(r) else r]))
  }

  // updateWork dependsOn (W-116): the cycle check, and a Blocked item never loses its last dependency.
  ghost function SetDeps(b: Board, a: Actor, x: Id, D: set<Id>): Option<Board> {
    if a == Server || x !in b.items then None
    else
      var m := b.items;
      if !(D <= m.Keys) || x in D || D == m[x].deps then None
      else if exists d :: d in D && Reach(Deps(m), d, x) then None
      else if m[x].status == Blocked && D == {} then None
      else Some(b.(items := m[x := Log(m[x].(deps := D), a)]))
  }

  // updateWork ticketOf (W-116): marks an existing item as a ticket of an earlier one. A person, or an agent quoting
  // the person (the migration). The parent must be filed before the ticket, so the ticket tree has no cycle.
  ghost function SetTicketOf(b: Board, a: Actor, x: Id, p: Id, instr: bool): Option<Board> {
    if a == Server || (a.Agent? && !instr) || x !in b.items || p !in b.items || p >= x || b.items[x].ticketOf.Some?
       || Reach(Deps(b.items), x, p)
    then None
    else Some(b.(items := b.items[x := Log(b.items[x].(ticketOf := Some(p)), a)]))
  }

  // reportWork: done -> Done, ask -> Human required, continue stays. A report restarts the I4 count.
  ghost function Report(b: Board, a: Actor, x: Id, o: Outcome, instr: bool): Option<Board> {
    if a == Server || x !in b.items then None
    else
      var m := b.items;
      var it := m[x];
      var to := if o == RContinue then it.status else if o == RAsk then HumanRequired else Done;
      if to != it.status && Refused(a, it.status, to, instr) then None
      else
        var asker := if a.Agent? then AskedBy(a.sid) else AskedByServer;
        var r0 := Mv(it, to).(needs := if o == RAsk then Some(asker) else None);
        var r1 := if a.Agent? then r0.(sessions := r0.sessions + {a.sid}) else r0;
        var unowned := r1.status == InProgress && r1.assignee == Nobody && !OpenTicket(m, x);
        if unowned && !a.Agent? then None                     // W-116: a person's report never takes In progress
        else
          var r2 := if unowned then r1.(assignee := Holder(a)) else r1;
          Some(b.(items := m[x := Reset(Log(r2, a))]))
  }

  // claim() of a routine run, written as the run's session. Fire statuses are what a routine may name: never Deleted
  // and (W-116) never Blocked. Refused after two releases in a row (F2), and (W-116) for any item with tickets: a
  // parent is never picked up.
  ghost function Claim(b: Board, s: Sid, x: Id, fire: Status): Option<Board> {
    if x !in b.items then None
    else
      var m := b.items;
      var it := m[x];
      if fire == Deleted || fire == Blocked || it.status != fire || it.assignee != Nobody then None
      else if it.releases >= 2 || HasTickets(m, x) then None
      else if Refused(Agent(s), it.status, InProgress, false) then None
      else
        var r := Mv(it, InProgress).(assignee := Session(s, true), sessions := it.sessions + {s}, claims := it.claims + 1);
        Some(b.(items := m[x := Log(r, Agent(s))]))
  }

  // requestChangesOnWork (a person's press): the top of Ready for work, unassigned (I6).
  ghost function RequestChanges(b: Board, x: Id): Option<Board> {
    if x !in b.items || Closed(b.items[x].status) then None
    else Some(b.(items := b.items[x := Reset(Log(Mv(b.items[x], Ready).(needs := None, assignee := Nobody), PersonActs))]))
  }

  // approveWork (and the resync that completes it): Done, and (W-116) the merge is recorded even on an item that is
  // already Done.
  ghost function ApproveWork(b: Board, x: Id): Option<Board> {
    if x !in b.items || (b.items[x].status == Done && b.items[x].merged) then None
    else Some(b.(items := b.items[x := Reset(Log(Mv(b.items[x], Done).(needs := None, merged := true), PersonActs))]))
  }

  // Marking a question answered: Human required goes back to Needs refinement.
  ghost function Answer(b: Board, a: Actor, x: Id): Option<Board> {
    if a == Server || x !in b.items || b.items[x].needs.None? then None
    else
      var it := b.items[x];
      var moved := it.status == HumanRequired;
      var r := Log(Mv(it.(needs := None), if moved then NeedsRefinement else it.status), a);
      Some(b.(items := b.items[x := if moved && a == PersonActs then Reset(r) else r]))
  }

  ghost function Comment(b: Board, a: Actor, x: Id): Option<Board> {
    if a == Server || x !in b.items then None else Some(b.(items := b.items[x := Log(b.items[x], a)]))
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Approve of a session review (W-70 I8), and of a spec review that files its tickets (W-68, W-116).
  // ---------------------------------------------------------------------------------------------------------------

  // A spec's breakdown: each ticket lists the earlier tickets it depends on, by position.
  datatype Filing = Filing(parent: Id, tickets: seq<set<nat>>)
  predicate ValidFiling(f: Filing) {
    |f.tickets| > 0 && forall i, j :: 0 <= i < |f.tickets| && j in f.tickets[i] ==> j < i
  }
  ghost predicate CanFile(b: Board, f: Filing) {
    ValidFiling(f) && f.parent in b.items && !Closed(b.items[f.parent].status) && !b.items[f.parent].filed
  }
  function TicketDeps(base: Id, js: set<nat>): set<Id> { set j | j in js :: base + j }
  // A filed ticket: Ready for work when it depends on nothing, Blocked otherwise; written as the approving person.
  function TicketItem(p: Id, D: set<Id>): Item {
    Item(if D == {} then Ready else Blocked, Nobody, None, {}, Some(p), Some(p), D, false, false, false, None, 0, 0,
         PersonActs, None, false)
  }
  ghost function AddTickets(m: map<Id, Item>, base: Id, p: Id, ts: seq<set<nat>>, n: nat): map<Id, Item>
    requires n <= |ts|
    decreases n
  {
    if n == 0 then m else AddTickets(m, base, p, ts, n - 1)[base + n - 1 := TicketItem(p, TicketDeps(base, ts[n - 1]))]
  }
  lemma AddTicketsKeepsOld(m: map<Id, Item>, base: Id, p: Id, ts: seq<set<nat>>, n: nat, y: Id)
    requires n <= |ts| && y in m && y < base
    ensures y in AddTickets(m, base, p, ts, n) && AddTickets(m, base, p, ts, n)[y] == m[y]
    decreases n
  {
    if n > 0 { AddTicketsKeepsOld(m, base, p, ts, n - 1, y); }
  }
  // The tickets and the parent in one write; the parent is In progress, owned by its tickets.
  ghost function File(b: Board, f: Filing): Board
    requires CanFile(b, f) && (forall i :: i in b.items ==> i < b.next)
  {
    AddTicketsKeepsOld(b.items, b.next, f.parent, f.tickets, |f.tickets|, f.parent);
    var m1 := AddTickets(b.items, b.next, f.parent, f.tickets, |f.tickets|);
    var p2 := Reset(Log(Mv(m1[f.parent], InProgress).(assignee := Nobody, needs := None, filed := true), PersonActs));
    Board(m1[f.parent := p2], b.next + |f.tickets|)
  }
  ghost function CloseFor(it: Item): Item { Reset(Log(Mv(it, Done).(needs := None, merged := true), PersonActs)) }
  ghost function SessionApprove(b: Board, s: Sid, filing: Option<Filing>): Board
    requires forall i :: i in b.items ==> i < b.next
  {
    var b1 := if filing.Some? && CanFile(b, filing.value) then File(b, filing.value) else b;
    b1.(items := map x | x in b1.items :: if WaitsOn(b1.items, x, s) then CloseFor(b1.items[x]) else b1.items[x])
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The server's tick (RoutineRunner.release()), decided per item from one snapshot.
  // ---------------------------------------------------------------------------------------------------------------

  predicate Gone(a: Assignee, live: Sid -> Liveness) { a.Session? && live(a.sid) == Ended }
  // Nobody live holds it. An unknown session counts as live (fail closed).
  predicate Unheld(it: Item, live: Sid -> Liveness) { it.assignee == Nobody || Gone(it.assignee, live) }
  ghost predicate ParentDue(m: map<Id, Item>, x: Id, live: Sid -> Liveness)
    requires x in m
  { HasTickets(m, x) && !OpenTicket(m, x) && Unheld(m[x], live) && !m[x].followed }

  function BackTo(c: Option<Status>): Status {
    if c.Some? && c.value in {Backlog, NeedsRefinement, HumanRequired, Ready} then c.value else NeedsRefinement
  }
  // I2 and I4: the second release in a row asks, so does a pull request waiting; else back where it came from.
  function ReleaseTo(it: Item): Status {
    if it.releases + 1 >= 2 || it.hasPr then HumanRequired else BackTo(it.cameFrom)
  }
  function Asking(it: Item, to: Status): Option<Asker> { if to == HumanRequired then Some(AskedByServer) else it.needs }

  // I2: the dead session's own release, written as that session. A run's session is unlinked (`Released: run`).
  function SessionRelease(it: Item, to: Status): Item
    requires it.assignee.Session?
  {
    var s := it.assignee.sid;
    var r := Mv(it, to).(assignee := Nobody, releases := it.releases + 1, needs := Asking(it, to));
    if it.assignee.run then Log(r.(sessions := r.sessions - {s}), Agent(s)) else Log(r, Agent(s)).(newestRelease := Some(s))
  }
  // W-116 I7: a parent whose tickets are all closed follows them, whoever (no longer) holds it.
  ghost function ParentClose(m: map<Id, Item>, x: Id): Item requires x in m {
    var it := m[x];
    if AllTicketsDone(m, x)
    then Reset(Log(Mv(it, Done).(assignee := Nobody, merged := AllTicketsMerged(m, x)), Server)).(followed := true)
    else Reset(Log(Mv(it, HumanRequired).(assignee := Nobody, needs := AskOf(it)), Server)).(followed := true)
  }
  // W-116 I10: a Ready item whose assigned session ended is released in place, written as the server, so I8 never
  // reads it as the session's own; the second release in a row asks.
  function ReadyRelease(it: Item): Item {
    var to := if it.releases + 1 >= 2 then HumanRequired else Ready;
    Log(Mv(it, to).(assignee := Nobody, releases := it.releases + 1, needs := Asking(it, to)), Server)
  }

  // The parent rule fires once each time the tickets all close: the close marks the parent followed, and the mark is
  // cleared (silently, no history line) only while a ticket is open again. So a person's answer or move of a parent
  // is never undone by the next tick.
  ghost function TickItem(m: map<Id, Item>, x: Id, live: Sid -> Liveness): Item
    requires x in m
  {
    var r := TickCore(m, x, live);
    if OpenTicket(m, x) && r.followed then r.(followed := false) else r
  }
  ghost function TickCore(m: map<Id, Item>, x: Id, live: Sid -> Liveness): Item
    requires x in m
  {
    var it := m[x];
    match it.status
    case InProgress =>
      if it.assignee == Person then Reset(Log(Mv(it, HumanRequired), Server))            // W-116 I9 migration
      else if HasTickets(m, x) && !OpenTicket(m, x) && Unheld(it, live) then ParentClose(m, x)   // I7
      else if it.assignee == Nobody then
        (if OpenTicket(m, x) then it                                                    // owned by its tickets
         else Log(Mv(it, ReleaseTo(it)).(releases := it.releases + 1, needs := Asking(it, ReleaseTo(it))), Server))
      else if !Gone(it.assignee, live) then it                                          // I3: live or unknown
      else if OpenTicket(m, x) then SessionRelease(it, InProgress)                      // stays, owned by tickets
      else SessionRelease(it, ReleaseTo(it))                                            // I2
    case Blocked =>
      if ParentDue(m, x, live) then ParentClose(m, x)
      else if AnyGivenUp(m, it.deps) then Reset(Log(Mv(it, HumanRequired).(needs := AskOf(it)), Server))
      else if SatisfiedAll(m, it.deps) then
        (if it.needs.Some? then Reset(Log(Mv(it, HumanRequired), Server)) else Reset(Log(Mv(it, Ready), Server)))
      else it
    case NeedsRefinement => if ParentDue(m, x, live) then ParentClose(m, x) else it
    case Ready =>
      if ParentDue(m, x, live) then ParentClose(m, x)
      else if Gone(it.assignee, live) then ReadyRelease(it)
      else it
    case _ => it
  }
  ghost function Tick(b: Board, live: Sid -> Liveness): Board {
    b.(items := map x | x in b.items :: TickItem(b.items, x, live))
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The invariant.
  // ---------------------------------------------------------------------------------------------------------------

  // One item's rules, given the board's ids and whether the item has tickets.
  ghost predicate ItemOkWith(it: Item, x: Id, keys: set<Id>, ht: bool) {
    it.deps <= keys &&
    (it.ticketOf.Some? ==> it.ticketOf.value in keys && it.ticketOf.value < x) &&
    // I1 (W-116 form): In progress is held by a session, or owned by its tickets. Never the person.
    (it.status == InProgress ==> it.assignee.Session? || (it.assignee == Nobody && ht)) &&
    (it.status == Ready ==> it.assignee != Person) &&
    (it.status == Blocked ==> it.deps != {} && it.assignee == Nobody && it.needs == None && it.newestRelease == None) &&
    (it.newestRelease.Some? ==> it.assignee == Nobody && it.newestBy == Agent(it.newestRelease.value)) &&
    (it.assignee.Session? ==> it.assignee.sid in it.sessions) &&
    it.cameFrom != Some(InProgress) &&
    (it.merged ==> it.status == Done)
  }
  ghost predicate ItemOk(m: map<Id, Item>, x: Id) requires x in m { ItemOkWith(m[x], x, m.Keys, HasTickets(m, x)) }
  ghost predicate Inv(b: Board) {
    (forall i :: i in b.items ==> i < b.next) && Acyclic(Deps(b.items)) &&
    (forall x :: x in b.items ==> ItemOk(b.items, x))
  }

  lemma InvEdges(b: Board) requires Inv(b) ensures EdgesInDom(Deps(b.items)) {
    forall a, d | a in Deps(b.items) && d in Deps(b.items)[a] ensures d in Deps(b.items) { assert ItemOk(b.items, a); }
  }

  // Writing one item changes the ticket sets only where its ticket link points.
  lemma TicketsOfAfter(m: map<Id, Item>, x: Id, it: Item, i: Id)
    ensures TicketsOf(m[x := it], i) == (TicketsOf(m, i) - {x}) + (if it.ticketOf == Some(i) then {x} else {})
  {}
  lemma ReachInDom(g: map<Id, set<Id>>, a: Id, c: Id) requires Reach(g, a, c) ensures a in g {}
  // Adding one edge a -> c keeps the graph acyclic when c does not already reach a.
  lemma AddEdgeKeepsAcyclic(g: map<Id, set<Id>>, a: Id, c: Id)
    requires Acyclic(g) && a in g && c != a && !Reach(g, c, a)
    ensures Acyclic(g[a := g[a] + {c}])
  {
    AcyclicNoSelfDep(g, a);
    forall d | d in g[a] + {c} ensures d != a && !Reach(g, d, a) {
      if d in g[a] && Reach(g, d, a) { ReachStep(g, a, d, a); }
    }
    UpdateKeepsAcyclic(g, a, g[a] + {c});
  }
  // Paths that start at or above `base` stay there when every node there points only there.
  least lemma ReachStaysAbove(g: map<Id, set<Id>>, base: Id, a: Id, c: Id)
    requires forall y :: y in g && y >= base ==> forall z :: z in g[y] ==> z >= base
    requires a >= base && Reach(g, a, c)
    ensures c >= base
  {
    if c !in g[a] {
      var k :| k in g[a] && Reach(g, k, c);
      ReachStaysAbove(g, base, k, c);
    }
  }

  // The graph after one write, in three shapes. Kept apart from the write paths so each proof stays small.
  lemma GraphAddFresh(m: map<Id, Item>, x: Id, it: Item)
    requires Acyclic(Deps(m)) && EdgesInDom(Deps(m)) && x !in m && it.deps <= m.Keys
    requires forall t :: t in m && m[t].ticketOf.Some? ==> m[t].ticketOf.value != x
    requires it.ticketOf.Some? ==> it.ticketOf.value in m && it.ticketOf.value != x &&
      !(it.ticketOf.value in it.deps) && forall d :: d in it.deps ==> !Reach(Deps(m), d, it.ticketOf.value)
    ensures Acyclic(Deps(m[x := it])) && EdgesInDom(Deps(m[x := it]))
  {
    var g := Deps(m);
    var m1 := m[x := it];
    FreshKeepsAcyclic(g, x, it.deps);
    var g1 := g[x := it.deps];
    forall i | i in m1 ensures TicketsOf(m1, i) == TicketsOf(m, i) + (if it.ticketOf == Some(i) then {x} else {}) {
      TicketsOfAfter(m, x, it, i);
    }
    assert TicketsOf(m, x) == {};
    if it.ticketOf.Some? {
      var q := it.ticketOf.value;
      assert !Reach(g1, x, q) by {
        if Reach(g1, x, q) {
          ReachUpdate(g, x, it.deps, x, q);
          if Reach(g, x, q) { ReachInDom(g, x, q); }
        }
      }
      AddEdgeKeepsAcyclic(g1, q, x);
      var g2 := g1[q := g1[q] + {x}];
      forall i | i in m1 ensures Deps(m1)[i] == g2[i] {
        if i == x { assert Deps(m1)[i] == it.deps + TicketsOf(m1, x); }
      }
      assert Deps(m1).Keys == g2.Keys;
      assert Deps(m1) == g2;
    } else {
      forall i | i in m1 ensures Deps(m1)[i] == g1[i] {
        if i == x { assert Deps(m1)[i] == it.deps + TicketsOf(m1, x); }
      }
      assert Deps(m1).Keys == g1.Keys;
      assert Deps(m1) == g1;
    }
  }

  lemma GraphSetDeps(m: map<Id, Item>, x: Id, it: Item)
    requires Acyclic(Deps(m)) && x in m && it.ticketOf == m[x].ticketOf
    requires forall e :: e in it.deps ==> e != x && !Reach(Deps(m), e, x)
    requires forall t :: t in TicketsOf(m, x) ==> t != x
    ensures Acyclic(Deps(m[x := it]))
  {
    var g := Deps(m);
    var T := TicketsOf(m, x);
    var m1 := m[x := it];
    forall e | e in it.deps + T ensures e != x && !Reach(g, e, x) {
      if e in T && Reach(g, e, x) { ReachStep(g, x, e, x); }
    }
    UpdateKeepsAcyclic(g, x, it.deps + T);
    forall i | i in m ensures TicketsOf(m1, i) == TicketsOf(m, i) { TicketsOfAfter(m, x, it, i); }
    assert Deps(m1) == g[x := it.deps + T];
  }

  lemma GraphSetTicketOf(m: map<Id, Item>, x: Id, it: Item, q: Id)
    requires Acyclic(Deps(m)) && x in m && q in m && x != q && it.deps == m[x].deps
    requires m[x].ticketOf.None? && it.ticketOf == Some(q) && !Reach(Deps(m), x, q)
    ensures Acyclic(Deps(m[x := it]))
  {
    var g := Deps(m);
    var m1 := m[x := it];
    AddEdgeKeepsAcyclic(g, q, x);
    forall i | i in m ensures TicketsOf(m1, i) == TicketsOf(m, i) + (if i == q then {x} else {}) {
      TicketsOfAfter(m, x, it, i);
    }
    var g2 := g[q := g[q] + {x}];
    forall i | i in m1 ensures Deps(m1)[i] == g2[i] {
      assert Deps(m1)[i] == m1[i].deps + TicketsOf(m1, i);
    }
    assert Deps(m1).Keys == g2.Keys;
    assert Deps(m1) == g2;
  }


  // Two boards with the same ids, dependencies and ticket links have the same graph and the same parents.
  ghost predicate SameShape(m: map<Id, Item>, m2: map<Id, Item>) {
    m.Keys == m2.Keys && forall i :: i in m ==> m2[i].deps == m[i].deps && m2[i].ticketOf == m[i].ticketOf
  }
  lemma ShapeKeeps(m: map<Id, Item>, m2: map<Id, Item>)
    requires SameShape(m, m2)
    ensures Deps(m2) == Deps(m) && forall y :: HasTickets(m2, y) == HasTickets(m, y)
  {
    forall y ensures HasTickets(m2, y) == HasTickets(m, y) {
      if HasTickets(m, y) { var t :| IsTicketOf(m, t, y); assert IsTicketOf(m2, t, y); }
      if HasTickets(m2, y) { var t :| IsTicketOf(m2, t, y); assert IsTicketOf(m, t, y); }
    }
    forall i | i in m ensures TicketsOf(m2, i) == TicketsOf(m, i) {
      forall t ensures t in TicketsOf(m2, i) <==> t in TicketsOf(m, i) {}
    }
    assert Deps(m2) == Deps(m);
  }
  lemma ShapeInv(b: Board, m2: map<Id, Item>)
    requires Inv(b) && SameShape(b.items, m2)
    requires forall x :: x in m2 ==> ItemOkWith(m2[x], x, b.items.Keys, HasTickets(b.items, x))
    ensures Inv(b.(items := m2))
  {
    ShapeKeeps(b.items, m2);
  }
  // A write to one item that keeps its dependencies and ticket link.
  lemma UpdOne(b: Board, x: Id, it2: Item)
    requires Inv(b) && x in b.items && it2.deps == b.items[x].deps && it2.ticketOf == b.items[x].ticketOf
    requires ItemOkWith(it2, x, b.items.Keys, HasTickets(b.items, x))
    ensures Inv(b.(items := b.items[x := it2]))
  {
    ShapeInv(b, b.items[x := it2]);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Every event keeps the invariant.
  // ---------------------------------------------------------------------------------------------------------------

  lemma CreateInv(b: Board, a: Actor, s: Status, as_: Assignee, tOf: Option<Id>, cf: Option<Id>, D: set<Id>, instr: bool)
    requires Inv(b) && Create(b, a, s, as_, tOf, cf, D, instr).Some?
    ensures Inv(Create(b, a, s, as_, tOf, cf, D, instr).value)
  {
    var m := b.items;
    var b2 := Create(b, a, s, as_, tOf, cf, D, instr).value;
    var x := b.next;
    InvEdges(b);
    forall t | t in m && m[t].ticketOf.Some? ensures m[t].ticketOf.value != x { assert ItemOk(m, t); }
    GraphAddFresh(m, x, b2.items[x]);
    assert b2.items == m[x := b2.items[x]];
    assert !IsTicketOf(m, x, x);
    forall y | y in b2.items ensures ItemOk(b2.items, y) {
      if y != x {
        if HasTickets(m, y) { var t :| IsTicketOf(m, t, y); assert IsTicketOf(b2.items, t, y); }
        assert ItemOk(m, y);
      } else {
        if HasTickets(b2.items, x) {
          var t :| IsTicketOf(b2.items, t, x);
          if t != x { assert ItemOk(m, t); }
        }
      }
    }
  }

  lemma EditInv(b: Board, a: Actor, x: Id, to: Status, named: Option<Assignee>, instr: bool, reason: bool)
    requires Inv(b) && Edit(b, a, x, to, named, instr, reason).Some?
    ensures Inv(Edit(b, a, x, to, named, instr, reason).value)
  {
    assert ItemOk(b.items, x);
    var b2 := Edit(b, a, x, to, named, instr, reason).value;
    UpdOne(b, x, b2.items[x]);
    assert b2 == b.(items := b.items[x := b2.items[x]]);
  }

  lemma SetDepsInv(b: Board, a: Actor, x: Id, D: set<Id>)
    requires Inv(b) && SetDeps(b, a, x, D).Some?
    ensures Inv(SetDeps(b, a, x, D).value)
  {
    var m := b.items;
    var b2 := SetDeps(b, a, x, D).value;
    forall t | t in TicketsOf(m, x) ensures t != x { assert ItemOk(m, t); }
    GraphSetDeps(m, x, b2.items[x]);
    assert b2.items == m[x := b2.items[x]];
    forall y | y in b2.items ensures ItemOk(b2.items, y) {
      if HasTickets(m, y) { var t :| IsTicketOf(m, t, y); assert IsTicketOf(b2.items, t, y); }
      if HasTickets(b2.items, y) { var t :| IsTicketOf(b2.items, t, y); assert IsTicketOf(m, t, y); }
      assert ItemOk(m, y);
    }
  }

  lemma SetTicketOfInv(b: Board, a: Actor, x: Id, p: Id, instr: bool)
    requires Inv(b) && SetTicketOf(b, a, x, p, instr).Some?
    ensures Inv(SetTicketOf(b, a, x, p, instr).value)
  {
    var m := b.items;
    var b2 := SetTicketOf(b, a, x, p, instr).value;
    GraphSetTicketOf(m, x, b2.items[x], p);
    assert b2.items == m[x := b2.items[x]];
    forall y | y in b2.items ensures ItemOk(b2.items, y) {
      if HasTickets(m, y) { var t :| IsTicketOf(m, t, y); assert t != x; assert IsTicketOf(b2.items, t, y); }
      assert ItemOk(m, y);
    }
  }

  lemma ReportInv(b: Board, a: Actor, x: Id, o: Outcome, instr: bool)
    requires Inv(b) && Report(b, a, x, o, instr).Some?
    ensures Inv(Report(b, a, x, o, instr).value)
  {
    assert ItemOk(b.items, x);
    var b2 := Report(b, a, x, o, instr).value;
    UpdOne(b, x, b2.items[x]);
    assert b2 == b.(items := b.items[x := b2.items[x]]);
  }

  lemma ClaimInv(b: Board, s: Sid, x: Id, fire: Status)
    requires Inv(b) && Claim(b, s, x, fire).Some?
    ensures Inv(Claim(b, s, x, fire).value)
  {
    assert ItemOk(b.items, x);
    var b2 := Claim(b, s, x, fire).value;
    UpdOne(b, x, b2.items[x]);
    assert b2 == b.(items := b.items[x := b2.items[x]]);
  }

  lemma RequestChangesInv(b: Board, x: Id)
    requires Inv(b) && RequestChanges(b, x).Some?
    ensures Inv(RequestChanges(b, x).value)
  {
    assert ItemOk(b.items, x);
    var b2 := RequestChanges(b, x).value;
    UpdOne(b, x, b2.items[x]);
    assert b2 == b.(items := b.items[x := b2.items[x]]);
  }

  lemma ApproveWorkInv(b: Board, x: Id)
    requires Inv(b) && ApproveWork(b, x).Some?
    ensures Inv(ApproveWork(b, x).value)
  {
    assert ItemOk(b.items, x);
    var b2 := ApproveWork(b, x).value;
    UpdOne(b, x, b2.items[x]);
    assert b2 == b.(items := b.items[x := b2.items[x]]);
  }

  lemma AnswerInv(b: Board, a: Actor, x: Id)
    requires Inv(b) && Answer(b, a, x).Some?
    ensures Inv(Answer(b, a, x).value)
  {
    assert ItemOk(b.items, x);
    var b2 := Answer(b, a, x).value;
    UpdOne(b, x, b2.items[x]);
    assert b2 == b.(items := b.items[x := b2.items[x]]);
  }

  lemma CommentInv(b: Board, a: Actor, x: Id)
    requires Inv(b) && Comment(b, a, x).Some?
    ensures Inv(Comment(b, a, x).value)
  {
    assert ItemOk(b.items, x);
    var b2 := Comment(b, a, x).value;
    UpdOne(b, x, b2.items[x]);
    assert b2 == b.(items := b.items[x := b2.items[x]]);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The tick keeps the invariant.
  // ---------------------------------------------------------------------------------------------------------------

  lemma TickItemOk(m: map<Id, Item>, x: Id, live: Sid -> Liveness)
    requires x in m && ItemOk(m, x)
    ensures TickItem(m, x, live).deps == m[x].deps && TickItem(m, x, live).ticketOf == m[x].ticketOf
    ensures ItemOkWith(TickItem(m, x, live), x, m.Keys, HasTickets(m, x))
  {
    if m[x].status == InProgress && OpenTicket(m, x) { var t :| IsTicketOf(m, t, x) && !Closed(m[t].status); }
  }
  lemma TickInv(b: Board, live: Sid -> Liveness)
    requires Inv(b)
    ensures Inv(Tick(b, live))
  {
    var m2 := Tick(b, live).items;
    forall x | x in m2 ensures m2[x].deps == b.items[x].deps && m2[x].ticketOf == b.items[x].ticketOf &&
                               ItemOkWith(m2[x], x, b.items.Keys, HasTickets(b.items, x)) {
      TickItemOk(b.items, x, live);
    }
    ShapeInv(b, m2);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Filing a spec's tickets keeps the invariant.
  // ---------------------------------------------------------------------------------------------------------------

  lemma AddTicketsOk(b: Board, f: Filing, n: nat)
    requires Inv(b) && CanFile(b, f) && n <= |f.tickets|
    ensures var m1 := AddTickets(b.items, b.next, f.parent, f.tickets, n);
      (forall y :: y in m1 <==> (y in b.items || (b.next <= y < b.next + n))) &&
      (forall y :: y in b.items ==> m1[y] == b.items[y]) &&
      (forall j :: 0 <= j < n ==> m1[b.next + j] == TicketItem(f.parent, TicketDeps(b.next, f.tickets[j]))) &&
      (forall t :: t in m1 && m1[t].ticketOf.Some? ==> m1[t].ticketOf.value < t) &&
      (forall y :: y in m1 && y >= b.next ==> forall z :: z in Deps(m1)[y] ==> z >= b.next) &&
      Acyclic(Deps(m1)) && EdgesInDom(Deps(m1))
    decreases n
  {
    InvEdges(b);
    var base := b.next;
    var p := f.parent;
    if n == 0 {
      forall t | t in b.items && b.items[t].ticketOf.Some? ensures b.items[t].ticketOf.value < t { assert ItemOk(b.items, t); }
    } else {
      AddTicketsOk(b, f, n - 1);
      var m0 := AddTickets(b.items, base, p, f.tickets, n - 1);
      var x := base + n - 1;
      var D := TicketDeps(base, f.tickets[n - 1]);
      assert D <= m0.Keys by {
        forall d | d in D ensures d in m0 {
          var j :| j in f.tickets[n - 1] && d == base + j;
          assert j < n - 1;
          assert base <= d < base + (n - 1);
        }
      }
      assert p in m0 && p < base;
      var ti := TicketItem(p, D);
      forall d | d in D ensures !Reach(Deps(m0), d, p) {
        if Reach(Deps(m0), d, p) { ReachStaysAbove(Deps(m0), base, d, p); }
      }
      GraphAddFresh(m0, x, ti);
      var m1 := AddTickets(b.items, base, p, f.tickets, n);
      assert m1 == m0[x := ti];
      forall i | i in m1 ensures TicketsOf(m1, i) == TicketsOf(m0, i) + (if i == p then {x} else {}) {
        TicketsOfAfter(m0, x, ti, i);
      }
      forall y | y in m1 && y >= base ensures forall z :: z in Deps(m1)[y] ==> z >= base {
        if y != x { assert Deps(m1)[y] == Deps(m0)[y]; }
      }
      forall j | 0 <= j < n ensures m1[base + j] == TicketItem(p, TicketDeps(base, f.tickets[j])) {
        if j < n - 1 { assert base + j in m0; }
      }
    }
  }

  lemma FileInv(b: Board, f: Filing)
    requires Inv(b) && CanFile(b, f)
    ensures Inv(File(b, f))
    ensures File(b, f).items[f.parent].status == InProgress && OpenTicket(File(b, f).items, f.parent)
    ensures File(b, f).items[f.parent].filed && File(b, f).next == b.next + |f.tickets|
  {
    var n := |f.tickets|;
    AddTicketsOk(b, f, n);
    var m1 := AddTickets(b.items, b.next, f.parent, f.tickets, n);
    var b2 := File(b, f);
    var p := f.parent;
    ShapeKeeps(m1, b2.items);
    assert b.next in m1 && m1[b.next] == TicketItem(p, TicketDeps(b.next, f.tickets[0]));
    assert p < b.next;
    assert b2.items[b.next] == m1[b.next];
    assert IsTicketOf(b2.items, b.next, p) && !Closed(b2.items[b.next].status);
    forall y | y in b2.items ensures ItemOk(b2.items, y) {
      if y in b.items {
        assert ItemOk(b.items, y);
        if HasTickets(b.items, y) { var t :| IsTicketOf(b.items, t, y); assert IsTicketOf(b2.items, t, y); }
      } else {
        var j :| 0 <= j < n && y == b.next + j;
        assert b2.items[y] == TicketItem(p, TicketDeps(b.next, f.tickets[j]));
        assert TicketDeps(b.next, f.tickets[j]) <= b2.items.Keys by {
          forall d | d in TicketDeps(b.next, f.tickets[j]) ensures d in b2.items {
            var k :| k in f.tickets[j] && d == b.next + k;
            assert k < j;
            assert b.next <= d < b.next + n;
            assert d in m1;
          }
        }
      }
    }
  }

  lemma CloseWaitingInv(b: Board, s: Sid)
    requires Inv(b)
    ensures Inv(b.(items := map x | x in b.items :: if WaitsOn(b.items, x, s) then CloseFor(b.items[x]) else b.items[x]))
  {
    var m2 := map x | x in b.items :: if WaitsOn(b.items, x, s) then CloseFor(b.items[x]) else b.items[x];
    forall x | x in m2 ensures ItemOkWith(m2[x], x, b.items.Keys, HasTickets(b.items, x)) { assert ItemOk(b.items, x); }
    ShapeInv(b, m2);
  }

  lemma SessionApproveInv(b: Board, s: Sid, filing: Option<Filing>)
    requires Inv(b)
    ensures Inv(SessionApprove(b, s, filing))
  {
    var b1 := if filing.Some? && CanFile(b, filing.value) then File(b, filing.value) else b;
    if filing.Some? && CanFile(b, filing.value) { FileInv(b, filing.value); }
    CloseWaitingInv(b1, s);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Kept W-70 invariants, restated over the board.
  // ---------------------------------------------------------------------------------------------------------------

  // I1. In progress always has an owner: a session, or its own tickets. A ticket closing no longer breaks it (F3 is
  // gone): owning tickets is HasTickets, which no write takes away, and the tick then settles the parent (I7).
  lemma I1_InProgressHasAnOwner(b: Board, x: Id)
    requires Inv(b) && x in b.items && b.items[x].status == InProgress
    ensures b.items[x].assignee.Session? || (b.items[x].assignee == Nobody && HasTickets(b.items, x))
  { assert ItemOk(b.items, x); }

  // I2 with F1. An ended session's In progress item with no tickets leaves In progress, unassigned, and is never
  // closed by it.
  lemma I2_EndedSessionReleases(b: Board, x: Id, live: Sid -> Liveness)
    requires Inv(b) && x in b.items && b.items[x].status == InProgress && Gone(b.items[x].assignee, live)
    requires !HasTickets(b.items, x)
    ensures var r := TickItem(b.items, x, live);
      r.status != InProgress && !Closed(r.status) && r.assignee == Nobody && r.status != Blocked
  {
    assert ItemOk(b.items, x);
    if OpenTicket(b.items, x) { var t :| IsTicketOf(b.items, t, x) && !Closed(b.items[t].status); }
  }

  // I3. A live or unknown session's item is never touched by the tick, in any status.
  lemma I3_LiveOrUnknownIsNeverReleased(b: Board, x: Id, live: Sid -> Liveness)
    requires Inv(b) && x in b.items && b.items[x].assignee.Session? && live(b.items[x].assignee.sid) != Ended
    ensures TickItem(b.items, x, live).(followed := b.items[x].followed) == b.items[x]
  { assert ItemOk(b.items, x); }

  // I4 with F2. The autonomous steps (claim and the tick) keep the bound: claimed at most twice in a row, and never
  // more claims than releases plus the run that holds it now.
  ghost predicate AutoOk(it: Item) {
    it.claims <= 2 && it.claims <= it.releases + (if it.assignee.Session? && it.assignee.run then 1 else 0)
  }
  ghost predicate InvAuto(b: Board) { forall x :: x in b.items ==> AutoOk(b.items[x]) }
  lemma I4_ClaimKeepsBound(b: Board, s: Sid, x: Id, fire: Status)
    requires InvAuto(b) && Claim(b, s, x, fire).Some?
    ensures InvAuto(Claim(b, s, x, fire).value)
  { assert AutoOk(b.items[x]); }
  lemma I4_TickKeepsBound(b: Board, live: Sid -> Liveness)
    requires InvAuto(b)
    ensures InvAuto(Tick(b, live))
  {
    forall x | x in b.items ensures AutoOk(TickItem(b.items, x, live)) { assert AutoOk(b.items[x]); }
  }
  lemma I4_ClaimRefusedAfterTwoReleases(b: Board, s: Sid, x: Id, fire: Status)
    requires x in b.items && b.items[x].releases >= 2
    ensures Claim(b, s, x, fire).None?
  {}
  // Every release after the first asks, wherever it happens (W-116 adds the Ready release). The one exception is the
  // stay release of a parent whose open tickets own it: it stays In progress, and a parent is never claimed, so no
  // run can follow it.
  lemma I4_LaterReleasesAsk(b: Board, x: Id, live: Sid -> Liveness)
    requires Inv(b) && x in b.items && b.items[x].releases >= 1
    requires TickItem(b.items, x, live).releases == b.items[x].releases + 1
    ensures TickItem(b.items, x, live).status == HumanRequired ||
      (TickItem(b.items, x, live).status == InProgress && OpenTicket(b.items, x))
  { assert ItemOk(b.items, x); }

  // I5, per item. The tick's own output on an item is settled: a second tick leaves that item as it is, while the
  // rest of the board is unchanged. (The whole board can take more than one tick: a parent that closes is itself a
  // ticket of a grandparent, which closes on the next tick.)
  lemma NotOwnTicket(m: map<Id, Item>, x: Id, r: Item)
    requires x in m && ItemOk(m, x) && r.ticketOf == m[x].ticketOf
    ensures OpenTicket(m[x := r], x) == OpenTicket(m, x) && HasTickets(m[x := r], x) == HasTickets(m, x)
  {
    var m2 := m[x := r];
    if OpenTicket(m, x) { var t :| IsTicketOf(m, t, x) && !Closed(m[t].status); assert t != x; assert IsTicketOf(m2, t, x); }
    if OpenTicket(m2, x) { var t :| IsTicketOf(m2, t, x) && !Closed(m2[t].status); assert t != x; assert IsTicketOf(m, t, x); }
    if HasTickets(m, x) { var t :| IsTicketOf(m, t, x); assert t != x; assert IsTicketOf(m2, t, x); }
    if HasTickets(m2, x) { var t :| IsTicketOf(m2, t, x); assert t != x; assert IsTicketOf(m, t, x); }
  }
  lemma I5_TickIsSettledPerItem(b: Board, x: Id, live: Sid -> Liveness)
    requires Inv(b) && x in b.items
    ensures var r := TickItem(b.items, x, live); TickItem(b.items[x := r], x, live) == r
  {
    assert ItemOk(b.items, x);
    var r := TickItem(b.items, x, live);
    TickItemOk(b.items, x, live);
    NotOwnTicket(b.items, x, r);
  }

  // I6 generalised (W-116). Entering Ready for work clears the assignee unless the same write names a session.
  lemma I6_EnteringReadyClearsAssignee(b: Board, a: Actor, x: Id, named: Option<Assignee>, instr: bool, reason: bool)
    requires x in b.items && b.items[x].status != Ready && Edit(b, a, x, Ready, named, instr, reason).Some?
    requires !(named.Some? && named.value.Session?)
    ensures Edit(b, a, x, Ready, named, instr, reason).value.items[x].assignee == Nobody
  {}
  lemma I6_RequestChangesUnassigns(b: Board, x: Id)
    requires RequestChanges(b, x).Some?
    ensures RequestChanges(b, x).value.items[x].status == Ready && RequestChanges(b, x).value.items[x].assignee == Nobody
  {}

  // I7 (W-116 form). A parent with no open tickets that nobody live holds follows its tickets, from Needs refinement,
  // Ready for work, Blocked or In progress: Done when every ticket is Done, Human required otherwise.
  lemma I7_ParentFollowsItsTickets(b: Board, x: Id, live: Sid -> Liveness)
    requires Inv(b) && x in b.items && HasTickets(b.items, x) && !OpenTicket(b.items, x) && Unheld(b.items[x], live)
    requires b.items[x].status == InProgress || (b.items[x].status in {NeedsRefinement, Ready, Blocked} && !b.items[x].followed)
    ensures var r := TickItem(b.items, x, live);
      r.assignee == Nobody && (if AllTicketsDone(b.items, x) then r.status == Done else r.status == HumanRequired)
  { assert ItemOk(b.items, x); }

  // The parent rule fires once per closing. Answering the question it asked leaves the parent in Needs refinement,
  // and the next tick leaves it there (the loop W-70 I7 would have had from any lane but In progress).
  lemma I7_AnswerIsNotUndone(b: Board, x: Id, live: Sid -> Liveness)
    requires Inv(b) && x in b.items && b.items[x].status == HumanRequired && b.items[x].followed
    requires !OpenTicket(b.items, x) && Answer(b, PersonActs, x).Some?
    ensures var b2 := Answer(b, PersonActs, x).value;
      b2.items[x].status == NeedsRefinement && TickItem(b2.items, x, live) == b2.items[x]
  {
    assert ItemOk(b.items, x);
    var b2 := Answer(b, PersonActs, x).value;
    NotOwnTicket(b.items, x, b2.items[x]);
  }
  // A person's move of a followed parent back to Ready for work is not undone either.
  lemma I7_PersonMoveIsNotUndone(b: Board, x: Id, live: Sid -> Liveness)
    requires Inv(b) && x in b.items && b.items[x].status in {NeedsRefinement, Ready, Blocked} && b.items[x].followed
    requires !OpenTicket(b.items, x) && b.items[x].assignee == Nobody && b.items[x].deps == {}
    ensures TickItem(b.items, x, live) == b.items[x]
  {
    assert ItemOk(b.items, x);
  }
  // A ticket that opens again re-arms the rule.
  lemma I7_OpenTicketRearms(b: Board, x: Id, live: Sid -> Liveness)
    requires Inv(b) && x in b.items && OpenTicket(b.items, x)
    ensures !TickItem(b.items, x, live).followed
  {}
  // No ticket waits on its own parent, at any depth: the cycle check runs over dependencies and ticket links together.
  lemma I13_NoTicketWaitsOnItsParent(b: Board, t: Id, p: Id)
    requires Inv(b) && IsTicketOf(b.items, t, p)
    ensures !Reach(Deps(b.items), t, p) && p !in b.items[t].deps
  {
    var g := Deps(b.items);
    assert ItemOk(b.items, t);
    assert t in TicketsOf(b.items, p);
    if Reach(g, t, p) { ReachStep(g, p, t, p); }
    if p in b.items[t].deps { assert p in g[t]; ReachStep(g, t, p, p); }
  }
  lemma I13_TicketDependingOnItsParentRefused()
    ensures var it := Item(Ready, Nobody, None, {}, None, None, {}, false, false, false, None, 0, 0, PersonActs, None, false);
      var b := Board(map[1 := it, 2 := it.(ticketOf := Some(1))], 3);
      SetDeps(b, PersonActs, 2, {1}).None?
  {
    var it := Item(Ready, Nobody, None, {}, None, None, {}, false, false, false, None, 0, 0, PersonActs, None, false);
    var b := Board(map[1 := it, 2 := it.(ticketOf := Some(1))], 3);
    assert 2 in TicketsOf(b.items, 1);
    assert 2 in Deps(b.items)[1];
    ReachStep(Deps(b.items), 1, 2, 2);
  }

  // I8 revision 2, kept. Approve of a session's review closes the work waiting on it.
  lemma I8_ApproveClosesWaitingWork(b: Board, s: Sid, x: Id)
    requires Inv(b) && WaitsOn(b.items, x, s)
    ensures SessionApprove(b, s, None).items[x].status == Done
  {}
  // W-116's guard. An item its open tickets own is never closed by Approve of a session review, whoever wrote last.
  lemma I8_NeverClosesAnOwnedParent(b: Board, s: Sid, x: Id)
    requires Inv(b) && x in b.items && OpenTicket(b.items, x)
    ensures SessionApprove(b, s, None).items[x] == b.items[x]
  {}
  // I8 and the tick. The tick signs only as the server or as the ended session it releases.
  lemma I8_TickSignsAsServerOrTheEndedSession(b: Board, x: Id, live: Sid -> Liveness)
    requires Inv(b) && x in b.items && TickItem(b.items, x, live).(followed := b.items[x].followed) != b.items[x]
    ensures var r := TickItem(b.items, x, live);
      r.newestBy == Server ||
      (b.items[x].assignee.Session? && r.newestBy == Agent(b.items[x].assignee.sid) && live(b.items[x].assignee.sid) == Ended)
  { assert ItemOk(b.items, x); }
  // The Ready release never takes work that waits on a review: a Ready item that holds a session has no release line.
  lemma I8_ReadyReleaseNeverTakesWaitingWork(b: Board, x: Id, s: Sid, live: Sid -> Liveness)
    requires Inv(b) && x in b.items && b.items[x].status == Ready && Gone(b.items[x].assignee, live)
    ensures !WaitsOn(b.items, x, s)
  { assert ItemOk(b.items, x); }
  // Waiting work stays waiting, or is closed, or asks a person. A routine run's session is the exception, as in W-70:
  // its release unlinks it (`Released: run`).
  lemma I8_TickKeepsWaitingWork(b: Board, x: Id, s: Sid, live: Sid -> Liveness)
    requires Inv(b) && WaitsOn(b.items, x, s) && b.items[x].assignee != Session(s, true)
    ensures var r := TickItem(b.items, x, live);
      r == b.items[x] || Closed(r.status) || r.status == HumanRequired || WaitsOn(b.items[x := r], x, s)
  {
    assert ItemOk(b.items, x);
    var m := b.items;
    var it := m[x];
    var r := TickItem(m, x, live);
    TickItemOk(m, x, live);
    NotOwnTicket(m, x, r);
    if it.status == InProgress {
      if HasTickets(m, x) && !OpenTicket(m, x) && Unheld(it, live) {
        assert r == ParentClose(m, x);
      } else if it.assignee == Nobody {
        assert it.newestRelease == Some(s);
        assert HasTickets(m, x);
        assert false;
      } else if !Gone(it.assignee, live) {
        assert r == it;
      } else {
        assert !OpenTicket(m, x);
        assert it.assignee == Session(s, false);
        assert r == SessionRelease(it, ReleaseTo(it));
        assert r.newestRelease == Some(s) && r.newestBy == Agent(s) && s in r.sessions && !Closed(r.status);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // W-116: no person In progress, Blocked and dependencies, real tickets, spec filing.
  // ---------------------------------------------------------------------------------------------------------------

  lemma I9_NoPersonInProgress(b: Board, x: Id)
    requires Inv(b) && x in b.items && b.items[x].status == InProgress
    ensures b.items[x].assignee != Person
  { assert ItemOk(b.items, x); }
  // The migration: one tick on ANY board, even one written by the previous release, moves each item a person holds In
  // progress to Human required with the person kept, written as the server.
  lemma I9_TickMigratesAnyBoard(b: Board, x: Id, live: Sid -> Liveness)
    requires x in b.items && b.items[x].status == InProgress && b.items[x].assignee == Person
    ensures var r := TickItem(b.items, x, live);
      r.status == HumanRequired && r.assignee == Person && r.newestBy == Server && r.releases == 0
  {}
  lemma I9_TickLeavesNoPersonInProgress(b: Board, live: Sid -> Liveness)
    ensures forall x :: x in Tick(b, live).items && Tick(b, live).items[x].status == InProgress ==>
      Tick(b, live).items[x].assignee != Person
  {}
  // A person's move into In progress, with no session named, is refused unless the item's tickets own it.
  lemma I9_PersonMoveIntoInProgressRefused(b: Board, x: Id, named: Option<Assignee>, instr: bool, reason: bool)
    requires x in b.items && b.items[x].status != InProgress && b.items[x].assignee in {Nobody, Person}
    requires named in {None, Some(Nobody), Some(Person)} && !OpenTicket(b.items, x)
    ensures Edit(b, PersonActs, x, InProgress, named, instr, reason).None?
  {}
  // An agent's move of an unowned item into In progress assigns that agent (I1).
  lemma I1_AgentMoveAssignsItself(b: Board, sid: Sid, x: Id, instr: bool, reason: bool)
    requires x in b.items && b.items[x].status != InProgress && b.items[x].assignee == Nobody && !OpenTicket(b.items, x)
    requires Edit(b, Agent(sid), x, InProgress, None, instr, reason).Some?
    ensures Edit(b, Agent(sid), x, InProgress, None, instr, reason).value.items[x].assignee == Session(sid, false)
  {}

  // I10. A Ready item whose session ended loses it, written as the server, and the second such release asks.
  lemma I10_EndedReadyAssigneeCleared(b: Board, x: Id, live: Sid -> Liveness)
    requires Inv(b) && x in b.items && b.items[x].status == Ready && Gone(b.items[x].assignee, live)
    requires !ParentDue(b.items, x, live)
    ensures var r := TickItem(b.items, x, live);
      r.assignee == Nobody && r.newestBy == Server && r.sessions == b.items[x].sessions &&
      r.status == (if b.items[x].releases >= 1 then HumanRequired else Ready)
  {}

  // The Ready release never makes work wait on the ended session's review, so a later Approve of that review cannot
  // close an item that was only ever queued (W-70 I8 revision 2 reads the newest line's author).
  lemma I10_ReadyReleaseNeverMakesWorkWait(b: Board, x: Id, s: Sid, live: Sid -> Liveness)
    requires Inv(b) && x in b.items && b.items[x].status == Ready && Gone(b.items[x].assignee, live)
    requires !ParentDue(b.items, x, live)
    ensures !WaitsOn(b.items[x := TickItem(b.items, x, live)], x, s)
  {}

  // I11. A Blocked item is released to Ready for work only when every dependency is Done and merged, and then it is.
  lemma I11_ReleasedOnlyWhenMerged(b: Board, x: Id, live: Sid -> Liveness)
    requires Inv(b) && x in b.items && b.items[x].status == Blocked && TickItem(b.items, x, live).status == Ready
    ensures SatisfiedAll(b.items, b.items[x].deps) && TickItem(b.items, x, live).assignee == Nobody
  {}
  lemma I11_ReleasedWhenMerged(b: Board, x: Id, live: Sid -> Liveness)
    requires Inv(b) && x in b.items && b.items[x].status == Blocked && !ParentDue(b.items, x, live)
    requires SatisfiedAll(b.items, b.items[x].deps)
    ensures TickItem(b.items, x, live).status == Ready && TickItem(b.items, x, live).newestBy == Server
  {
    assert ItemOk(b.items, x);
    if AnyGivenUp(b.items, b.items[x].deps) {
      var d :| d in b.items[x].deps && GivenUp(b.items, d);
      assert Satisfied(b.items, d);
    }
  }
  // I12. A dependency that is given up (Not doing, Deleted, or Done with no merge and no pull request) asks a person.
  lemma I12_GivenUpDependencyAsks(b: Board, x: Id, live: Sid -> Liveness)
    requires x in b.items && b.items[x].status == Blocked && !ParentDue(b.items, x, live)
    requires AnyGivenUp(b.items, b.items[x].deps)
    ensures TickItem(b.items, x, live).status == HumanRequired && TickItem(b.items, x, live).needs.Some?
  {}
  function AllLive(s: Sid): Liveness { Live }
  function OnlyFiveEnded(s: Sid): Liveness { if s == 5 then Ended else Live }
  // A dependency marked Done whose pull request has not merged keeps the item waiting.
  lemma I11_DoneAloneIsNotEnough()
    ensures var dep := Item(Done, Nobody, None, {}, None, None, {}, false, true, false, None, 0, 0, PersonActs, None, false);
      var it := Item(Blocked, Nobody, None, {}, None, None, {1}, false, false, false, None, 0, 0, PersonActs, None, false);
      var m := map[1 := dep, 2 := it];
      TickItem(m, 2, AllLive) == it
  {
    var dep := Item(Done, Nobody, None, {}, None, None, {}, false, true, false, None, 0, 0, PersonActs, None, false);
    var it := Item(Blocked, Nobody, None, {}, None, None, {1}, false, false, false, None, 0, 0, PersonActs, None, false);
    var m := map[1 := dep, 2 := it];
    assert !HasTickets(m, 2) by { forall t | t in m ensures !IsTicketOf(m, t, 2) {} }
    assert !Satisfied(m, 1);
    assert !AnyGivenUp(m, {1});
  }
  // I13. The write-time check refuses a dependency that would close a cycle.
  lemma I13_CycleRefused()
    ensures var it := Item(Ready, Nobody, None, {}, None, None, {}, false, false, false, None, 0, 0, PersonActs, None, false);
      var b := Board(map[1 := it.(deps := {2}), 2 := it], 3);
      SetDeps(b, PersonActs, 2, {1}).None?
  {
    var it := Item(Ready, Nobody, None, {}, None, None, {}, false, false, false, None, 0, 0, PersonActs, None, false);
    var b := Board(map[1 := it.(deps := {2}), 2 := it], 3);
    ReachStep(Deps(b.items), 1, 2, 2);
  }
  // Nothing autonomous enters Blocked, In progress or a closed status, except Done for a parent, and the tick only
  // ever keeps an assignee or clears it.
  lemma TickEdges(b: Board, x: Id, live: Sid -> Liveness)
    requires Inv(b) && x in b.items
    ensures var r := TickItem(b.items, x, live); var s := b.items[x].status;
      (r.status == Blocked ==> s == Blocked) && (r.status == InProgress ==> s == InProgress) &&
      (r.status in {NotDoing, Deleted} ==> r.status == s) &&
      (r.status == Done ==> s == Done || (HasTickets(b.items, x) && !OpenTicket(b.items, x))) &&
      (r.assignee == b.items[x].assignee || r.assignee == Nobody)
  { assert ItemOk(b.items, x); }

  // I14. Tickets are marked, not inferred. A follow-up created from a parent never holds it open: W-70's own case,
  // where W-75 was created from W-70 after its tickets W-90 and W-91 closed, and held it In progress under the old rule.
  lemma I14_FollowUpsDoNotHoldTheParent()
    ensures var p := Item(InProgress, Session(5, false), None, {5}, None, None, {}, false, false, false, Some(Ready),
                          0, 0, Agent(5), None, false);
      var t := Item(Done, Nobody, None, {}, Some(70), Some(70), {}, true, true, false, None, 0, 0, PersonActs, None, false);
      var fu := Item(NeedsRefinement, Nobody, None, {}, Some(70), None, {}, false, false, false, None, 0, 0, Agent(5), None, false);
      var m := map[70 := p, 90 := t, 91 := t, 75 := fu];
      OpenCreatedFrom(m, 70) && TickItem(m, 70, OnlyFiveEnded).status == Done
  {
    var p := Item(InProgress, Session(5, false), None, {5}, None, None, {}, false, false, false, Some(Ready),
                  0, 0, Agent(5), None, false);
    var t := Item(Done, Nobody, None, {}, Some(70), Some(70), {}, true, true, false, None, 0, 0, PersonActs, None, false);
    var fu := Item(NeedsRefinement, Nobody, None, {}, Some(70), None, {}, false, false, false, None, 0, 0, Agent(5), None, false);
    var m := map[70 := p, 90 := t, 91 := t, 75 := fu];
    assert IsTicketOf(m, 90, 70);
    assert !OpenTicket(m, 70);
    assert AllTicketsDone(m, 70) && AllTicketsMerged(m, 70);
    assert m[75].createdFrom == Some(70) && !Closed(m[75].status);
  }
  // A parent is never picked up by a routine.
  lemma ParentsAreNeverClaimed(b: Board, s: Sid, x: Id, fire: Status)
    requires x in b.items && HasTickets(b.items, x)
    ensures Claim(b, s, x, fire).None?
  {}
  // A Blocked item is never claimed, and an agent cannot move it on without the person's words.
  lemma BlockedIsNeverClaimed(b: Board, s: Sid, x: Id, fire: Status)
    requires x in b.items && b.items[x].status == Blocked
    ensures Claim(b, s, x, fire).None?
  {}
  lemma AgentCannotUnblock(b: Board, sid: Sid, x: Id, to: Status, named: Option<Assignee>, reason: bool)
    requires x in b.items && b.items[x].status == Blocked && to in {Ready, InProgress}
    ensures Edit(b, Agent(sid), x, to, named, false, reason).None?
  {}

  // W-68. Filing keeps the spec's parent open (its tickets own it), even when the same Approve would otherwise close
  // it, and a second Approve, or a resync after a crash, files nothing more.
  lemma W68_FilingKeepsTheParentOpen(b: Board, s: Sid, f: Filing)
    requires Inv(b) && CanFile(b, f)
    ensures SessionApprove(b, s, Some(f)).items[f.parent].status == InProgress
    ensures SessionApprove(b, s, Some(f)).items[f.parent].assignee == Nobody
  { FileInv(b, f); }
  lemma W68_FilingHappensOnce(b: Board, s: Sid, s2: Sid, f: Filing)
    requires Inv(b) && CanFile(b, f)
    ensures var b1 := SessionApprove(b, s, Some(f));
      !CanFile(b1, f) && (forall i :: i in b1.items ==> i < b1.next) && SessionApprove(b1, s2, Some(f)).next == b1.next
  {
    FileInv(b, f);
    SessionApproveInv(b, s, Some(f));
  }
}
