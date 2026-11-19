// Chat Graph UI prototype (W-78, revision 2). Static, illustrative content: every state of the chat is
// one page that sets <body data-state>. Layout follows the canvas: on a desktop the chat is a rail view
// beside the board; at 720px and under the rail is the whole viewport. UI copy says "thread"; the API
// and the code keep "topic". The shipped UI builds DOM with textContent; this prototype uses template
// strings because all of its text is fixed.
(() => {
  const state = document.body.dataset.state;
  const phone = matchMedia('(max-width: 720px)').matches;
  const theme = new URLSearchParams(location.search).get('theme');
  if (theme) document.documentElement.dataset.theme = theme;
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

  const I = {
    list: '<svg viewBox="0 0 16 16"><path d="M3 4h10M3 8h10M3 12h6"/></svg>',
    full: '<svg viewBox="0 0 16 16"><path d="M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10"/></svg>',
    close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
    back: '<svg viewBox="0 0 16 16"><path d="M10 3L5 8l5 5"/></svg>',
    more: '<svg viewBox="0 0 16 16"><circle cx="3.5" cy="8" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="12.5" cy="8" r=".6"/></svg>',
    plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>',
    down: '<svg viewBox="0 0 16 16"><path d="M5 6.5l3 3 3-3"/></svg>',
    check: '<svg viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-7"/></svg>',
    capture: '<svg viewBox="0 0 16 16"><path d="M5 3l5 5-5 5"/></svg>',
    chat: '<svg viewBox="0 0 16 16"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>',
    select: '<svg viewBox="0 0 16 16"><path d="M4 2.5l8 5-3.5 1-1.5 3.5z"/></svg>',
    pan: '<svg viewBox="0 0 16 16"><path d="M8 2v12M2 8h12M6 4l2-2 2 2M6 12l2 2 2-2M4 6l-2 2 2 2M12 6l2 2-2 2"/></svg>',
    add: '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M8 5.5v5M5.5 8h5"/></svg>',
    assist: '<svg viewBox="0 0 16 16"><path d="M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4z"/></svg>',
    search: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/></svg>',
    cards: '<svg viewBox="0 0 16 16"><rect x="2.5" y="5.5" width="11" height="8" rx="1.5"/><path d="M4.5 3.5h7"/></svg>',
    copy: '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5v-7h7"/></svg>',
  };
  const kbd = (k) => `<kbd>${k.replace('Mod+', mod)}</kbd>`;

  // ---------- data ----------
  // Active: a message in the last 7 days. Inactive: none for 7 days. Archived: archived by a person or a merge.
  const active = [
    ['Kitchen budget', '2m', 'Renovation capped at 18k. Worktop quote in at 2,350; tap and electrician still open.', '2 to do · 38 messages'],
    ['Garden shed', '4m', 'New today. Base about 3 by 2 metres; getting quotes.', '6 messages'],
    ['Conference talk', '9m', 'Talk on agent-built tools, 25 minutes. Demo reuses the release notes flow.', '1 to do · 21 messages'],
    ['Release notes', '9m', 'Next release: canvas voice and work lanes. Rollback wording still open.', '1 to do · 17 messages'],
    ['Laptop upgrade', '1d', 'Two 32 GB models. Battery life decides it.', '4 messages'],
    ['Errands', '3d', 'Stamps, council letter. Mostly captures.', '3 to do · 9 messages'],
  ];
  const inactive = [
    ['Bike service', '9d', 'Booked for the 28th; chain and brake pads.', '1 to do · 5 messages'],
    ['Holiday 2027', '2w', 'Two options for June, neither booked.', '11 messages'],
  ];
  const archived = [
    ['Shed plans', '3w', 'Earlier shed idea, parked when the budget went to the kitchen.', '12 messages'],
    ['Tax return 2025', '7mo', 'Filed in January.', '30 messages'],
    ['Office move', '9mo', 'Done.', '14 messages'],
  ];

  // ---------- pieces ----------
  // Chip: the thread's name. Bands differ by look, not by extra words; a chevron says it opens a menu.
  const chip = (band, name, extra = '') => {
    const lead = band === 'new' ? '<span class="new">New</span>' : '';
    const tail = ['unsure', 'new', 'unsorted'].includes(band) ? I.down : '';
    const dots = band === 'filing' ? '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>' : '';
    const dis = band === 'filing' ? ' aria-disabled="true"' : ' aria-haspopup="menu"';
    return `<button class="chip" data-band="${band}"${dis} ${extra}>${lead}<span>${name}</span>${dots}${tail}</button>`;
  };
  const you = (text, chips, time, opts = {}) => `
    <li class="turn" data-who="you">
      <div class="who">You${opts.tag ? ` <span class="tag">${opts.tag}</span>` : ''}<time>${time}</time></div>
      <div class="text${opts.md ? ' md' : ''}">${text}</div>
      ${chips || opts.menu ? `<div class="chips" style="position:relative">${chips}${opts.menu ?? ''}</div>` : ''}
      ${opts.after ?? ''}
    </li>`;
  const claude = (html, context, time, after = '') => `
    <li class="turn" data-who="claude">
      <div class="who">Claude<time>${time}</time></div>
      <div class="text md">${html}</div>
      ${context ? `<p class="context">Used ${context}</p>` : ''}
      ${after}
    </li>`;
  const ctx = (...names) =>
    names.map((n) => (n.endsWith(' card') ? `<a href="#">${n.slice(0, -5)}</a><span class="card">(card)</span>` : `<a href="#">${n}</a>`)).join('<span>·</span>');
  const related = `
    <div class="related" role="group" aria-label="Related thread">
      <p>Related: <b>Laptop upgrade</b></p>
      <span class="acts"><button class="quiet">File there too</button><button>Dismiss</button></span>
    </div>`;

  const head = (title, { back, list = true, full = true, close = true, sugg = 0, more = false, expanded = false } = {}) => `
    <div class="head">
      ${back ? `<button class="back">${I.back}<span>${back}</span></button>` : ''}
      <h1>${title}</h1>
      ${sugg ? `<button class="icon badge" aria-label="${sugg} suggestions" aria-expanded="${expanded}" title="Suggestions">${I.cards}<span class="n">${sugg}</span></button>` : ''}
      ${more ? `<button class="icon" aria-label="Thread actions" title="Merge, split, archive">${I.more}</button>` : ''}
      ${list ? `<button class="icon" aria-label="Threads" title="Threads · Shift+T">${I.list}</button>` : ''}
      ${full && !phone ? `<button class="icon" aria-label="Full view" title="Full view · F">${I.full}</button>` : ''}
      ${close ? `<button class="icon" aria-label="Close" title="Close · Esc">${I.close}</button>` : ''}
    </div>`;

  const composer = ({ draft = '', status = '', err = '', capture = false, placeholder = 'Message · > or Mod+U to capture', send = 'Send', note = '' } = {}) => `
    <form class="composer${capture ? ' capture' : ''}" onsubmit="return false">
      <label class="sr" for="draft">${capture ? 'Capture' : 'Message'}</label>
      <div class="field">
        ${capture ? `<span class="pill">${I.capture}Capture</span>` : ''}
        <textarea id="draft" rows="3" placeholder="${placeholder.replace('Mod+', mod)}">${draft}</textarea>
      </div>
      ${note ? `<p class="note">${note}</p>` : ''}
      ${err ? `<p class="err" role="alert">${err}</p>` : ''}
      <div class="row">
        <span class="status">${capture ? `No reply. ${kbd('Mod+U')} or Backspace to leave capture.` : status}</span><span class="gap"></span>
        <button class="primary">${capture ? 'Capture' : send}</button>
      </div>
    </form>`;

  // ---------- chat turns ----------
  const t1 = you('What is left on the kitchen? I think the worktop quote came back.', chip('sure', 'Kitchen budget'), '10:02');
  const r1 = claude(
    '<p>The worktop quote came in at 2,350, which leaves 1,120 under the 18k cap. Still open:</p><ul><li>Choose the tap</li><li>Book the electrician for the hob circuit</li></ul>',
    ctx('Kitchen budget'),
    '10:02',
  );
  const t2 = you('Can the talk demo reuse the release notes flow?', chip('unsure', 'Conference talk') + chip('sure', 'Release notes'), '10:05');
  const r2 = claude(
    '<p>Yes. The release notes flow already builds the changelog from merged items, so the demo can run it live on a small branch. Plan for about four minutes of the 25.</p>',
    ctx('Conference talk', 'Release notes', 'Laptop upgrade card'),
    '10:05',
    related,
  );
  const t3 = (menu = '') =>
    you('Need a quote for a garden shed base, about 3 by 2 metres.', chip('new', 'Garden shed', menu ? 'aria-expanded="true"' : ''), '10:09', { menu });
  const r3 = claude('<p>A 3 by 2 metre concrete base is about 0.6 cubic metres at 100 mm deep. Want me to draft a request for quotes?</p>', ctx('Garden shed'), '10:09');

  const chatMenu = `
    <div class="scrim"></div>
    <div class="menu" role="menu" aria-label="Thread for this message" style="top:34px;left:0">
      <p class="mh">New thread. Also matched <b>Shed plans</b>, archived.</p>
      <button role="menuitem"><span>Move…</span></button>
      <button role="menuitem"><span>Also file in…</span></button>
      <button role="menuitem"><span>Open Garden shed</span></button>
      <hr>
      <button role="menuitem" title="Unarchives Shed plans and moves this message there"><span>Move to Shed plans</span><span class="tag">Archived</span></button>
    </div>`;

  const convo = (turns, after = '') => `<div class="body"><ol class="turns">${turns.join('')}</ol>${after}</div>`;

  // ---------- thread lists ----------
  const listRow = ([t, time, sum, meta], current) => `
    <li><button class="topic"${current ? ' aria-current="true"' : ''}>
      <span class="tl"><span class="tt">${t}</span><time>${time}</time></span>
      <span class="sum">${sum}</span>
      <span class="meta">${meta}</span>
    </button></li>`;
  const unsortedRow = `
    <li><button class="topic unsorted">
      <span class="tl"><span class="tt">Unsorted</span><time>1m</time></span>
      <span class="meta"><span class="need">1 message to file</span></span>
    </button></li>`;
  const group = (label, rows, open, row, cls = '') =>
    `<details class="grp ${cls}"${open ? ' open' : ''}><summary>${I.down}<span>${label}</span><span class="num">${rows.length}</span></summary><ul>${rows.map(row).join('')}</ul></details>`;
  const threadList = ({ open = { active: 1, inactive: 1, archived: 0 }, unsorted = false, current = '' } = {}) => `
    <div class="search"><label class="sr" for="q">Find a thread</label><input id="q" type="search" placeholder="Find a thread"></div>
    <div class="body">
      ${unsorted ? `<ul class="topics">${unsortedRow}</ul>` : ''}
      ${group('Active', active, open.active, (r) => listRow(r, r[0] === current))}
      ${group('Inactive', inactive, open.inactive, (r) => listRow(r, r[0] === current))}
      ${group('Archived', archived, open.archived, (r) => listRow(r, r[0] === current), 'arch')}
      ${open.archived ? '<p class="empty-list">Archived threads take no new messages by themselves. Open one to unarchive it.</p>' : ''}
    </div>`;

  // The canvas outline: threads replace Sessions. Groups collapse; Sessions keeps a collapsed row at the end.
  const oRow = ([t, time], current) => `<li><a href="#"${current ? ' aria-current="true"' : ''}><span>${t}</span><time>${time}</time></a></li>`;
  const outline = ({ current = 'Kitchen budget', open = { active: 1, inactive: 0, archived: 0 }, unsorted = true } = {}) => `
    <nav class="outline" aria-label="Outline">
      <div class="osearch">${I.search}<span>Search</span>${kbd('/')}</div>
      <p class="oh">Threads<button aria-label="New thread" title="New thread">${I.plus}</button></p>
      ${unsorted ? '<a href="#" class="ounsorted"><span>Unsorted</span><span class="num">1</span></a>' : ''}
      ${group('Active', active, open.active, (r) => oRow(r, r[0] === current))}
      ${group('Inactive', inactive, open.inactive, (r) => oRow(r, r[0] === current))}
      ${group('Archived', archived, open.archived, (r) => oRow(r, r[0] === current), 'arch')}
      <p class="oh">Objects</p>
      <ul class="objs"><li><a href="#">Kitchen plan</a></li><li><a href="#">Talk outline</a></li><li><a href="#">Shed sketch</a></li></ul>
      ${group('Sessions', [['w1 · Working', ''], ['w2 · Idle', '']], false, (r) => oRow(r, false), 'sess')}
    </nav>`;

  // ---------- thread view ----------
  const suggestions = `
    <section class="sugg" aria-label="Suggestions">
      <div class="sh"><b>Suggestions</b><span class="num">3</span><span class="gap"></span><button class="icon" aria-label="Collapse suggestions" aria-expanded="true">${I.down}</button></div>
      <div class="sl">
        <div class="proposal"><p class="pk">Merge</p><p><b>Kitchen tap</b> (4 messages) belongs here.</p><div class="acts"><button class="quiet">Review</button><button>Not now</button></div></div>
        <div class="proposal"><p class="pk">Note from Laptop upgrade</p><p><q>Laptop budget moved 300 into the kitchen fund.</q></p><div class="acts"><button class="quiet">Add</button><button>Reject</button></div></div>
        <div class="proposal"><p class="pk">Split</p><p>Last 9 messages are about the <b>hob circuit</b>.</p><div class="acts"><button class="quiet">Review</button><button>Not now</button></div></div>
      </div>
    </section>`;
  const todo = (open) => `
    <details class="todo"${open ? ' open' : ''}>
      <summary>${I.down}<span>To do</span><span class="num">2</span><span class="hint">Tasks and captures still open in this thread</span></summary>
      <ul class="items">
        <li><input type="checkbox" aria-label="Done"><span>Choose the tap</span></li>
        <li><input type="checkbox" aria-label="Done"><span>Book the electrician for the hob circuit <span class="from">capture</span></span></li>
        <li class="additem"><button>${I.plus}Add</button></li>
      </ul>
    </details>`;
  const threadTurns = [
    you('Did the cabinet delivery date move?', '', '09:40'),
    claude('<p>No, still Thursday. They confirmed by email on Monday.</p>', '', '09:40'),
    you('electrician for the hob', '', 'Mon', { tag: 'Capture' }),
    you('What is left on the kitchen? I think the worktop quote came back.', '', '10:02'),
    claude('<p>The worktop quote came in at 2,350, which leaves 1,120 under the 18k cap. Still open: the tap and the electrician.</p>', '', '10:02'),
  ];
  const threadView = ({ undo = false, sugg = false, todoOpen = true, down = false, inFull = false, draft = '' } = {}) => `
    ${inFull ? '' : head('Kitchen budget', { back: 'Threads', list: false, sugg: down ? 0 : 3, more: !down, expanded: sugg })}
    ${down ? '<div class="strip warn" role="status">Chat is down. Messages here go straight to this thread and are filed when it is back.</div>' : ''}
    ${sugg ? suggestions : ''}
    <div class="pinned">
      <p class="summary clamp">Renovation capped at 18k. Cabinets ordered and paid. Worktop quote in at 2,350, leaving 1,120. The electrician needs a separate circuit for the hob.</p>
      <p class="ver">${down ? 'Saved copy from 10:02' : 'Summary v6 · 10:02 · <a href="#">Edit</a> · <a href="#">History</a>'}</p>
      ${todo(todoOpen)}
    </div>
    <div class="body latest">
      <p class="earlier"><a href="#">Earlier messages</a> <span class="num">33</span></p>
      <ol class="turns compact">${threadTurns.join('')}</ol>
    </div>
    ${undo ? `<div class="notice" role="status"><span>Moved 1 message here.</span><button>Undo</button></div>` : ''}
    ${composer({ placeholder: 'Message Kitchen budget', draft, note: down ? 'Pasted from Chat.' : '' })}`;

  // ---------- states ----------
  const views = {
    chat: () => head('Chat') + convo([t1, r1, t2, r2, t3(), r3]) + composer(),
    'chip-menu': () => head('Chat') + convo([t1, r1, t2, r2, t3(chatMenu), r3]) + composer(),
    routing: () =>
      head('Chat') +
      convo(
        [t2, r2, t3(), r3, you('Ok, do that for the shed too.', chip('filing', 'Filing'), '10:11')],
        '<p class="state" role="status">Filing · <span class="num">3 s</span></p>',
      ) +
      composer({ draft: 'and remind me to measure the side gate', status: 'Keep typing. Each message files on its own.' }),
    capture: () =>
      head('Chat') +
      convo([
        t3(),
        r3,
        you('<blockquote>The base must sit 150 mm clear of the boundary fence.</blockquote><p>from the council page, check before ordering</p>', chip('sure', 'Garden shed'), '10:13', {
          tag: 'Capture',
          md: true,
          after: `<p class="ack">${I.check}Captured to Garden shed</p>`,
        }),
        you('buy stamps for the council letter', chip('sure', 'Errands'), '10:14', { tag: 'Capture', after: `<p class="ack">${I.check}Captured to Errands</p>` }),
      ]) +
      composer({ draft: '> Sizes from the brochure:\n6x4 £420, 8x6 £610\nask about delivery', capture: true }),
    unsorted: () =>
      head('Chat') +
      convo([
        t3(),
        r3,
        you('Use the numbers from before for that one.', chip('unsorted', 'Unsorted'), '10:16', {
          after: '<p class="why">Not filed in time. Pick a thread to get a reply.</p>',
        }),
      ]) +
      composer(),
    unavailable: () =>
      head('Chat') +
      convo([t1, r1, t2, r2]) +
      `<div class="down" role="alert">
        <p><b>Chat can't file messages right now.</b> ${I.copy}Your message is copied. Send it in a thread:</p>
        <div class="picks"><button class="quiet">Kitchen budget</button><button class="quiet">Conference talk</button><button class="quiet">Garden shed</button><button>All threads</button></div>
      </div>` +
      composer({ draft: 'Remind me what the tap shortlist was.', send: 'Retry' }),
    'unavailable-thread': () => threadView({ down: true, todoOpen: false, draft: 'Remind me what the tap shortlist was.' }),
    empty: () =>
      head('Chat') +
      `<div class="body"><div class="empty">
        <h2>One chat for everything</h2>
        <p>Write about anything. Each message is filed to a thread, shown under it. Tap that to move it.</p>
        <p>Start with <code>&gt;</code> or press ${kbd('Mod+U')} to capture a thought with no reply.</p>
      </div></div>` +
      composer(),
    bootstrap: () =>
      head('Chat') +
      `<div class="strip" role="status">Filing your last 7 days of conversations · <span class="num">46 of 120 filed</span><div class="bar"><i style="width:38%"></i></div></div>` +
      convo(
        [you('What did we decide about the release notes wording?', chip('sure', 'Release notes'), '09:40'), claude('<p>Rollback wording is still open. The rest of the notes are drafted.</p>', ctx('Release notes'), '09:40')],
        '<p class="state">New messages are filed first.</p>',
      ) +
      composer(),
    topics: () => head('Threads', { back: 'Chat', list: false }) + threadList({ unsorted: true }),
    archived: () => head('Threads', { back: 'Chat', list: false }) + threadList({ open: { active: 0, inactive: 0, archived: 1 } }),
    topic: () => threadView({ undo: true }),
    'topic-suggestions': () => threadView({ sugg: true, todoOpen: false }),
    outline: () => threadView({ todoOpen: false }),
  };

  // ---------- full view explorations (desktop) ----------
  const fullConvo = (title, turns, placeholder, opts = {}) => `
    <section class="conv">
      <div class="head">${opts.lead ?? ''}<h1>${title}</h1>${opts.tools ?? ''}</div>
      ${convo(turns)}
      ${composer({ placeholder })}
    </section>`;
  const details = `
    <section class="details">
      <div class="head"><h1>Details</h1><button class="icon" aria-label="Thread actions" title="Merge, split, archive">${I.more}</button></div>
      <div class="body">
        <h2 class="lbl">Summary</h2>
        <p class="summary">Renovation capped at 18k. Cabinets ordered and paid. Worktop quote in at 2,350, leaving 1,120. The electrician needs a separate circuit for the hob.</p>
        <p class="ver">v6 · 10:02 · <a href="#">Edit</a> · <a href="#">History</a></p>
        ${todo(true)}
        <details class="todo"><summary>${I.down}<span>Suggestions</span><span class="num need">3</span></summary></details>
      </div>
    </section>`;
  const threadTurnsFull = threadTurns.slice(3).concat([you('Book the electrician for Friday if they can.', '', '10:20'), claude('<p>I will draft the message to the electrician. Friday morning or afternoon?</p>', '', '10:20')]);
  const sideList = (current, withChat = true) => `
    <section class="side">
      <div class="head"><h1>Threads</h1><button class="icon" aria-label="Back to the rail" title="Back to the rail · F">${I.full}</button></div>
      ${withChat ? `<a href="#" class="pin"${current === 'Chat' ? ' aria-current="true"' : ''}>${I.chat}<span>Chat</span>${kbd('Mod+0')}</a>` : ''}
      ${threadList({ unsorted: true, current, open: { active: 1, inactive: 0, archived: 0 } }).replace('class="body"', 'class="body tight"')}
    </section>`;
  const palette = (mode) => `
    <div class="pscrim"></div>
    <div class="palette${mode === 'capture' ? ' small' : ''}" role="dialog" aria-label="${mode === 'capture' ? 'Capture' : 'Chat'}">
      <div class="ptabs" role="tablist">
        <button role="tab" aria-selected="${mode === 'chat'}">${I.chat}Chat ${kbd('Mod+K')}</button>
        <button role="tab" aria-selected="${mode === 'capture'}">${I.capture}Capture ${kbd('Mod+U')}</button>
        <button role="tab" aria-selected="false">Commands ${kbd('Mod+P')}</button>
      </div>
      ${
        mode === 'chat'
          ? `<div class="body pturns"><ol class="turns compact">${[t2, r2.replace(related, ''), t3(), r3].join('')}</ol></div>
             <div class="pin-input"><textarea rows="2" placeholder="Ask anything · > to capture">Book the shed base quotes for next week</textarea><button class="primary">Send</button></div>
             <p class="pfoot">Files to a thread on its own. ${kbd('Enter')} send · ${kbd('Mod+Enter')} send and open the thread · ${kbd('Esc')} close</p>`
          : `<div class="pin-input"><div class="field"><span class="pill">${I.capture}Capture</span><textarea rows="3">bring the tile offcuts to the garage\n> Sam said the grey ones are spare</textarea></div><button class="primary">Capture</button></div>
             <p class="pfoot">No reply. Filed to a thread on its own. Your focus stays where it was.</p>
             <div class="recent"><p class="lbl">Recent captures</p>
               <p>buy stamps for the council letter ${chip('sure', 'Errands')}<time>10:14</time></p>
               <p>The base must sit 150 mm clear… ${chip('sure', 'Garden shed')}<time>10:13</time></p>
             </div>`
      }
    </div>`;
  const fullViews = {
    // A: three columns. The focused conversation in the middle; Chat is pinned first in the list.
    full: () => `<div class="full a">${sideList('Kitchen budget')}${fullConvo('Kitchen budget', threadTurnsFull, `Message Kitchen budget · Mod+U to capture`, { tools: `<button class="quiet">${I.chat}Chat ${kbd('Mod+0')}</button>` })}${details}</div>`,
    // B: tabs. Open conversations as tabs; details in a drawer; Mod+U opens a capture line under the tabs.
    'full-b': () => `<div class="full b">
      <div class="tabs" role="tablist">
        <button role="tab">${I.chat}Chat</button>
        <button role="tab" aria-selected="true">Kitchen budget<span class="x">${I.close}</span></button>
        <button role="tab">Conference talk<span class="x">${I.close}</span></button>
        <button role="tab">Garden shed<span class="x">${I.close}</span></button>
        <button class="icon" aria-label="Open a thread">${I.plus}</button>
        <span class="gap"></span>
        <button class="quiet">${I.list}Threads</button><button class="quiet">Details</button>
      </div>
      <div class="capline"><span class="pill">${I.capture}Capture</span><input value="ask Sam about the tile offcuts" aria-label="Capture"><span class="small sec">Files on its own · ${kbd('Enter')} · ${kbd('Esc')}</span></div>
      ${fullConvo('Kitchen budget', threadTurnsFull, 'Message Kitchen budget · Mod+U to capture')}
    </div>`,
    // C: side by side. Chat on the left stays the place to think out loud; the focused thread on the right.
    'full-c': () => `<div class="full c">
      ${fullConvo('Chat', [t1, r1, t2, r2, t3(), r3], 'Message · > or Mod+U to capture', { lead: '' })}
      ${fullConvo('Kitchen budget', threadTurnsFull, 'Message Kitchen budget', { lead: '', tools: `<button class="quiet switch">Switch ${I.down}</button><button class="icon badge" aria-label="3 suggestions" title="Suggestions">${I.cards}<span class="n">3</span></button>` })}
    </div>`,
    // D: threads only in the full view; the main chat is a palette on Mod+K.
    'full-d': () => `<div class="full d">${sideList('Kitchen budget', false)}${fullConvo('Kitchen budget', threadTurnsFull, 'Message Kitchen budget')}${details}</div>${palette('chat')}`,
    // E: capture palette over whatever has focus (here the canvas board with a thread in the rail).
    'full-e': () => `<div class="board">${outline()}<div class="ghost" style="left:300px;top:90px;width:300px;height:200px"></div><div class="ghost" style="left:640px;top:140px;width:180px;height:260px"></div></div><aside class="rail" aria-label="Chat">${threadView({ todoOpen: false })}</aside>${palette('capture')}`,
  };

  const app = document.getElementById('app');
  if (fullViews[state] && !phone) {
    app.innerHTML = fullViews[state]();
    for (const b of document.querySelectorAll('.conv .body, .pturns')) b.scrollTop = b.scrollHeight;
    return;
  }
  const name = fullViews[state] ? 'chat' : state;

  const board = phone
    ? ''
    : `<div class="board" aria-hidden="${name !== 'outline'}">
        ${outline({ open: name === 'outline' ? { active: 1, inactive: 1, archived: 1 } : undefined, current: name === 'outline' ? 'Kitchen budget' : ['topic', 'topic-suggestions', 'unavailable-thread'].includes(name) ? 'Kitchen budget' : '' })}
        <div class="ghost" style="left:300px;top:90px;width:300px;height:200px"></div>
        <div class="ghost" style="left:640px;top:140px;width:180px;height:260px"></div>
        <div class="ghost" style="left:330px;top:340px;width:260px;height:150px"></div>
        <div class="dock">
          <button>${I.select}</button><button>${I.pan}</button><button>${I.add}</button>
          <button title="Assistant · C">${I.assist}</button>
          <button aria-pressed="true" title="Chat · T">${I.chat}</button>
        </div>
      </div>`;
  app.innerHTML = `${board}<aside class="rail" aria-label="Chat">${views[name]()}</aside>`;
  // A conversation opens at its end, like the canvas assistant's; lists open at the top.
  if (!['topics', 'archived'].includes(name)) for (const b of document.querySelectorAll('.rail .body')) b.scrollTop = b.scrollHeight;
})();
