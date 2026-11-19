"""Runs the Dafny model's Decide (oracle/, built from SessionSurvival.dfy) on a batch of cases.

stdin:  a JSON array of {"expected": [str], "listed": [str], "records": {id: muxName} | null,
        "tmux": {"kind": "running", "names": [str]} | {"kind": "none"} | {"kind": "unknown"}, "envOk": bool}
stdout: a JSON array of {"ok": bool, "excused": [str], "lost": [str]}, one per case, in order.

The oracle side of test/session-survival.drt.test.ts. Run it with `python3 -I -B` (no bytecode files next to the generated code).
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "oracle"))

import _dafny  # noqa: E402
import SessionSurvival  # noqa: E402

M = SessionSurvival.default__


def dstr(s):
    return _dafny.SeqWithoutIsStrInference([_dafny.CodePoint(c) for c in s])


def pystr(seq):
    return "".join(str(c) for c in seq)


def tmux_of(t):
    if t["kind"] == "running":
        return SessionSurvival.Tmux_Running(_dafny.Set([dstr(n) for n in t["names"]]))
    if t["kind"] == "none":
        return SessionSurvival.Tmux_NoServer()
    return SessionSurvival.Tmux_Unknown()


def decide(case):
    records = case["records"]
    rec = (
        SessionSurvival.Option_None()
        if records is None
        else SessionSurvival.Option_Some(_dafny.Map({dstr(k): dstr(v) for k, v in records.items()}))
    )
    out = M.Decide(
        _dafny.SeqWithoutIsStrInference([dstr(i) for i in case["expected"]]),
        _dafny.Set([dstr(i) for i in case["listed"]]),
        rec,
        tmux_of(case["tmux"]),
        bool(case["envOk"]),
    )
    return {"ok": bool(out.ok), "excused": [pystr(i) for i in out.excused], "lost": [pystr(i) for i in out.lost]}


json.dump([decide(c) for c in json.load(sys.stdin)], sys.stdout)
