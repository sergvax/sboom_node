/* SberBoom Standalone — веб-интерфейс. */

const ICONS = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72c0 .84.92 1.35 1.63.9l10.6-6.86a1.08 1.08 0 0 0 0-1.8L9.63 4.24A1.08 1.08 0 0 0 8 5.14Z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4" height="15" rx="1.3"/><rect x="14" y="4.5" width="4" height="15" rx="1.3"/></svg>',
  prev: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.5 4.8v14.4a1 1 0 0 1-1.55.83L8 13.1v6.1a1 1 0 0 1-2 0V4.8a1 1 0 0 1 2 0v6.1l8.95-6.93a1 1 0 0 1 1.55.83Z"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5.5 4.8v14.4a1 1 0 0 0 1.55.83L16 13.1v6.1a1 1 0 0 0 2 0V4.8a1 1 0 0 0-2 0v6.1L7.05 3.97a1 1 0 0 0-1.55.83Z"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>',
  repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  volume: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
  mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1L11.5 4.4"/><path d="M14 11a5 5 0 0 0-7.1 0l-3 3A5 5 0 0 0 11 21.1l1.5-1.5"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
  multiroom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8.5" width="7" height="11" rx="2"/><circle cx="6.5" cy="16.2" r="1.3"/><path d="M14.5 7.5a6 6 0 0 1 0 9"/><path d="M18 4.5a10.5 10.5 0 0 1 0 15"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.2"/></svg>',
};

const $ = (sel, root = document) => root.querySelector(sel);

const els = {
  grid: $('#grid'),
  empty: $('#empty'),
  groupPanel: $('#groupPanel'),
  groupSub: $('#groupSub'),
  groupVol: $('#groupVol'),
  groupVolVal: $('#groupVolVal'),
  addDialog: $('#addDialog'),
  addForm: $('#addForm'),
  addError: $('#addError'),
  discoverList: $('#discoverList'),
  toasts: $('#toasts'),
  serverPill: $('#serverPill'),
};

const state = {
  speakers: [],
  multiroom: null,
  serverTime: Date.now(),
  offset: 0,
  groupDragUntil: 0,
  mrBusy: false,
};

const cards = new Map();
let pollTimer = null;

/* ── api ─────────────────────────────────────────────── */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* пустой ответ */
  }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  els.toasts.append(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s ease';
    setTimeout(() => el.remove(), 260);
  }, 4200);
}

/* ── formatters ──────────────────────────────────────── */

function fmtTime(sec) {
  if (sec === null || sec === undefined || Number.isNaN(sec)) return '';
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}

const SOURCE_LABEL = {
  MUSIC: 'Музыка',
  RADIO: 'Радио',
  BLUETOOTH: 'Bluetooth',
  PODCAST: 'Подкаст',
  ABOOK: 'Аудиокнига',
};

function statusLabel(sp) {
  if (sp.pairing?.active) return 'Сопряжение…';
  switch (sp.status) {
    case 'connected':
      return sp.track?.playing ? 'Играет' : 'В сети';
    case 'connecting':
      return 'Подключение…';
    case 'reconnecting':
      return sp.error ? 'Нет связи' : 'Переподключение…';
    case 'unpaired':
      return 'Не сопряжена';
    default:
      return sp.status || '';
  }
}

function dotClass(sp) {
  if (sp.status === 'connected') return 'ok';
  if (!sp.paired) return '';
  if (sp.error && sp.status === 'reconnecting') return 'err';
  return 'warn';
}

/* ── rendering ───────────────────────────────────────── */

function hydrateIcons(root) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = ICONS[el.dataset.icon] || '';
  });
}

function paintRange(input, value) {
  input.value = value;
  input.style.setProperty('--fill', `${value}%`);
}

