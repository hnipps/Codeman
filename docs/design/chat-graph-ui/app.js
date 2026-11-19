// Chat Graph UI prototype (W-78). Static, illustrative content: every state of the chat is one page
// that sets <body data-state>. Layout follows the canvas: on a desktop the chat is a rail view beside
// the board; at 720px and under the rail is the whole viewport. The shipped UI builds DOM with
// textContent; this prototype uses template strings because all of its text is fixed.
(() => {
  const state = document.body.dataset.state;
  const phone = matchMedia('(max-width: 720px)').matches;
  const theme = new URLSearchParams(location.search).get('theme');
  if (theme) document.documentElement.dataset.theme = theme;

  const I = {
    topics: '<svg viewBox="0 0 16 16"><path d="M3 4h10M3 8h10M3 12h6"/></svg>',
    full: '<svg viewBox="0 0 16 16"><path d="M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10"/></svg>',
    close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
    back: '<svg viewBox="0 0 16 16"><path d="M10 3L5 8l5 5"/></svg>',
    more: '<svg viewBox="0 0 16 16"><circle cx="3.5" cy="8" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="12.5" cy="8" r=".6"/></svg>',
    plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>',
    down: '<svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4"/></svg>',
    check: '<svg viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-7"/></svg>',
    capture: '<svg viewBox="0 0 16 16"><path d="M5 3l5 5-5 5"/></svg>',
    chat: '<svg viewBox="0 0 16 16"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>',
    select: '<svg viewBox="0 0 16 16"><path d="M4 2.5l8 5-3.5 1-1.5 3.5z"/></svg>',
    pan: '<svg viewBox="0 0 16 16"><path d="M8 2v12M2 8h12M6 4l2-2 2 2M6 12l2 2 2-2M4 6l-2 2 2 2M12 6l2 2-2 2"/></svg>',
    add: '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M8 5.5v5M5.5 8h5"/></svg>',
    assist: '<svg viewBox="0 0 16 16"><path d="M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4z"/></svg>',
    search: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/></svg>',
  };

  // ---------- pieces ----------
  const chip = (band, name, tail = '', extra = '') => {
    const lead = { new: I.plus, unsorted: '', filing: '', capture: I.capture }[band] ?? '';
    const label = band === 'new' ? `New topic: ${name}` : name;
    const t = tail ? `<span class="tail">${tail}</span>` : '';
    const dis = band === 'filing' ? ' aria-disabled="true"' : '';
    return `<button class="chip" data-band="${band}"${dis} aria-haspopup="menu" ${extra}>${lead}<span>${label}</span>${t}</button>`;
  };
  const you = (text, chips, time, opts = {}) => `
    <li class="turn" data-who="you">
      <div class="who">You${opts.tag ? ` <span class="tag">${opts.tag}</span>` : ''}<time>${time}</time></div>
      <p class="text">${text}</p>
      <div class="chips" style="position:relative">${chips}${opts.menu ?? ''}</div>
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
    <div class="related" role="group" aria-label="Related topic">
      <p>Related: <b>Laptop upgrade</b>. The demo was planned on the new laptop.</p>
      <span class="acts"><button class="quiet">Also file there</button><button>Dismiss</button></span>
    </div>`;

  const head = (title, { back, list = true, full = true } = {}) => `
    <div class="head">
      ${back ? `<button class="back">${I.back}<span>${back}</span></button>` : ''}
      <h1>${title}</h1>
      ${list ? `<button class="icon" aria-label="Topics" title="Topics · Shift+T">${I.topics}</button>` : ''}
      ${full && !phone ? `<button class="icon" aria-label="Full screen" title="Full screen · F">${I.full}</button>` : ''}
      <button class="icon" aria-label="Close" title="Close · Esc">${I.close}</button>
    </div>`;

  const composer = ({ draft = '', status = '', err = '', capture = false, placeholder = 'Message, or start with > to capture', send = 'Send' } = {}) => `
    <form class="composer${capture ? ' capture' : ''}" onsubmit="return false">
      <label class="sr" for="draft">Message</label>
      <textarea id="draft" rows="3" placeholder="${placeholder}">${draft}</textarea>
      ${capture ? `<p class="capture-hint">${I.capture}Capture: filed to a topic, no reply.</p>` : ''}
      ${err ? `<p class="err" role="alert">${err}</p>` : ''}
      <div class="row">
        <span class="status">${status}</span><span class="gap"></span>
        ${err ? '<button class="quiet">Retry</button>' : ''}
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
  const t2 = you(
    'Can the talk demo reuse the release notes flow?',
    chip('unsure', 'Conference talk', 'Change') + chip('sure', 'Release notes'),
    '10:05',
  );
  const r2 = claude(
    '<p>Yes. The release notes flow already builds the changelog from merged items, so the demo can run it live on a small branch. Plan for about four minutes of the 25.</p>',
    ctx('Conference talk', 'Release notes', 'Laptop upgrade card'),
    '10:05',
    related,
  );
  const t3 = (menu = '') =>
    you('Need a quote for a garden shed base, about 3 by 2 metres.', chip('new', 'Garden shed', 'Change', menu ? 'aria-expanded="true"' : ''), '10:09', { menu });
  const r3 = claude('<p>A 3 by 2 metre concrete base is about 0.6 cubic metres at 100 mm deep. Want me to draft a request for quotes?</p>', ctx('Garden shed'), '10:09');

  const chatMenu = `
    <div class="scrim"></div>
    <div class="menu" role="menu" aria-label="Topic for this message" style="top:34px;left:0">
      <p class="mh">Filed to a new topic, <b>Garden shed</b>. An archived topic, <b>Shed plans</b>, also matched.</p>
      <button role="menuitem">Move to another topic…</button>
      <button role="menuitem">Also add to another topic…</button>
      <button role="menuitem">Open Garden shed</button>
      <hr>
      <button role="menuitem" class="amber">Reactivate Shed plans and move this there</button>
    </div>`;

  const thread = (turns, after = '') => `<div class="body"><ol class="turns">${turns.join('')}</ol>${after}</div>`;

  // ---------- topic list ----------
  const topics = [
    ['Kitchen budget', '2 min', 'Renovation capped at 18k. Worktop quote in at 2,350; cabinets ordered; tap and electrician still open.', '2 open items · 38 messages'],
    ['Garden shed', '4 min', 'New today. Base about 3 by 2 metres; looking for quotes.', '6 messages'],
    ['Conference talk', '9 min', 'Talk on agent-built tools, 25 minutes. Outline agreed; demo will reuse the release notes flow.', '1 open item · 21 messages'],
    ['Release notes', '9 min', 'Notes for the next release: canvas voice and work lanes. Waiting on the rollback wording.', '1 open item · 17 messages'],
    ['Laptop upgrade', 'yesterday', 'Comparing two 32 GB models. Battery life decides it.', '4 messages'],
    ['Errands', '3 days', 'Stamps, council letter, bike service. Mostly captures.', '3 open items · 9 messages'],
  ];
  const archived = [
    ['Shed plans', '3 weeks', 'Earlier shed idea, parked when the budget went to the kitchen.', '12 messages'],
    ['Tax return 2025', '7 months', 'Filed in January. Receipts kept in the shared folder.', '30 messages'],
    ['Office move', '9 months', 'Moved desks and the printer; nothing left to do.', '14 messages'],
  ];
  const topicRow = ([t, time, sum, meta], current) => `
    <li><button class="topic"${current ? ' aria-current="true"' : ''}>
      <span class="tl"><span class="tt">${t}</span><time>${time}</time></span>
      <span class="sum">${sum}</span>
      <span class="meta">${meta}</span>
    </button></li>`;
  const unsortedRow = `
    <li><button class="topic unsorted">
      <span class="tl"><span class="tt">Unsorted</span><time>1 min</time></span>
      <span class="sum">Messages that could not be filed in time.</span>
      <span class="meta"><span class="need">1 message to file</span></span>
    </button></li>`;
  const topicList = ({ which = 'active', unsorted = false, current = '', bodyClass = '' } = {}) => `
    <div class="search"><label class="sr" for="q">Find a topic</label><input id="q" type="search" placeholder="Find a topic"></div>
    <div class="seg" role="group" aria-label="Show">
      <button aria-pressed="${which === 'active'}">Active <span class="num">${topics.length}</span></button>
      <button aria-pressed="${which === 'archived'}">Archived <span class="num">${archived.length}</span></button>
    </div>
    <div class="body ${bodyClass}"><ul class="topics">
      ${which === 'active' && unsorted ? unsortedRow : ''}
      ${(which === 'active' ? topics : archived).map((r) => topicRow(r, r[0] === current)).join('')}
    </ul>
    ${which === 'archived' ? '<p class="empty-list">Archived topics never take new messages by themselves. Open one to reactivate it.</p>' : ''}
    </div>`;

  // ---------- topic view ----------
  const topicView = ({ undo = true, inFull = false } = {}) => `
    ${inFull ? '' : head('Kitchen budget', { back: 'Topics', list: false })}
    ${inFull ? `<div class="head"><h1>Kitchen budget</h1><button class="icon" aria-label="Topic actions" title="Merge, split, archive">${I.more}</button></div>` : ''}
    <div class="body">
      ${inFull ? '' : `<p class="small sec" style="margin-top:12px">Active · last message 2 min ago · <a href="#" style="color:inherit">Merge, split or archive</a></p>`}
      <div class="proposal" role="group" aria-label="Merge suggestion">
        <p class="pk">Merge suggestion</p>
        <p><b>Kitchen tap</b> looks like part of this topic (4 messages).</p>
        <div class="acts"><button class="quiet">Review merge</button><button>Not now</button></div>
      </div>
      <div class="proposal" role="group" aria-label="Note from another topic">
        <p class="pk">Note from Laptop upgrade</p>
        <p><q>The laptop budget moved 300 into the kitchen fund.</q></p>
        <div class="acts"><button class="quiet">Add note</button><button>Reject</button></div>
      </div>
      ${inFull ? '' : `<div class="proposal" role="group" aria-label="Split suggestion">
        <p class="pk">Split suggestion</p>
        <p>The last 9 messages are about the <b>hob circuit</b>.</p>
        <div class="acts"><button class="quiet">Review split</button><button>Not now</button></div>
      </div>`}
      <div class="sect">
        <h2>Summary<button>Edit</button></h2>
        <p class="summary">Renovation capped at 18k. Cabinets ordered and paid. Worktop quote in at 2,350, leaving 1,120. The electrician needs a separate circuit for the hob.</p>
        <p class="summary ver">Version 6 · updated 10:02 · <a href="#" style="color:inherit">Earlier versions</a></p>
      </div>
      <div class="sect">
        <h2>Open items<button>Add</button></h2>
        <ul class="items">
          <li><input type="checkbox" aria-label="Done"><span>Choose the tap</span></li>
          <li><input type="checkbox" aria-label="Done"><span>Book the electrician for the hob circuit <span class="from">· capture</span></span></li>
          <li><input type="checkbox" checked aria-label="Done"><span style="color:var(--muted);text-decoration:line-through">Get the worktop quote</span></li>
        </ul>
      </div>
      <div class="sect compact">
        <h2>Messages <span class="num" style="margin-left:6px">38</span></h2>
        <ol class="turns">
          ${you('What is left on the kitchen? I think the worktop quote came back.', '', '10:02')}
          ${claude('<p>The worktop quote came in at 2,350, which leaves 1,120 under the 18k cap.</p>', '', '10:02')}
          ${you('electrician for the hob', '', 'Mon', { tag: 'Capture' })}
        </ol>
      </div>
    </div>
    ${undo ? `<div class="notice" role="status"><span>Moved 1 message here from Garden shed.</span><button>Undo</button></div>` : ''}
    ${composer({ placeholder: 'Message Kitchen budget' })}`;

  // ---------- states ----------
  const views = {
    chat: () => head('Chat') + thread([t1, r1, t2, r2, t3(), r3]) + composer(),
    'chip-menu': () => head('Chat') + thread([t1, r1, t2, r2, t3(chatMenu), r3]) + composer(),
    routing: () =>
      head('Chat') +
      thread(
        [t2, r2, t3(), r3, you('Ok, do that for the shed too.', chip('filing', 'Filing', '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>'), '10:11')],
        '<p class="state" role="status">Finding the topic · <span class="num">3 s</span>. Replies start once it is filed.</p>',
      ) +
      composer({ draft: 'and remind me to measure the side gate', status: 'You can keep typing. Each message is filed on its own.' }),
    capture: () =>
      head('Chat') +
      thread([
        t3(),
        r3,
        you('buy stamps for the council letter', chip('sure', 'Errands'), '10:14', {
          tag: 'Capture',
          after: `<p class="ack">${I.check}Captured to Errands. No reply.</p>`,
        }),
      ]) +
      composer({ draft: '> check whether the shed base needs planning permission', capture: true }),
    unsorted: () =>
      head('Chat') +
      thread([
        t3(),
        r3,
        you('Use the numbers from before for that one.', chip('unsorted', 'Unsorted', 'Pick a topic'), '10:16', {
          after: '<p class="why">Filing took too long, so this went to Unsorted. No reply until you pick a topic.</p>',
        }),
      ]) +
      composer(),
    unavailable: () =>
      head('Chat') +
      thread([t1, r1, t2, r2]) +
      composer({
        draft: 'Remind me what the tap shortlist was.',
        err: 'Chat is not running, so nothing was sent. Your message is still here.',
      }),
    empty: () =>
      head('Chat') +
      `<div class="body"><div class="empty">
        <h2>One chat for everything</h2>
        <p>Write about anything. Each message is filed to a topic for you, and the topic shows under it. Tap the topic to move it if it went to the wrong place.</p>
        <p>Start a message with <code>&gt;</code> to capture a thought. It is filed with no reply.</p>
        <p>Topics appear in the topic list as they are made.</p>
      </div></div>` +
      composer(),
    bootstrap: () =>
      head('Chat') +
      `<div class="strip" role="status">Filing your canvas conversations from the last 7 days · <span class="num">46 of 120</span><div class="bar"><i style="width:38%"></i></div></div>` +
      thread(
        [you('What did we decide about the release notes wording?', chip('sure', 'Release notes'), '09:40'), claude('<p>Rollback wording is still open. The rest of the notes are drafted.</p>', ctx('Release notes'), '09:40')],
        '<p class="state">Messages you send now are filed before the rest of the import.</p>',
      ) +
      composer(),
    topics: () => head('Topics', { back: 'Chat', list: false }) + topicList({ unsorted: true }),
    archived: () => head('Topics', { back: 'Chat', list: false }) + topicList({ which: 'archived' }),
    topic: () => topicView(),
  };

  const app = document.getElementById('app');
  const name = state === 'full' && phone ? 'chat' : state;

  if (state === 'full' && !phone) {
    app.innerHTML = `
      <div class="full">
        <section>${head('Topics', { list: false, full: false }).replace(I.close, I.full).replace('aria-label="Close" title="Close · Esc"', 'aria-label="Back to the rail" title="Back to the rail · F"')}${topicList({ unsorted: true, current: 'Kitchen budget' })}</section>
        <section class="chatcol"><div class="head"><h1>Chat</h1></div>${thread([t1, r1, t2, r2, t3(), r3])}${composer()}</section>
        <section style="position:relative">${topicView({ undo: false, inFull: true })}</section>
      </div>`;
    const c = document.querySelector('.chatcol .body');
    c.scrollTop = c.scrollHeight;
    return;
  }

  const board = phone
    ? ''
    : `<div class="board" aria-hidden="true">
        <div class="outline"><b>Workspace</b><span>Home</span><b>Sessions</b><span>w1 · Working</span><span>w2 · Idle</span><b>Objects</b><span>Kitchen plan</span><span>Talk outline</span><span>Shed sketch</span></div>
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
  // A chat opens at its end, like the canvas assistant's thread.
  if (!['topics', 'archived', 'topic'].includes(name)) for (const b of document.querySelectorAll('.body')) b.scrollTop = b.scrollHeight;
})();
