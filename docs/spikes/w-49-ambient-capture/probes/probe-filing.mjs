import fs from 'node:fs'; import path from 'node:path';
const [, , bundleDir, base, workspaceId] = process.argv;
const auth = process.env.CODEMAN_PASSWORD ? { authorization: 'Basic ' + Buffer.from(`${process.env.CODEMAN_USERNAME || 'admin'}:${process.env.CODEMAN_PASSWORD}`).toString('base64') } : {};
const capture = JSON.parse(fs.readFileSync(path.join(bundleDir, 'capture.json'), 'utf8'));
const call = async (method, url, body, type) => {
  const t0 = performance.now();
  const res = await fetch(base + url, { method, headers: { ...auth, ...(type ? { 'content-type': type } : {}) }, body });
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(json)}`);
  return { data: json.data, ms: Math.round(performance.now() - t0) };
};
const requestId = crypto.randomUUID();
const ws = `/api/canvas/${workspaceId}/work`;
const item = { title: capture.note.split('\n')[0].slice(0, 120), description: capture.note, requestId };
const created = await call('POST', ws, JSON.stringify(item), 'application/json');
const retry = await call('POST', ws, JSON.stringify(item), 'application/json');
const key = created.data.item.key;
const steps = [{ step: 'create', ms: created.ms, key }, { step: 'retry same requestId', ms: retry.ms, key: retry.data.item.key }];
for (const name of ['clean.png', 'marked-crop.png', 'marked-wide.png', 'capture.json']) {
  const r = await call('POST', `${ws}/${key}/attachments?name=${encodeURIComponent(name)}`, fs.readFileSync(path.join(bundleDir, name)), 'application/octet-stream');
  steps.push({ step: `attach ${name}`, ms: r.ms });
}
const list = await call('GET', ws);
const stored = list.data.items.filter((i) => i.key === key);
const back = await fetch(`${base}${ws}/${key}/attachments/${stored[0].attachments.find((a) => a.name === 'clean.png').id}`, { headers: auth });
const same = Buffer.from(await back.arrayBuffer()).equals(fs.readFileSync(path.join(bundleDir, 'clean.png')));
console.log(JSON.stringify({ steps, itemsWithKey: stored.length, attachments: stored[0].attachments.map((a) => ({ name: a.name, type: a.type, size: a.size })), cleanPngRoundTrip: same, author: stored[0].author }, null, 2));