function createCard(sp) {
  const node = $('#cardTpl').content.firstElementChild.cloneNode(true);
  hydrateIcons(node);

  const refs = {
    root: node,
    dot: $('.status-dot', node),
    name: $('.card-name', node),
    host: $('.card-host', node),
    cover: $('.cover', node),
    img: $('.cover img', node),
    title: $('.track-title', node),
    artist: $('.track-artist', node),
    album: $('.track-album', node),
    source: $('.chip.source', node),
    multiChip: $('.chip.multi', node),
    buffer: $('.chip.buffer', node),
    bar: $('.bar', node),
    fill: $('.fill', node),
    knob: $('.knob', node),
    tPos: $('.t-pos', node),
    tDur: $('.t-dur', node),
    shuffle: $('[data-action="shuffle"]', node),
    repeat: $('[data-action="repeat"]', node),
    playBtn: $('.play-btn', node),
    playIcon: $('.play-btn [data-icon]', node),
    volumeBtn: $('[data-action="mutetoggle"]', node),
    volumeIcon: $('[data-action="mutetoggle"] [data-icon]', node),
    volRange: $('.vol-range', node),
    volVal: $('.vol-val', node),
    like: $('.like-btn', node),
    multiBtn: $('.mr-btn', node),
    multiIcon: $('.mr-btn [data-icon]', node),
    multiLabel: $('.mr-label', node),
    stateLabel: $('.state-label', node),
    overlay: $('.overlay', node),
    overlayInner: $('.overlay-inner', node),
    overlayBadge: $('.overlay-badge', node),
    overlayTitle: $('.overlay-title', node),
    overlayText: $('.overlay-text', node),
    overlayBtn: $('.overlay-btn', node),
    spinner: null,
    dragUntil: 0,
    volTimer: null,
    sp,
  };

  const spinner = document.createElement('div');
  spinner.className = 'spinner';
  spinner.hidden = true;
  refs.overlayInner.prepend(spinner);
  refs.spinner = spinner;

  refs.img.addEventListener('load', () => {
    refs.cover.classList.add('has-img');
    refs.root.classList.add('has-cover');
  });
  refs.img.addEventListener('error', () => {
    refs.cover.classList.remove('has-img');
    refs.root.classList.remove('has-cover');
  });

  node.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    const speaker = refs.sp;
    if (!speaker) return;

    if (action === 'seek') {
      onSeek(refs, speaker, event);
      return;
    }
    onAction(action, speaker, refs, target);
  });

  const volStart = () => {
    refs.dragUntil = Date.now() + 1200;
  };
  const volChange = () => {
    refs.dragUntil = Date.now() + 800;
    paintRange(refs.volRange, Number(refs.volRange.value));
    refs.volVal.textContent = refs.volRange.value;
    clearTimeout(refs.volTimer);
    refs.volTimer = setTimeout(() => {
      command(refs.sp, 'volume', Number(refs.volRange.value)).catch(() => {});
    }, 120);
  };

  refs.volRange.addEventListener('pointerdown', volStart);
  refs.volRange.addEventListener('input', volChange);
  refs.volRange.addEventListener('change', () => {
    clearTimeout(refs.volTimer);
    command(refs.sp, 'volume', Number(refs.volRange.value)).catch(() => {});
    refs.dragUntil = Date.now() + 900;
  });

  return { refs, node };
}

function render() {
  const list = state.speakers || [];
  els.empty.hidden = list.length > 0;

  const seen = new Set();
  for (const sp of list) {
    seen.add(sp.id);
    let card = cards.get(sp.id);
    if (!card) {
      card = createCard(sp);
      cards.set(sp.id, card);
      els.grid.append(card.node);
    }
    card.refs.sp = sp;
    updateCard(card.refs, sp);
  }
  for (const [id, card] of cards) {
    if (!seen.has(id)) {
      clearTimeout(card.refs.volTimer);
      card.node.remove();
      cards.delete(id);
    }
  }

  renderGroup(list);
}

