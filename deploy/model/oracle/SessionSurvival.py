import sys
from typing import Callable, Any, TypeVar, NamedTuple
from math import floor
from itertools import count

import module_ as module_
import _dafny as _dafny
import System_ as System_

# Module: SessionSurvival

class default__:
    def  __init__(self):
        pass

    @staticmethod
    def Dead(id_, envOk, records, tmux):
        return ((((envOk) and ((records).is_Some)) and ((id_) in ((records).value))) and (not((tmux).is_Unknown))) and (((tmux).is_NoServer) or ((((records).value)[id_]) not in ((tmux).names)))

    @staticmethod
    def Missing(expected, listed):
        d_0___accumulator_ = _dafny.SeqWithoutIsStrInference([])
        while True:
            with _dafny.label():
                if (len(expected)) == (0):
                    return (d_0___accumulator_) + (_dafny.SeqWithoutIsStrInference([]))
                elif True:
                    d_0___accumulator_ = (d_0___accumulator_) + ((_dafny.SeqWithoutIsStrInference([]) if ((expected)[0]) in (listed) else _dafny.SeqWithoutIsStrInference([(expected)[0]])))
                    in0_ = _dafny.SeqWithoutIsStrInference((expected)[1::])
                    in1_ = listed
                    expected = in0_
                    listed = in1_
                    raise _dafny.TailCall()
                break

    @staticmethod
    def Keep(ids, envOk, records, tmux, dead):
        d_0___accumulator_ = _dafny.SeqWithoutIsStrInference([])
        while True:
            with _dafny.label():
                if (len(ids)) == (0):
                    return (d_0___accumulator_) + (_dafny.SeqWithoutIsStrInference([]))
                elif True:
                    d_0___accumulator_ = (d_0___accumulator_) + ((_dafny.SeqWithoutIsStrInference([(ids)[0]]) if (default__.Dead((ids)[0], envOk, records, tmux)) == (dead) else _dafny.SeqWithoutIsStrInference([])))
                    in0_ = _dafny.SeqWithoutIsStrInference((ids)[1::])
                    in1_ = envOk
                    in2_ = records
                    in3_ = tmux
                    in4_ = dead
                    ids = in0_
                    envOk = in1_
                    records = in2_
                    tmux = in3_
                    dead = in4_
                    raise _dafny.TailCall()
                break

    @staticmethod
    def Decide(expected, listed, records, tmux, envOk):
        d_0_missing_ = default__.Missing(expected, listed)
        d_1_lost_ = default__.Keep(d_0_missing_, envOk, records, tmux, False)
        return Outcome_Outcome((len(d_1_lost_)) == (0), default__.Keep(d_0_missing_, envOk, records, tmux, True), d_1_lost_)


class Option:
    @classmethod
    def default(cls, ):
        return lambda: Option_None()
    def __ne__(self, __o: object) -> bool:
        return not self.__eq__(__o)
    @property
    def is_None(self) -> bool:
        return isinstance(self, Option_None)
    @property
    def is_Some(self) -> bool:
        return isinstance(self, Option_Some)

class Option_None(Option, NamedTuple('None_', [])):
    def __dafnystr__(self) -> str:
        return f'SessionSurvival.Option.None'
    def __eq__(self, __o: object) -> bool:
        return isinstance(__o, Option_None)
    def __hash__(self) -> int:
        return super().__hash__()

class Option_Some(Option, NamedTuple('Some', [('value', Any)])):
    def __dafnystr__(self) -> str:
        return f'SessionSurvival.Option.Some({_dafny.string_of(self.value)})'
    def __eq__(self, __o: object) -> bool:
        return isinstance(__o, Option_Some) and self.value == __o.value
    def __hash__(self) -> int:
        return super().__hash__()


class Tmux:
    @classmethod
    def default(cls, ):
        return lambda: Tmux_Running(_dafny.Set({}))
    def __ne__(self, __o: object) -> bool:
        return not self.__eq__(__o)
    @property
    def is_Running(self) -> bool:
        return isinstance(self, Tmux_Running)
    @property
    def is_NoServer(self) -> bool:
        return isinstance(self, Tmux_NoServer)
    @property
    def is_Unknown(self) -> bool:
        return isinstance(self, Tmux_Unknown)

class Tmux_Running(Tmux, NamedTuple('Running', [('names', Any)])):
    def __dafnystr__(self) -> str:
        return f'SessionSurvival.Tmux.Running({_dafny.string_of(self.names)})'
    def __eq__(self, __o: object) -> bool:
        return isinstance(__o, Tmux_Running) and self.names == __o.names
    def __hash__(self) -> int:
        return super().__hash__()

class Tmux_NoServer(Tmux, NamedTuple('NoServer', [])):
    def __dafnystr__(self) -> str:
        return f'SessionSurvival.Tmux.NoServer'
    def __eq__(self, __o: object) -> bool:
        return isinstance(__o, Tmux_NoServer)
    def __hash__(self) -> int:
        return super().__hash__()

class Tmux_Unknown(Tmux, NamedTuple('Unknown', [])):
    def __dafnystr__(self) -> str:
        return f'SessionSurvival.Tmux.Unknown'
    def __eq__(self, __o: object) -> bool:
        return isinstance(__o, Tmux_Unknown)
    def __hash__(self) -> int:
        return super().__hash__()


class Outcome:
    @classmethod
    def default(cls, ):
        return lambda: Outcome_Outcome(False, _dafny.Seq({}), _dafny.Seq({}))
    def __ne__(self, __o: object) -> bool:
        return not self.__eq__(__o)
    @property
    def is_Outcome(self) -> bool:
        return isinstance(self, Outcome_Outcome)

class Outcome_Outcome(Outcome, NamedTuple('Outcome', [('ok', Any), ('excused', Any), ('lost', Any)])):
    def __dafnystr__(self) -> str:
        return f'SessionSurvival.Outcome.Outcome({_dafny.string_of(self.ok)}, {_dafny.string_of(self.excused)}, {_dafny.string_of(self.lost)})'
    def __eq__(self, __o: object) -> bool:
        return isinstance(__o, Outcome_Outcome) and self.ok == __o.ok and self.excused == __o.excused and self.lost == __o.lost
    def __hash__(self) -> int:
        return super().__hash__()

