// Model of the deploy health check's session decision: `decideSessions` in deploy/session-survival.mjs.
//
// The live colour lists the sessions it holds; the new colour must list them too, unless a session is
// provably dead (its tmux session is gone). This file states that decision as a function and proves
// what a pass and a failure mean. test/session-survival.drt.test.ts runs the shipped JavaScript against
// a Python build of `Decide` on random inputs (differential random testing).
//
// Verify:  dafny verify deploy/model/SessionSurvival.dfy
module SessionSurvival {
  datatype Option<T> = None | Some(value: T)

  // What tmux said about the socket: the session names on it, no server at all, or anything else.
  datatype Tmux = Running(names: set<string>) | NoServer | Unknown

  datatype Outcome = Outcome(ok: bool, excused: seq<string>, lost: seq<string>)

  // An id is provably dead: the environment is configured, the live colour's mux record names its tmux
  // session, tmux answered, and that tmux session is not on the socket.
  predicate Dead(id: string, envOk: bool, records: Option<map<string, string>>, tmux: Tmux) {
    envOk && records.Some? && id in records.value && !tmux.Unknown? &&
    (tmux.NoServer? || records.value[id] !in tmux.names)
  }

  // The expected ids the new colour does not list, in order, duplicates kept.
  function Missing(expected: seq<string>, listed: set<string>): seq<string> {
    if |expected| == 0 then []
    else (if expected[0] in listed then [] else [expected[0]]) + Missing(expected[1..], listed)
  }

  // The ids, in order, whose deadness is `dead`.
  function Keep(ids: seq<string>, envOk: bool, records: Option<map<string, string>>, tmux: Tmux, dead: bool): seq<string> {
    if |ids| == 0 then []
    else (if Dead(ids[0], envOk, records, tmux) == dead then [ids[0]] else []) + Keep(ids[1..], envOk, records, tmux, dead)
  }

  function Decide(expected: seq<string>, listed: set<string>, records: Option<map<string, string>>, tmux: Tmux, envOk: bool): Outcome {
    var missing := Missing(expected, listed);
    var lost := Keep(missing, envOk, records, tmux, false);
    Outcome(|lost| == 0, Keep(missing, envOk, records, tmux, true), lost)
  }

  lemma MissingMembers(expected: seq<string>, listed: set<string>)
    ensures forall x :: x in Missing(expected, listed) <==> (x in expected && x !in listed)
  {
    if |expected| > 0 {
      MissingMembers(expected[1..], listed);
      assert expected == [expected[0]] + expected[1..];
    }
  }

  lemma KeepMembers(ids: seq<string>, envOk: bool, records: Option<map<string, string>>, tmux: Tmux, dead: bool)
    ensures forall x :: x in Keep(ids, envOk, records, tmux, dead) <==> (x in ids && Dead(x, envOk, records, tmux) == dead)
  {
    if |ids| > 0 {
      KeepMembers(ids[1..], envOk, records, tmux, dead);
      assert ids == [ids[0]] + ids[1..];
    }
  }

  lemma KeepPartition(ids: seq<string>, envOk: bool, records: Option<map<string, string>>, tmux: Tmux)
    ensures |Keep(ids, envOk, records, tmux, true)| + |Keep(ids, envOk, records, tmux, false)| == |ids|
  {
    if |ids| > 0 { KeepPartition(ids[1..], envOk, records, tmux); }
  }

  lemma KeepAllNotDead(ids: seq<string>, envOk: bool, records: Option<map<string, string>>, tmux: Tmux)
    requires !envOk || records.None? || tmux.Unknown?
    ensures Keep(ids, envOk, records, tmux, false) == ids
    ensures Keep(ids, envOk, records, tmux, true) == []
  {
    if |ids| > 0 { KeepAllNotDead(ids[1..], envOk, records, tmux); }
  }

  // S1, safety: a pass means every expected session is listed by the new colour or provably dead.
  lemma PassMeansListedOrDead(expected: seq<string>, listed: set<string>, records: Option<map<string, string>>, tmux: Tmux, envOk: bool)
    ensures Decide(expected, listed, records, tmux, envOk).ok ==>
      forall id :: id in expected ==> id in listed || Dead(id, envOk, records, tmux)
  {
    MissingMembers(expected, listed);
    KeepMembers(Missing(expected, listed), envOk, records, tmux, false);
  }

  // S2: an expected session the new colour does not list, whose tmux session is still running, always
  // fails the check and is named in the failure.
  lemma RunningSessionLostFails(expected: seq<string>, listed: set<string>, records: Option<map<string, string>>, tmux: Tmux, envOk: bool, id: string)
    requires id in expected && id !in listed
    requires tmux.Running? && records.Some? && id in records.value && records.value[id] in tmux.names
    ensures !Decide(expected, listed, records, tmux, envOk).ok
    ensures id in Decide(expected, listed, records, tmux, envOk).lost
  {
    MissingMembers(expected, listed);
    KeepMembers(Missing(expected, listed), envOk, records, tmux, false);
  }

  // S3, fail closed: with no environment, no readable records or a tmux error, the check is exactly the old
  // one (every expected id must be listed, and every missing one is reported).
  lemma FailClosedIsOldCheck(expected: seq<string>, listed: set<string>, records: Option<map<string, string>>, tmux: Tmux, envOk: bool)
    requires !envOk || records.None? || tmux.Unknown?
    ensures Decide(expected, listed, records, tmux, envOk).ok <==> (forall id :: id in expected ==> id in listed)
    ensures Decide(expected, listed, records, tmux, envOk).lost == Missing(expected, listed)
  {
    MissingMembers(expected, listed);
    KeepAllNotDead(Missing(expected, listed), envOk, records, tmux);
    if Decide(expected, listed, records, tmux, envOk).ok {
      assert Missing(expected, listed) == [];
    } else {
      assert Missing(expected, listed)[0] in Missing(expected, listed);
    }
  }

  // S4, conservative: whatever the old check passed, the new one passes, and it excuses nothing.
  lemma OldPassStillPasses(expected: seq<string>, listed: set<string>, records: Option<map<string, string>>, tmux: Tmux, envOk: bool)
    requires forall id :: id in expected ==> id in listed
    ensures Decide(expected, listed, records, tmux, envOk).ok
    ensures Decide(expected, listed, records, tmux, envOk).excused == []
  {
    MissingMembers(expected, listed);
    if Missing(expected, listed) != [] {
      assert Missing(expected, listed)[0] in Missing(expected, listed);
    }
  }

  // S5, the report is exact: excused and lost split the missing ids, every lost id is expected, unlisted and
  // not provably dead, and every excused id is expected, unlisted and provably dead.
  lemma ReportIsExact(expected: seq<string>, listed: set<string>, records: Option<map<string, string>>, tmux: Tmux, envOk: bool)
    ensures var o := Decide(expected, listed, records, tmux, envOk);
      |o.excused| + |o.lost| == |Missing(expected, listed)| &&
      (forall id :: id in o.lost <==> (id in expected && id !in listed && !Dead(id, envOk, records, tmux))) &&
      (forall id :: id in o.excused <==> (id in expected && id !in listed && Dead(id, envOk, records, tmux)))
  {
    MissingMembers(expected, listed);
    KeepMembers(Missing(expected, listed), envOk, records, tmux, false);
    KeepMembers(Missing(expected, listed), envOk, records, tmux, true);
    KeepPartition(Missing(expected, listed), envOk, records, tmux);
  }
}
