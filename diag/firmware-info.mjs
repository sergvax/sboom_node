import fs from 'node:fs';
import { SpeakerClient } from '../lib/speaker.js';
const cfg = JSON.parse(fs.readFileSync('data/speakers.json', 'utf8'));
for (const sp of cfg.speakers) {
  const c = new SpeakerClient({ host: sp.host, port: sp.port, token: sp.token, clientId: sp.clientId, clientName: sp.clientName });
  try {
    await c.connect();
    const st = await c.getState();
    const raw = st.raw ?? {};
    console.log('──', sp.name);
    for (const [k, v] of Object.entries(raw)) {
      const s = JSON.stringify(v);
      if (/firmware|version|software|build/i.test(s)) console.log('   field', k, s.slice(0, 300));
    }
    console.log('   raw fields:', Object.keys(raw).join(', '));
  } catch (err) {
    console.log('──', sp.name, 'ошибка:', err.message);
  } finally { c.close(); }
}
