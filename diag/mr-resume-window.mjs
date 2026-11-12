/**
 * Можно ли запустить звук на одной колонке, не дожидаясь роспуска группы?
 * Тест: пауза → пауза-пауза → запуск нового трека на мастере через N секунд.
 */
import fs from 'node:fs';
import { SpeakerClient } from '../lib/speaker.js';

const cfg = JSON.parse(fs.readFileSync('data/speakers.json', 'utf8'));
const DEEPLINK = 'sboom://track/133828181';
const clients = new Map();
for (const sp of cfg.speakers) {
  const c = new SpeakerClient({ host: sp.host, port: sp.port, token: sp.token, clientId: sp.clientId, clientName: sp.clientName });
  await c.connect();
  clients.set(sp.name, c);
}
const snap = async () => {
  const out = {};
  for (const [n, c] of clients) {
    const st = await c.getState();
    out[n] = `${st.multiroom?.mode ?? 'NONE'}${st.player?.playing ? '+' : '-'}#${st.player?.trackId ?? '—'}@${st.player?.position ?? '-'}`;
  }
  return Object.entries(out).map(([n, v]) => `${n}:${v}`).join('  ');
};
const master = clients.get('SberPortal');

console.log('0) до:', await snap());
await master.playDeeplink(DEEPLINK);
await master.play();
await master.startMultiroom({ timeoutMs: 5000 });
await new Promise((r) => setTimeout(r, 6000));
console.log('1) группа собрана:', await snap());

for (const delay of [3000, 9000]) {
  await Promise.allSettled([...clients.values()].map((c) => c.pause()));
  await new Promise((r) => setTimeout(r, delay));
  console.log(`2) пауза + ${delay / 1000} с:`, await snap());
  await master.playDeeplink(DEEPLINK);
  await master.play();
  await new Promise((r) => setTimeout(r, 4000));
  console.log(`3) запуск на мастере после ${delay / 1000} с:`, await snap());
  await new Promise((r) => setTimeout(r, 6000));
  console.log('4) через 6 с:', await snap());
}
for (const c of clients.values()) c.close();
