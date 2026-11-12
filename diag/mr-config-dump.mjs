import fs from 'node:fs';
import { SpeakerClient } from '../lib/speaker.js';
import { OP_GET_META_DATA } from '../lib/protocol.js';
import { field } from '../lib/tlv.js';

const cfg = JSON.parse(fs.readFileSync('data/speakers.json', 'utf8'));
for (const sp of cfg.speakers) {
  const c = new SpeakerClient({ host: sp.host, port: sp.port, token: sp.token, clientId: sp.clientId, clientName: sp.clientName });
  try {
    await c.connect();
    const raw = await c._request(field(OP_GET_META_DATA, 2, field(1, 2, Buffer.alloc(0)), 8000));
    const text = raw.toString('latin1');
    const hits = new Set();
    for (const m of text.matchAll(/[A-Za-z0-9_.]{4,60}(Multiroom|multiroom|MULTIROOM|cast|Cast)[A-Za-z0-9_.]{0,40}/g)) hits.add(m[0]);
    console.log(`── ${sp.name} (${sp.host})`);
    console.log('   ключи:', [...hits].slice(0, 60).join(', '));
    const idx = text.indexOf('urnOffMultiroomAfterPause');
    if (idx >= 0) console.log('   контекст:', JSON.stringify(text.slice(Math.max(0, idx - 200), idx + 200)));
    const v = text.match(/1\.10[0-9]\.[0-9]+/g);
    if (v) console.log('   версии:', [...new Set(v)].join(', '));
  } catch (err) {
    console.log(`── ${sp.name}: ${err.message}`);
  } finally { c.close(); }
}
