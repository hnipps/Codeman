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

export const editShortcuts: [string, string[][]][] = [
  ['Selection lasso (hold and drag)', [['Alt']]],
  ['Group selection', [['Mod', 'G']]],
  ['Ungroup selection', [['Mod', 'Shift', 'G']]],
  [
    'Copy / cut / paste selection',
    [
      ['Mod', 'C'],
      ['Mod', 'X'],
      ['Mod', 'V'],
    ],
  ],
  ['Duplicate selection', [['Mod', 'D']]],
  ['Disable pointer snapping (hold)', [['Ctrl']]],
  ['Delete selection', [['Delete']]],
  ['Undo canvas edit', [['Mod', 'Z']]],
  ['Redo canvas edit', [['Mod', 'Shift', 'Z']]],
  ['Move mode: coarse / fine', [['↑'], ['Shift', '↑']]],
  ['Resize: proportional / from center', [['Shift'], ['Alt']]],
];
