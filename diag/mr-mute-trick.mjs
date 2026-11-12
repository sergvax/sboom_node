/**
 * Можно ли «играть на одной», пока группа ещё живёт: глушим ведомых,
 * проверяем, что состояние mute/volume применяется отдельно.
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
    out.push(`${n}: ${st.multiroom?.mode ?? 'NONE'} vol=${st.volume} muted=${st.muted} play=${st.player?.playing}`);
  }
  return out.join('\n     ');
};
const master = clients.get('SberPortal');
await master.playDeeplink('sboom://track/133828181');
await master.play();
await master.startMultiroom({ timeoutMs: 5000 });
await new Promise((r) => setTimeout(r, 6000));
console.log('группа:\n     ' + await snap());
await clients.get('SberBoom').mute().catch((e) => console.log('mute err', e.message));
await clients.get('SberBoom Mini 2').mute().catch((e) => console.log('mute err', e.message));
await new Promise((r) => setTimeout(r, 2000));
console.log('после mute ведомых:\n     ' + await snap());
await clients.get('SberBoom').unmute().catch(() => {});
await clients.get('SberBoom Mini 2').unmute().catch(() => {});
await new Promise((r) => setTimeout(r, 2000));
console.log('после unmute:\n     ' + await snap());
for (const c of clients.values()) c.close();
