import { targets, selectRegion } from './select.js';
import type { ViewObject } from './model.js';
import { nextFocus, siblings } from './tree.js';
import { pan, zoomAt, pinch, fit, type Point, type Rect, type Viewport } from './viewport.js';
export type RailView = 'keys' | 'reader';
export type ViewState = {
  viewport: Viewport;
  focusId: string | null;
  selected: string[];
  tool: 'select' | 'pan';
  outlineOpen: boolean;
  rail: RailView[];
  letters: boolean;
};
export type ViewCommand =
  | { kind: 'pan'; delta: Point }
  | { kind: 'zoom'; anchor: Point; factor: number }
  | { kind: 'pinch'; before: [Point, Point]; after: [Point, Point] }
  | { kind: 'fit'; bounds: Rect; area: Rect }
  | { kind: 'viewport'; viewport: Viewport }
  | { kind: 'focus'; id: string | null }
  | { kind: 'navigate'; step: number }
  | { kind: 'selection'; ids: string[] }
  | { kind: 'toggle'; id: string }
  | { kind: 'region'; region: Parameters<typeof selectRegion>[1]; parentId: string | null; toggle: boolean }
  | { kind: 'select-all' }
  | { kind: 'tool'; tool: ViewState['tool'] }
  | { kind: 'outline'; open: boolean }
  | { kind: 'rail'; view: RailView }
  | { kind: 'escape' }
  | { kind: 'letters'; enabled: boolean };
export const initialView = (): ViewState => ({
  viewport: { x: 0, y: 0, zoom: 1 },
  focusId: null,
  selected: [],
  tool: 'select',
  outlineOpen: true,
  rail: [],
  letters: true,
});
export function command(state: ViewState, action: ViewCommand, objects: ViewObject[]): ViewState {
  switch (action.kind) {
    case 'pan':
      return { ...state, viewport: pan(state.viewport, action.delta) };
    case 'zoom':
      return { ...state, viewport: zoomAt(state.viewport, action.anchor, action.factor) };
    case 'pinch':
      return { ...state, viewport: pinch(state.viewport, action.before, action.after) };
    case 'fit':
      return { ...state, viewport: fit(action.bounds, action.area) };
    case 'viewport':
      return { ...state, viewport: action.viewport };
    case 'focus':
      return { ...state, focusId: action.id };
    case 'navigate':
      return { ...state, focusId: nextFocus(objects, state.focusId, action.step) };
    case 'selection':
      return { ...state, selected: targets(objects, action.ids).map((o) => o.id) };
    case 'toggle': {
      const ids = state.selected.includes(action.id)
        ? state.selected.filter((id) => id !== action.id)
        : [...state.selected, action.id];
      return { ...state, selected: targets(objects, ids).map((o) => o.id) };
    }
    case 'region': {
      const ids = selectRegion(objects, action.region, action.parentId);
      return {
        ...state,
        selected: targets(
          objects,
          action.toggle
            ? [...state.selected.filter((id) => !ids.includes(id)), ...ids.filter((id) => !state.selected.includes(id))]
            : ids
        ).map((o) => o.id),
      };
    }
    case 'select-all':
      return {
        ...state,
        selected: siblings(objects, objects.find((o) => o.id === state.focusId)?.parentId ?? null).map((o) => o.id),
      };
    case 'tool':
      return { ...state, tool: action.tool };
    case 'outline':
      return { ...state, outlineOpen: action.open };
    case 'rail':
      return { ...state, rail: [...state.rail.filter((v) => v !== action.view), action.view] };
    case 'escape':
      return { ...state, rail: state.rail.slice(0, -1) };
    case 'letters':
      return { ...state, letters: action.enabled };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}
