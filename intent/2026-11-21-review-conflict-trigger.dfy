// R-4's review-conflict trigger (C1-C6): when the server starts a conflict run, and when it starts nothing.
// A conflict key (review, branch tip, base tip) is a nat. One routine; one planFire tick per Tick event.
module ReviewConflictTrigger {
  datatype Option<T> = None | Some(value: T)

  // What one tick sees. `conflicts` is the watcher's latest ConflictView list, in its order; a read that failed is
  // simply absent from it (C6). `held(k)`: the review's Work item is In progress, or unreadable (C6). `young(k)`: the
  // branch tip is under 15 minutes old (`fresh` is a Dafny keyword).
  datatype View = View(conflicts: seq<nat>, held: set<nat>, young: set<nat>, gateOk: bool)

  datatype Routine = Routine(fired: set<nat>, active: bool)

  datatype Event =
    | Tick(v: View)
    | TaskRefused(k: nat)   // the task route refused the start (caps): the key stays due (C2)
    | RunEnds

  predicate Due(r: Routine, v: View, k: nat) { k !in r.fired && k !in v.held && k !in v.young }

  // The first due key in the watcher's order.
  function FirstDue(r: Routine, v: View, i: nat): Option<nat>
    requires i <= |v.conflicts|
    decreases |v.conflicts| - i
  {
    if i == |v.conflicts| then None
    else if Due(r, v, v.conflicts[i]) then Some(v.conflicts[i])
    else FirstDue(r, v, i + 1)
  }

  // The key a tick starts a run for, if any.
  function Fires(r: Routine, v: View): Option<nat> {
    if r.active || !v.gateOk then None   // C4, C5
    else FirstDue(r, v, 0)
  }

  function Step(r: Routine, e: Event): Routine {
    match e
    case Tick(v) =>
      (match Fires(r, v)
       case None => r
       case Some(k) => Routine(r.fired + {k}, true))
    case TaskRefused(k) => Routine(r.fired - {k}, false)
    case RunEnds => r.(active := false)
  }

  lemma FirstDueIsDue(r: Routine, v: View, i: nat)
    requires i <= |v.conflicts|
    ensures FirstDue(r, v, i).Some? ==>
      FirstDue(r, v, i).value in v.conflicts[i..] && Due(r, v, FirstDue(r, v, i).value)
    decreases |v.conflicts| - i
  {
    if i < |v.conflicts| && !Due(r, v, v.conflicts[i]) { FirstDueIsDue(r, v, i + 1); }
  }

  lemma FirstDueFinds(r: Routine, v: View, i: nat, k: nat)
    requires i <= |v.conflicts| && k in v.conflicts[i..] && Due(r, v, k)
    ensures FirstDue(r, v, i).Some?
    decreases |v.conflicts| - i
  {
    if !Due(r, v, v.conflicts[i]) { assert k in v.conflicts[i + 1..]; FirstDueFinds(r, v, i + 1, k); }
  }

  // ---- Safety ----

  // C1 + C3: a fire names a key the watcher saw conflicting, not held and not young.
  lemma OnlyRealSettledConflictsFire(r: Routine, v: View)
    requires Fires(r, v).Some?
    ensures Fires(r, v).value in v.conflicts
    ensures Fires(r, v).value !in v.held && Fires(r, v).value !in v.young
  { FirstDueIsDue(r, v, 0); }

  // C6 / Outcome 1: a pass that saw no conflict starts nothing.
  lemma NoConflictNoRun(r: Routine, v: View) requires |v.conflicts| == 0 ensures Fires(r, v).None? {}

  // C2: a key that fired never fires again (until its start was refused).
  lemma EachConflictFiresOnce(r: Routine, v: View)
    requires Fires(r, v).Some?
    ensures Fires(r, v).value !in r.fired
  { FirstDueIsDue(r, v, 0); }

  lemma FiredStaysFired(r: Routine, e: Event, k: nat)
    requires k in r.fired && !(e.TaskRefused? && e.k == k)
    ensures k in Step(r, e).fired
  {}

  // C4: never a second run while one is active.
  lemma OneRunAtATime(r: Routine, v: View) requires r.active ensures Fires(r, v).None? {}

  // C5
  lemma GatesStillApply(r: Routine, v: View) requires !v.gateOk ensures Fires(r, v).None? {}

  // ---- Progress ----

  // A due conflict is never passed over: with no run active and the gates open, the tick starts a run.
  lemma DueConflictStartsARun(r: Routine, v: View, k: nat)
    requires !r.active && v.gateOk && k in v.conflicts && Due(r, v, k)
    ensures Fires(r, v).Some?
  { assert v.conflicts[0..] == v.conflicts; FirstDueFinds(r, v, 0, k); }

  // A refused start leaves the key due (C2), so the next tick starts it.
  lemma RefusedStaysDue(r: Routine, v: View, k: nat)
    requires k in v.conflicts && k !in v.held && k !in v.young && v.gateOk
    ensures Fires(Step(r, TaskRefused(k)), v).Some?
  { DueConflictStartsARun(Step(r, TaskRefused(k)), v, k); }

  // C3: a held conflict fires on the first tick after it stops being held.
  lemma HeldFiresOnRelease(r: Routine, v: View, k: nat)
    requires !r.active && v.gateOk && k in v.conflicts && k !in r.fired && k !in v.young && k in v.held
    ensures Fires(r, v.(held := v.held - {k})).Some?
  { DueConflictStartsARun(r, v.(held := v.held - {k}), k); }

  // ---- The observed record: five empty wakes in a row now start nothing ----
  lemma EmptyAfternoon() {
    var r := Routine({}, false);
    var v := View([], {}, {}, true);
    var t := Step(Step(Step(Step(Step(r, Tick(v)), Tick(v)), Tick(v)), Tick(v)), Tick(v));
    assert t == r;
  }

  // ---- One conflict, seen on many passes, is one run ----
  lemma OneConflictOneRun() {
    var v := View([7], {}, {}, true);
    var a := Step(Routine({}, false), Tick(v));
    assert a == Routine({7}, true);
    var b := Step(Step(a, RunEnds), Tick(v));   // the escalated conflict, same tips, still listed
    assert b == Routine({7}, false);
  }
}
