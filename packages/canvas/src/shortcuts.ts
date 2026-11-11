export type KeyScope = { composing: boolean; editable: boolean; canvas: boolean; control: boolean };
export function shortcutAllowed(scope: KeyScope): boolean {
  return !scope.composing && !scope.editable && scope.canvas && !scope.control;
}
export const shortcuts: [string, string[][]][] = [
  ['Navigate siblings', [['J'], ['K'], ['↑'], ['↓']]],
  ['Toggle selection', [['X'], ['Space']]],
  ['Select immediate siblings', [['Mod', 'A']]],
  ['Read focused object', [['Enter']]],
  ['Drill into container', [['→']]],
  ['Focus parent', [['←']]],
  ['Search canvas', [['/']]],
  ['Show Keys', [['?'], ['F1']]],
  ['Select / pan tool', [['V'], ['H']]],
  ['Temporary pan (hold and drag)', [['Space']]],
  ['Zoom about pointer (wheel or pinch)', []],
  ['Close current rail view', [['Esc']]],
];