function updateCard(c, sp) {
  const t = sp.track;
  const online = sp.status === 'connected';
  const mr = state.multiroom || {};

  c.dot.className = `status-dot ${dotClass(sp)}`;
  c.dot.title = sp.error || statusLabel(sp);
  c.name.textContent = sp.name;
  c.host.textContent = `${sp.host}:${sp.port}`;
  c.root.classList.toggle('offline', !online && !sp.pairing?.active);

  if (t?.cover) {
    if (c.img.getAttribute('src') !== t.cover) {
      c.cover.classList.remove('has-img');
      c.root.classList.remove('has-cover');
      c.img.src = t.cover;
    }
    c.root.style.setProperty('--cover', `url("${t.cover}")`);
  } else {
    c.cover.classList.remove('has-img');
    c.root.classList.remove('has-cover');
    c.img.removeAttribute('src');
  }

  c.title.textContent = t?.title || (online ? 'Ничего не играет' : 'Нет данных');
  c.artist.textContent = t?.artists?.length ? t.artists.join(', ') : '';
  c.album.textContent = t?.album || '';

  const sourceText = t?.station || t?.playlist || SOURCE_LABEL[t?.source] || '';
  c.source.hidden = !sourceText;
  c.source.textContent = sourceText;
  c.buffer.hidden = !t?.buffering;

  const inGroup = Boolean(mr.active && mr.memberIds?.includes(sp.id));
  const isSource = inGroup && mr.sourceId === sp.id;
  c.multiChip.hidden = !inGroup;
  c.multiChip.textContent = isSource ? 'источник' : 'мультирум';
  c.multiChip.title = isSource
    ? 'С этой колонки транслируется мультирум'
    : 'Колонка повторяет трек источника';

  c.shuffle.classList.toggle('active', Boolean(t?.shuffle));
  c.repeat.classList.toggle('active', Boolean(t) && (t.repeat || 'off') !== 'off');
  c.repeat.title =
    t?.repeat === 'one' ? 'Повтор трека' : t?.repeat === 'all' ? 'Повтор плейлиста' : 'Повтор выключен';

  c.playBtn.disabled = !online;
  c.playIcon.innerHTML = t?.playing ? ICONS.pause : ICONS.play;
  c.playBtn.title = t?.playing ? 'Пауза' : 'Играть';

  c.volumeBtn.disabled = !online;
  c.volumeIcon.innerHTML = sp.muted ? ICONS.mute : ICONS.volume;
  c.volumeBtn.classList.toggle('active', Boolean(sp.muted));

  if (Date.now() > c.dragUntil) {
    paintRange(c.volRange, sp.volume ?? 0);
    c.volVal.textContent = String(sp.volume ?? 0);
  }

  c.like.classList.toggle('active', Boolean(t?.liked));
  c.like.title = t?.liked ? 'Убрать лайк' : 'Нравится';

  updateMultiButton(c, sp, { online, inGroup, isSource });

  c.stateLabel.textContent = statusLabel(sp);
  c.stateLabel.title = sp.error || '';

  const showOverlay = !sp.paired || sp.pairing?.active;
  c.overlay.hidden = !showOverlay;
  if (showOverlay) {
    if (sp.pairing?.active) {
      c.spinner.hidden = false;
      c.overlayBadge.hidden = true;
      c.overlayTitle.textContent = 'Сопряжение';
      c.overlayText.textContent = sp.pairing.message || 'Подождите…';
      c.overlayBtn.hidden = true;
    } else {
      c.spinner.hidden = true;
      c.overlayBadge.hidden = false;
      c.overlayTitle.textContent = sp.error ? 'Не удалось подключиться' : 'Колонка не сопряжена';
      c.overlayText.textContent = sp.error
        ? `${sp.error} Нажмите «Сопрячь» и удерживайте «+» на корпусе колонки.`
        : `Подключились к ${sp.host}. Нажмите «+» на корпусе колонки, затем «Сопрячь». Токен сохранится.`;
      c.overlayBtn.hidden = false;
    }
  }

  c.bar.classList.toggle('disabled', !t?.duration);
}

