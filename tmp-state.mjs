import fs from 'node:fs';
import { SpeakerClient } from './lib/speaker.js';

const data = JSON.parse(fs.readFileSync('data/speakers.json', 'utf8'));
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && k in o).map((k) => [k, o[k]]));

for (const cfg of data.speakers) {
  const c = new SpeakerClient({ host: cfg.host, port: cfg.port, token: cfg.token, clientId: cfg.clientId, clientName: cfg.clientName });
  try {
    await c.connect();
    await new Promise((r) => setTimeout(r, 100));
    const state = await c.getState();
    const json = state?.raw ? JSON.parse(state.raw) : null;
    console.log(`\n=== ${cfg.name} (${cfg.host}) ===`);
    if (!json) {
      console.log('нет JSON');
    } else {
      console.log(JSON.stringify({
        multiroom: json.multiroom,
        sbercast: json.sbercast,
        deviceSelector: json.deviceSelector,
        deviceGroups: json.deviceGroups,
        device_segments: json.device_segments,
      }, null, 2));
      const apps = (json.background_apps || []).map((a) => ({
        app: a?.app_info?.systemName,
        player: pick(a?.state?.player, ['playing', 'mode', 'position', 'duration', 'repeatType', 'shuffle', 'playbackSpeedRate']),
        info: pick(a?.state?.player?.info, ['title', 'trackId', 'provider', 'mediaSource', 'playlistTitle', 'playlistType', 'stationName']),
      }));
      console.log('apps:', JSON.stringify(apps, null, 1));
    }
    const md = await c.getMetadata();
    console.log('meta:', md && { title: md.title, track_id: md.track_id, playlist_id: md.playlist_id, playlist_title: md.playlist_title, source: md.media_source, playing: md.playing });
  } catch (e) {
    console.log(`ошибка: ${e.message}`);
  } finally {
    await c.close();
  }
}
