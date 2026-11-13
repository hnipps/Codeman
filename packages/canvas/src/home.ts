/**
 * @fileoverview The canvas shell's first-run page (PC13): what `/` shows when the person has no workspace yet.
 *
 * A second, small entry (`canvas-home.js`), so the page that tells someone how to begin does not depend on the
 * large canvas bundle. It draws into the canvas document's own loading state and hides the board chrome.
 */
import { bootReady } from './shell.js';

const state = document.getElementById('state');
document.documentElement.setAttribute('data-first-run', '');
document.title = 'Canvas';
if (state) {
  const heading = state.querySelector('h1');
  const text = state.querySelector('p');
  if (heading) heading.textContent = 'No workspace yet';
  if (text)
    text.textContent =
      'A workspace is the canvas of one case: its notes, sections and sessions. Create a case in the classic view, then open its canvas.';
}
bootReady();