function isMusicTrack(sp) {
  const id = sp.track?.track_id ?? sp.track?.trackId;
  if (!id) return false;
  const source = sp.track?.source;
  return !source || source === 'MUSIC';
}

function updateMultiButton(c, sp, { online, inGroup, isSource }) {
  const mr = state.multiroom || {};
  const busy = state.mrBusy || mr.state === 'starting' || mr.state === 'stopping';
  const others = state.speakers.filter((s) => s.id !== sp.id && s.status === 'connected').length;

  let label = 'Мультирум';
  let icon = 'multiroom';
  let disabled = busy || !online;
  let title = 'Включить этот трек на остальных колонках';

  if (isSource) {
    label = 'Стоп';
    icon = 'stop';
    title = 'Остановить мультирум';
    disabled = busy;
    c.multiBtn.classList.add('active');
  } else if (inGroup) {
    label = 'Выйти';
    title = 'Отключить эту колонку от мультирума';
    disabled = busy;
    c.multiBtn.classList.add('active');
  } else {
    c.multiBtn.classList.remove('active');
    const hasTrack = isMusicTrack(sp);
    if (mr.active) {
      disabled = true;
      title = 'Мультирум уже включён с другой колонки';
    } else if (!others) {
      disabled = true;
      title = 'Нужна ещё хотя бы одна подключённая колонка';
    } else if (!hasTrack) {
      disabled = true;
      title = 'Включите музыку Звука — радио и Bluetooth не переносятся';
    }
  }

  c.multiBtn.disabled = disabled;
  c.multiBtn.title = title;
  c.multiLabel.textContent = label;
  const ico = c.multiIcon;
  if (ico.dataset.icon !== icon) {
    ico.dataset.icon = icon;
    ico.innerHTML = ICONS[icon];
  }
}

function renderGroup(list) {
  const show = list.length >= 2;
  els.groupPanel.hidden = !show;
  if (!show) return;

  const connected = list.filter((s) => s.status === 'connected');
  const mr = state.multiroom || {};
  let sub = `${connected.length} из ${list.length} в сети`;
  if (mr.state === 'starting') sub += ' · мультирум запускается…';
  else if (mr.state === 'stopping') sub += ' · мультирум останавливается…';
  else if (mr.active) sub += ` · мультирум: ${mr.memberIds?.length || 0}`;
  else if (mr.message) sub += ` · ${mr.message}`;
  els.groupSub.textContent = sub;

  if (Date.now() > state.groupDragUntil) {
    const withVolume = connected.filter((s) => typeof s.volume === 'number');
    const avg = withVolume.length
      ? Math.round(withVolume.reduce((a, s) => a + s.volume, 0) / withVolume.length)
      : 0;
    paintRange(els.groupVol, avg);
    els.groupVolVal.textContent = String(avg);
  }

  const anyPlaying = list.some((s) => s.track?.playing);
  const playIco = $('[data-action="g-playpause"] [data-icon]');
  if (playIco) playIco.innerHTML = anyPlaying ? ICONS.pause : ICONS.play;

  const allMuted = connected.length > 0 && connected.every((s) => s.muted);
  const muteIco = $('[data-action="g-mute"] [data-icon]');
  if (muteIco) muteIco.innerHTML = allMuted ? ICONS.mute : ICONS.volume;

  // Групповая кнопка мультирума: включить / остановить.
  const mrBtn = $('[data-action="g-multiroom"]', els.groupPanel);
  if (mrBtn) {
    const busy = state.mrBusy || mr.state === 'starting' || mr.state === 'stopping';
    const hasSource = connected.some(isMusicTrack);
    const icon = mr.active ? 'stop' : 'multiroom';
    const ico = $('[data-icon]', mrBtn);
    if (ico && ico.dataset.icon !== icon) {
      ico.dataset.icon = icon;
      ico.innerHTML = ICONS[icon];
    }
    mrBtn.classList.toggle('active', Boolean(mr.active));
    mrBtn.disabled = busy || (!mr.active && (!hasSource || connected.length < 2));
    mrBtn.title = mr.active
      ? 'Остановить мультирум'
      : hasSource
        ? 'Включить этот трек на всех колонках'
        : 'Включите музыку Звука на одной из колонок';
  }
}

