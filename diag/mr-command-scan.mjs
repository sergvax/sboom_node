/**
 * Перебираем неизвестные MediaCommand (16..40) на мастере и смотрим,
 * распадается ли группа быстрее паузы.
 */
import fs from 'node:fs';
import { SpeakerClient } from '../lib/speaker.js';
import { field } from '../lib/tlv.js';
import { OP_MEDIA_COMMAND } from '../lib/protocol.js';

const cfg = JSON.parse(fs.readFileSync('data/speakers.json', 'utf8'));
const clients = new Map();
for (const sp of cfg.speakers) {
  const c = new SpeakerClient({ host: sp.host, port: sp.port, token: sp.token, clientId: sp.clientId, clientName: sp.clientName });
  await c.connect();
  clients.set(sp.name, c);
}
const master = clients.get('SberPortal');
const snap = async () => {
  const rows = [];
  for (const [name, c] of clients) {
    const st = await c.getState();
    rows.push(`${name}:${st.multiroom?.mode ?? 'NONE'}${st.player?.playing ? '+' : '-'}`);
  }
  return rows.join('  ');
};
console.log('до:', await snap());
for (let cmd = 16; cmd <= 40; cmd++) {
  let reply;
  try {
    reply = (await master._request(field(OP_MEDIA_COMMAND, 2, field(1, 0, cmd)), 1500)).toString('hex');
  } catch (err) { reply = `нет ответа (${err.message})`; }
  await new Promise((r) => setTimeout(r, 2500));
  console.log(`cmd=${cmd}  ответ=${reply}  →  ${await snap()}`);
}
for (const c of clients.values()) c.close();
