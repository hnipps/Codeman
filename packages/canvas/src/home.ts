/**
 * @fileoverview The canvas shell's first-run page (PC13): what `/` shows when the person has no workspace yet.
 *
 * A second, small entry (`canvas-home.js`), so the page that tells someone how to begin does not depend on the
 * large canvas bundle. It draws into the canvas document's own state section and hides the board chrome. It lists
 * the cases with Open canvas, offers one field for a new case, and links to the classic view. Nothing is created
 * until the person presses a button.
 */
import { joinBasePath } from '../../../src/config/base-path.js';
import { bootReady } from './shell.js';
import { caseChoices, parseCases, workspaceHref } from './workspaces.js';
import { createCaseWorkspace, workspaceOfCase, type Made } from './workspace-actions.js';

const base = new URL(document.baseURI).pathname.replace(/\/$/, '');
const url = (path: string): string => joinBasePath(base, path);
const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text = ''): HTMLElementTagNameMap[K] => {
  const made = document.createElement(tag);
  if (text) made.textContent = text;
  return made;
};

document.documentElement.setAttribute('data-first-run', '');
document.title = 'Canvas';
const state = document.getElementById('state');
if (state) {
  const heading = state.querySelector('h1');
  const text = state.querySelector('p');
  if (heading) heading.textContent = 'Start with a workspace';
  if (text)
    text.textContent =
      'A workspace is the canvas of one case: a board for its notes and sections, with the sessions that run in its folder.';
  const box = make('div');
  box.id = 'firstRun';
  const casesTitle = make('p', 'Your cases');
  casesTitle.id = 'firstRunCasesTitle';
  casesTitle.hidden = true;
  const list = make('ul');
  list.id = 'firstRunCases';
  list.setAttribute('aria-labelledby', 'firstRunCasesTitle');
  const form = make('form');
  const label = make('label', 'New case name');
  label.className = 'sr';
  label.htmlFor = 'firstRunName';
  const name = make('input');
  name.id = 'firstRunName';
  name.placeholder = 'New case name';
  name.autocomplete = 'off';
  name.maxLength = 100;
  name.setAttribute('aria-describedby', 'firstRunReason');
  const create = make('button', 'Create');
  create.id = 'firstRunCreate';
  create.type = 'submit';
  form.append(label, name, create);
  const reason = make('p');
  reason.id = 'firstRunReason';
  reason.setAttribute('role', 'status');
  box.append(casesTitle, list, form, reason);
  // Above the retry button and the classic link the document already carries.
  state.insertBefore(box, document.getElementById('retry'));

  let busy = false;
  /** One create at a time. A refusal shows the server's reason and keeps what was typed. */
  const run = async (action: () => Promise<Made>, control: HTMLElement): Promise<void> => {
    if (busy) return;
    busy = true;
    control.setAttribute('aria-busy', 'true');
    reason.textContent = 'Opening…';
    const made = await action();
    busy = false;
    control.removeAttribute('aria-busy');
    if (!made.ok) {
      reason.textContent = made.reason;
      return;
    }
    location.assign(new URL(workspaceHref(made.workspaceId), document.baseURI).href);
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void run(() => createCaseWorkspace(url, name.value.trim()), create);
  });

  void fetch(url('/api/cases'))
    .then(async (response) => (response.ok ? parseCases(await response.json()) : null))
    .catch(() => null)
    .then((cases) => {
      if (!cases) {
        reason.textContent = 'Your cases could not load. A new case can still be named here.';
        return;
      }
      const names = caseChoices(cases, []);
      casesTitle.hidden = !names.length;
      list.replaceChildren(
        ...names.map((caseName) => {
          const item = make('li');
          const shown = make('span', caseName);
          shown.className = 'case-name';
          shown.title = caseName;
          const open = make('button', 'Open canvas');
          open.type = 'button';
          open.className = 'case-open';
          open.dataset.caseName = caseName;
          open.setAttribute('aria-label', `Open canvas for ${caseName}`);
          open.onclick = () => void run(() => workspaceOfCase(url, caseName), open);
          item.append(shown, open);
          return item;
        })
      );
    });
}
bootReady();