/* ── actions ─────────────────────────────────────────── */

async function command(sp, name, value) {
  try {
    await api(`/api/speakers/${sp.id}/command`, {
      method: 'POST',
      body: { command: name, value },
    });
  } catch (err) {
    toast(err.message, 'error');
    throw err;
  }
}

function onSeek(refs, sp, event) {
  const t = sp.track;
  if (!t?.duration) return;
  const rect = refs.bar.getBoundingClientRect();
  const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  const position = Math.round(fraction * t.duration);
  // мгновенный отклик, подтверждение придёт по SSE
  t.position = position;
  t.positionAt = Date.now() + state.offset;
  refs.fill.style.width = `${fraction * 100}%`;
  refs.knob.style.left = `${fraction * 100}%`;
  refs.tPos.textContent = fmtTime(position);
  command(sp, 'seek', position).catch(() => {});
}

function onAction(action, sp, refs, target) {
  switch (action) {
    case 'playpause':
      command(sp, 'playpause').catch(() => {});
      break;
    case 'play':
      command(sp, 'play').catch(() => {});
      break;
    case 'pause':
      command(sp, 'pause').catch(() => {});
      break;
    case 'next':
      command(sp, 'next').catch(() => {});
      break;
    case 'prev':
      command(sp, 'prev').catch(() => {});
      break;
    case 'shuffle':
      command(sp, 'shuffle', !sp.track?.shuffle).catch(() => {});
      break;
    case 'repeat': {
      const cur = sp.track?.repeat || 'off';
      const next = cur === 'off' ? 'all' : cur === 'all' ? 'one' : 'off';
      command(sp, 'repeat', next).catch(() => {});
      break;
    }
    case 'mutetoggle':
      command(sp, 'mutetoggle').catch(() => {});
      break;
    case 'like':
      command(sp, sp.track?.liked ? 'unlike' : 'like').catch(() => {});
      break;
    case 'refresh':
      command(sp, 'refresh').catch(() => {});
      break;
    case 'multiroom':
      onMultiroom(sp);
      break;
    case 'pair':
      startPair(sp);
      break;
    case 'rename':
      renameSpeaker(sp);
      break;
    case 'remove':
      removeSpeaker(sp);
      break;
    default:
      break;
  }
}

