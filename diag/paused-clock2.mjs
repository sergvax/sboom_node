import { SpeakerClient } from '../lib/speaker.js';
import { Store } from '../lib/store.js';
import { mediaPlayerFromState } from '../lib/parsers.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = new Store('data/speakers.json');
await store.load();
const cfg = store.data.speakers.find((s) => s.name === 'SberBoom Mini 2');
const c = new SpeakerClient({ host: cfg.host, port: cfg.port, token: cfg.token });
await c.connect();
const player = async () => {
  const st = await c.getState();
  let json = null; try { json = JSON.parse(st.raw); } catch {}
  return mediaPlayerFromState(json)?.player ?? null;
};

console.log('=== пауза: сколько команд pause нужно, и стоит ли позиция ===');
await c.play(); await sleep(3000);
const sentP = Date.now();
await c.pause();
for (let i = 0; i < 12; i++) {
  const p = await player();
  console.log(`+${Date.now()-sentP}ms playing=${p?.playing} pos=${p?.position}`);
  if (!p?.playing) break;
  await sleep(250);
}
// теперь стоит? проверим 3 секунды
for (let i = 0; i < 8; i++) { const p = await player(); console.log(`  пауза +${i*400}ms pos=${p?.position} playing=${p?.playing}`); await sleep(400); }

console.log('\n=== seek на стоящей: применяется ли сразу? ===');
const base = await player();
for (const target of [30, 90]) {
  const sent = Date.now();
  await c.seek(target);
  for (let i = 0; i < 8; i++) { const p = await player(); console.log(`  seek ${target} +${Date.now()-sent}ms pos=${p?.position} playing=${p?.playing}`); await sleep(250); }
  // подождать, пока «догонит» до target
  for (let i = 0; i < 10; i++) { const p = await player(); if (p?.position >= target) { console.log(`  достигнут ${target} через ${Date.now()-sent} ms`); break; } await sleep(250); }
  await sleep(1000);
  const after = await player();
  console.log(`  итог: pos=${after?.position} playing=${after?.playing}`);
}
await c.close(); process.exit(0);
