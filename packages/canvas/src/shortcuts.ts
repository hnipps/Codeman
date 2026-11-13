export type KeyScope = { composing: boolean; editable: boolean; canvas: boolean; control: boolean };
export function shortcutAllowed(scope: KeyScope): boolean {
  return !scope.composing && !scope.editable && scope.canvas && !scope.control;
}
/** `later` marks a binding the Keys view lists but nothing handles yet. */
export type Shortcut = [string, string[][], 'later'?];
export const shortcuts: Shortcut[] = [
  ['Navigate siblings', [['J'], ['K'], ['↑'], ['↓']]],
  ['Toggle selection', [['X'], ['Space']]],
  ['Select immediate siblings', [['Mod', 'A']]],
  ['Read focused object', [['Enter']]],
  ['Drill into container', [['→']]],
  ['Focus parent', [['←']]],
  ['Open sub-canvas', [['Alt', '↓']]],
  ['Leave sub-canvas', [['Alt', '↑'], ['Esc']]],
  ['Search canvas', [['/']]],
  ['Export the canvas or the selected object', [['E']]],
  ['Show Keys', [['?'], ['F1']]],
  ['Select / pan tool', [['V'], ['H']]],
  ['Temporary pan (hold and drag)', [['Space']]],
  ['Pan (trackpad scroll)', []],
  ['Zoom about pointer (mouse wheel, pinch, or Mod + trackpad scroll)', []],
  ['Close current rail view', [['Esc']]],
];

export const editShortcuts: Shortcut[] = [
  ['Toggle assistant', [['C'], ['Mod', '.']]],
  ['Add selection to chat', [['Mod', 'Enter']]],
  ['Add objects to chat (hold and drag a loop; inside a live page, its elements)', [['Q']]],
  ['Pick an element in the selected embed', [['I']]],
  ['Dock the selected embed in the rail / open it in the full view', [['D'], ['F']]],
  ['Send chat message / line break', [['Enter'], ['Shift', 'Enter']]],
  ['Choose chat provider / model (focus the selector)', [['P'], ['Shift', 'P']]],
  ['Dictate into chat', [['B']]],
  ['Voice conversation in chat (press again to send the turn)', [['Shift', 'B']]],
  ['Inspect chat background agents', [['G']]],
  ['Run chat message in the background', [['Mod', 'Shift', 'Enter']]],
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
  [
    'Bring forward / to front',
    [
      ['Mod', ']'],
      ['Mod', 'Shift', ']'],
    ],
  ],
  [
    'Send backward / to back',
    [
      ['Mod', '['],
      ['Mod', 'Shift', '['],
    ],
  ],
  ['Disable pointer snapping (hold)', [['Ctrl']]],
  ['Delete selection', [['Delete']]],
  ['Undo canvas edit', [['Mod', 'Z']]],
  ['Redo canvas edit', [['Mod', 'Shift', 'Z']]],
  ['Move selection with arrows', [['M']]],
  ['Move mode: coarse / fine', [['↑'], ['Shift', '↑']]],
  ['Resize: proportional / from center', [['Shift'], ['Alt']]],
];
/** Listed in the Keys view only while the canvas is Codeman's shell (PC13). */
export const shellShortcuts: Shortcut[] = [
  [
    'Go to a session, workspace or object',
    [
      ['Mod', 'K'],
      ['Alt', 'K'],
    ],
  ],
  ['Focus the Sessions section', [['S']]],
  ['Open the workspace list', [['W']]],
  ['Open the focused session', [['Enter']]],
  // The session page's own key (rebindable in the classic view's Shortcuts); the canvas only lists it.
  ['Back to the canvas from a terminal', [['Ctrl', 'Shift', 'Backspace']]],
  ['Close a terminal that did not open', [['Esc']]],
];