async function startPair(sp) {
  try {
    await api(`/api/speakers/${sp.id}/pair`, { method: 'POST' });
    toast('Нажмите «+» на корпусе колонки в течение 2 минут', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function renameSpeaker(sp) {
  const name = window.prompt('Название колонки', sp.name);
  if (name === null) return;
  try {
    await api(`/api/speakers/${sp.id}`, { method: 'PATCH', body: { name } });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeSpeaker(sp) {
  if (!window.confirm(`Удалить «${sp.name}»? Сохранённый токен будет забыт.`)) return;
  try {
    await api(`/api/speakers/${sp.id}`, { method: 'DELETE' });
    toast('Колонка удалена');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function addSpeaker({ name, host, port }) {
  await api('/api/speakers', { method: 'POST', body: { name, host, port } });
}

/* ── multiroom ───────────────────────────────────────── */

async function onMultiroom(sp) {
  const mr = state.multiroom || {};
  if (mr.active && mr.sourceId === sp.id) return stopMultiroom();
  if (mr.active && mr.memberIds?.includes(sp.id)) return leaveMultiroom(sp);
  return startMultiroom(sp);
}

async function startMultiroom(sp) {
  const mr = state.multiroom || {};
  if (state.mrBusy || mr.state === 'starting') return;
  state.mrBusy = true;
  render();
  try {
    const data = await api('/api/multiroom/start', {
      method: 'POST',
      body: { sourceId: sp.id },
    });
    if (data.state) applySnapshot(data.state);
    const msg = data.multiroom?.message;
    toast(msg || 'Мультирум включён — колонки играют один трек', msg ? 'error' : 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    state.mrBusy = false;
    render();
  }
}

async function stopMultiroom() {
  if (state.mrBusy) return;
  state.mrBusy = true;
  render();
  try {
    const data = await api('/api/multiroom/stop', { method: 'POST' });
    if (data.state) applySnapshot(data.state);
    toast('Мультирум выключен');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    state.mrBusy = false;
    render();
  }
}

async function leaveMultiroom(sp) {
  if (state.mrBusy) return;
  state.mrBusy = true;
  render();
  try {
    const data = await api('/api/multiroom/leave', {
      method: 'POST',
      body: { id: sp.id },
    });
    if (data.state) applySnapshot(data.state);
    toast(`«${sp.name}» вышла из мультирума`);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    state.mrBusy = false;
    render();
  }
}

/* ── group controls ──────────────────────────────────── */

function bindGroup() {
  els.groupPanel.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    const connected = state.speakers.filter((s) => s.status === 'connected');

    if (action === 'g-multiroom') {
      const mr = state.multiroom || {};
      if (mr.active) {
        await stopMultiroom();
        return;
      }
      const source =
        connected.find(
          (s) => s.track?.playing && isMusicTrack(s),
        ) || connected.find(isMusicTrack);
      if (!source) {
        toast('Включите музыку Звука на одной из колонок', 'error');
        return;
      }
      await startMultiroom(source);
    }
    if (action === 'g-playpause') {
      const anyPlaying = state.speakers.some((s) => s.track?.playing);
      const cmd = anyPlaying ? 'pause' : 'play';
      try {
        await api('/api/group/command', { method: 'POST', body: { command: cmd } });
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    if (action === 'g-mute') {
      const allMuted = connected.length > 0 && connected.every((s) => s.muted);
      try {
        await api('/api/group/command', {
          method: 'POST',
          body: { command: allMuted ? 'unmute' : 'mute' },
        });
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });

  let timer = null;
  els.groupVol.addEventListener('pointerdown', () => {
    state.groupDragUntil = Date.now() + 1200;
  });
  els.groupVol.addEventListener('input', () => {
    state.groupDragUntil = Date.now() + 1000;
    els.groupVolVal.textContent = els.groupVol.value;
    paintRange(els.groupVol, Number(els.groupVol.value));
    clearTimeout(timer);
    timer = setTimeout(() => sendGroupVolume(Number(els.groupVol.value)), 130);
  });
  els.groupVol.addEventListener('change', () => {
    clearTimeout(timer);
    sendGroupVolume(Number(els.groupVol.value));
    state.groupDragUntil = Date.now() + 900;
  });
}

async function sendGroupVolume(value) {
  try {
    await api('/api/group/command', { method: 'POST', body: { command: 'volume', value } });
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ── add dialog ──────────────────────────────────────── */

function bindDialog() {
  const open = () => {
    els.addError.hidden = true;
    els.addDialog.showModal();
  };
  $('#addBtn').addEventListener('click', open);
  $('#emptyAddBtn').addEventListener('click', open);
  $('#closeDialog').addEventListener('click', () => els.addDialog.close());

  els.addForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fd = new FormData(els.addForm);
    const host = String(fd.get('host') || '').trim();
    const name = String(fd.get('name') || '').trim();
    if (!host) return;

    const submit = $('#addSubmit');
    submit.disabled = true;
    els.addError.hidden = true;
    try {
      await addSpeaker({ name, host });
      els.addForm.reset();
      els.addDialog.close();
      toast('Колонка добавлена. Нажмите «+» на её корпусе для сопряжения.', 'success');
    } catch (err) {
      els.addError.textContent = err.message;
      els.addError.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });

  $('#discoverBtn').addEventListener('click', runDiscover);
}

async function runDiscover() {
  const btn = $('#discoverBtn');
  btn.disabled = true;
  btn.textContent = 'Ищем…';
  els.discoverList.replaceChildren();
  const hint = document.createElement('div');
  hint.className = 'discover-hint';
  hint.textContent = 'Сканируем _staros._tcp…';
  els.discoverList.append(hint);

  try {
    const { devices } = await api('/api/discover');
    els.discoverList.replaceChildren();
    if (!devices.length) {
      const empty = document.createElement('div');
      empty.className = 'discover-hint';
      empty.textContent = 'Ничего не найдено. Введите IP вручную — это работает всегда.';
      els.discoverList.append(empty);
      return;
    }
    for (const dev of devices) {
      const item = document.createElement('div');
      item.className = 'discover-item';

      const info = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'di-name';
      name.textContent = dev.name;
      const host = document.createElement('div');
      host.className = 'di-host';
      host.textContent = `${dev.host}:${dev.port}${dev.model ? ` · ${dev.model}` : ''}`;
      info.append(name, host);

      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'btn small';
      add.textContent = 'Добавить';
      add.addEventListener('click', async () => {
        add.disabled = true;
        try {
          await addSpeaker({ name: dev.name, host: dev.host, port: dev.port });
          els.addForm.reset();
          els.addDialog.close();
          toast('Колонка добавлена. Нажмите «+» на её корпусе.', 'success');
        } catch (err) {
          toast(err.message, 'error');
          add.disabled = false;
        }
      });

      item.append(info, add);
      els.discoverList.append(item);
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Искать';
  }
}

/* ── live updates ────────────────────────────────────── */

function applySnapshot(data) {
  if (!data || !Array.isArray(data.speakers)) return;
  state.speakers = data.speakers;
  state.multiroom = data.multiroom || null;
  state.serverTime = data.serverTime || Date.now();
  state.offset = state.serverTime - Date.now();
  render();
}

function setServerPill(up) {
  els.serverPill.classList.toggle('down', !up);
  els.serverPill.lastChild.textContent = up ? ' сервер' : ' нет связи';
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onopen = () => setServerPill(true);
  es.onerror = () => setServerPill(false);
  es.onmessage = (event) => {
    try {
      applySnapshot(JSON.parse(event.data));
      setServerPill(true);
    } catch {
      /* ignore */
    }
  };
}

async function poll() {
  try {
    applySnapshot(await api('/api/state'));
    setServerPill(true);
  } catch {
    setServerPill(false);
  }
}

/* ── progress animation ──────────────────────────────── */

function tick() {
  const now = Date.now() + state.offset;
  for (const { refs } of cards.values()) {
    const sp = refs.sp;
    const t = sp?.track;
    if (!t) {
      refs.fill.style.width = '0%';
      refs.knob.style.left = '0%';
      refs.tPos.textContent = '';
      refs.tDur.textContent = '';
      continue;
    }
    let pos = t.position ?? 0;
    if (t.playing && t.positionAt) pos += Math.max(0, (now - t.positionAt) / 1000);
    const dur = t.duration || 0;
    if (dur) pos = Math.min(pos, dur);
    const pct = dur ? Math.min(100, (pos / dur) * 100) : 0;

    refs.fill.style.width = `${pct}%`;
    refs.knob.style.left = `${pct}%`;
    refs.tPos.textContent = t.position === null && !t.playing ? '' : fmtTime(pos);
    refs.tDur.textContent = dur ? fmtTime(dur) : t.station ? '' : '';
  }
  requestAnimationFrame(tick);
}

/* ── init ────────────────────────────────────────────── */

function init() {
  hydrateIcons(document);
  bindGroup();
  bindDialog();
  connectEvents();
  poll();
  pollTimer = setInterval(poll, 15000);
  requestAnimationFrame(tick);
}

init();
