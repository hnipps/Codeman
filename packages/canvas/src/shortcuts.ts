export type KeyScope = { composing: boolean; editable: boolean; canvas: boolean; control: boolean };
export function shortcutAllowed(scope: KeyScope): boolean {
  return !scope.composing && !scope.editable && scope.canvas && !scope.control;
}
export const shortcuts = [
  ['Navigate siblings', 'J / K · arrows'],
  ['Toggle selection', 'X · tap Space'],
  ['Select immediate siblings', 'Ctrl/Cmd A'],
  ['Read focused object', 'Enter'],
  ['Drill into container', 'ArrowRight'],
  ['Focus parent', 'ArrowLeft'],
  ['Search canvas', '/'],
  ['Show Keys', '? · F1'],
  ['Select / pan tool', 'V / H'],
  ['Temporary pan', 'Hold Space + drag'],
  ['Zoom about pointer', 'Wheel · pinch'],
  ['Close current rail view', 'Escape'],
];
