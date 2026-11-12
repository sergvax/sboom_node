/**
 * Пробует «выйти из группы» с ведомой колонки: START_MULTIROOM на ведомой,
 * затем попытки start/stop на каждой.
 */
import fs from 'node:fs';
import { SpeakerClient } from '../lib/speaker.js';
const cfg = JSON.parse(fs.readFileSync('data/speakers.json', 'utf8'));
const clients = new Map();
for (const sp of cfg.speakers) {
  const c = new SpeakerClient({ host: sp.host, port: sp.port, token: sp.token, clientId: sp.clientId, clientName: sp.clientName });
  await c.connect();
  clients.set(sp.name, c);
}
const snap = async () => {
  const out = [];
  for (const [n, c] of clients) {
    const st = await c.getState();
    out.push(`${n}: ${st.multiroom?.mode ?? 'NONE'} play=${st.player?.playing}`);
  }
  return out.join(' | ');
};
console.log('до:', await snap());
for (const name of ['SberBoom', 'SberBoom Mini 2', 'SberPortal']) {
  const res = await clients.get(name).startMultiroom({ timeoutMs: 4000 }).catch((e) => ({ error: e.message }));
  console.log(`START_MULTIROOM на ${name} → ${JSON.stringify(res)}; через 3 с: ${await new Promise((r) => setTimeout(r, 3000)).then(snap)}`);
}
for (const c of clients.values()) c.close();
