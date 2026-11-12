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
  cast: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4.5" width="19" height="12" rx="2.5"/><path d="M7 20h10"/><path d="M8.5 12.6a3.7 3.7 0 0 1 3.7-3.7"/><path d="M8.5 9a6.7 6.7 0 0 1 6.7 6.7"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.2"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><line x1="16" y1="16" x2="21" y2="21"/></svg>',
  pulse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2.2-5.5L13 17l2.3-5H21"/></svg>',
  queue: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="4" y1="7" x2="16" y2="7"/><line x1="4" y1="12" x2="16" y2="12"/><line x1="4" y1="17" x2="12" y2="17"/><path d="M19 13v7"/><path d="m16.5 17.5 2.5 2.5 2.5-2.5"/></svg>',
  playSmall: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72c0 .84.92 1.35 1.63.9l10.6-6.86a1.08 1.08 0 0 0 0-1.8L9.63 4.24A1.08 1.08 0 0 0 8 5.14Z"/></svg>',
  speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="5" y="2.2" width="14" height="19.6" rx="3.2"/><circle cx="12" cy="14.3" r="3.1"/><circle cx="12" cy="7.3" r="1.1" fill="currentColor" stroke="none"/></svg>',
  bluetooth: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m7 7.5 10 9-5 4V3.5l5 4-10 9"/></svg>',
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
  searchDialog: $('#searchDialog'),
  searchTitle: $('#searchTitle'),
  searchTarget: $('#searchTarget'),
  closeSearch: $('#closeSearch'),
  searchForm: $('#searchForm'),
  searchInput: $('#searchInput'),
  searchClear: $('#searchClear'),
  searchBtn: $('#searchBtn'),
  searchStatus: $('#searchStatus'),
  searchResults: $('#searchResults'),
  linkDetails: $('#linkDetails'),
  linkForm: $('#linkForm'),
  linkInput: $('#linkInput'),
  linkBtn: $('#linkBtn'),
  queueDialog: $('#queueDialog'),
  queueTitle: $('#queueTitle'),
  queueContext: $('#queueContext'),
  queueStatus: $('#queueStatus'),
  queueList: $('#queueList'),
  queueRefresh: $('#queueRefresh'),
  closeQueue: $('#closeQueue'),
  diagDialog: $('#diagDialog'),
  diagSub: $('#diagSub'),
  diagStatus: $('#diagStatus'),
  diagReco: $('#diagReco'),
  diagTable: $('#diagTable'),
  diagResult: $('#diagResult'),
  diagRefresh: $('#diagRefresh'),
  diagClock: $('#diagClock'),
  diagSync: $('#diagSync'),
  closeDiag: $('#closeDiag'),
  btDialog: $('#btDialog'),
  btTitle: $('#btTitle'),
  btTarget: $('#btTarget'),
  btStatus: $('#btStatus'),
  btList: $('#btList'),
  btDiscoverable: $('#btDiscoverable'),
  btHint: $('#btHint'),
  btRefresh: $('#btRefresh'),
  btScan: $('#btScan'),
  btScanStatus: $('#btScanStatus'),
  btScanList: $('#btScanList'),
  closeBt: $('#closeBt'),
};

const state = {
  speakers: [],
  nativeMultiroom: null,
  serverTime: Date.now(),
  offset: 0,
  groupDragUntil: 0,
  nativeBusy: false,
  searchSpeakerId: null,
  searchSeq: 0,
  historySeq: 0,
  queueSpeakerId: null,
  btSpeakerId: null,
  btBusy: false,
  bt: null,
  diagData: null,
  diagBusy: false,
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
    searchBtn: $('[data-action="search"]', node),
    queueBtn: $('[data-action="queue"]', node),
    btBtn: $('[data-action="bluetooth"]', node),
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
  const native = state.nativeMultiroom || {};
  const nativeActive = native.state === 'active';
  const inGroup = Boolean(nativeActive && native.memberIds?.includes(sp.id));
  const isSource = inGroup && native.masterId === sp.id;

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

  if (inGroup) {
    c.multiChip.hidden = false;
    // Единый короткий чип: одинаковая ширина на всех колонках группы, чтобы
    // карточки не «плыли» по высоте. Роль остаётся в tooltip при наведении.
    c.multiChip.textContent = 'мультирум';
    c.multiChip.title = isSource
      ? 'Мультирум: эта колонка — мастер нативной SberCast-группы'
      : 'Мультирум: колонка играет в нативной SberCast-группе';
  } else {
    c.multiChip.hidden = true;
    c.multiChip.textContent = '';
    c.multiChip.title = '';
  }

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
  c.queueBtn.disabled = !online;
  c.queueBtn.title = online ? 'Очередь колонки' : 'Колонка не в сети';
  c.btBtn.disabled = !online;
  c.btBtn.title = online ? 'Bluetooth-устройства колонки' : 'Колонка не в сети';
  c.searchBtn.disabled = !online;
  c.searchBtn.title = online
    ? 'Найти музыку и включить на этой колонке'
    : 'Колонка не в сети';

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

/** Источник, с которого прошивка сможет построить нативную группу. */
function isPlayableSource(sp) {
  if (sp.player?.playing) return true;
  return Boolean(sp.track?.playing && isMusicTrack(sp));
}

function updateMultiButton(c, sp, { online, inGroup, isSource }) {
  const native = state.nativeMultiroom || {};
  const busy =
    state.nativeBusy || native.state === 'starting' || native.state === 'stopping';
  const others = state.speakers.filter((s) => s.id !== sp.id && s.status === 'connected').length;

  let label = 'Мультирум';
  let icon = 'multiroom';
  let disabled = busy || !online;
  let title = 'Включить этот трек на остальных колонках (нативный SberCast)';

  if (inGroup) {
    label = 'Стоп';
    icon = 'stop';
    title = isSource
      ? 'Остановить нативный мультирум'
      : 'Остановить нативный мультирум — пауза на мастере';
    disabled = busy;
    c.multiBtn.classList.add('active');
  } else {
    c.multiBtn.classList.remove('active');
    if (native.state === 'active') {
      disabled = true;
      title = 'Мультирум уже включён с другой колонки';
    } else if (!others) {
      disabled = true;
      title = 'Нужна ещё хотя бы одна подключённая колонка';
    } else if (!isPlayableSource(sp)) {
      disabled = true;
      title = 'Включите музыку Звука или радио на этой колонке';
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
  const native = state.nativeMultiroom || {};
  let sub = `${connected.length} из ${list.length} в сети`;
  if (native.state === 'starting') sub += ' · мультирум запускается…';
  else if (native.state === 'stopping') sub += ' · мультирум останавливается…';
  else if (native.state === 'active') sub += ` · нативный мультирум: ${native.memberIds?.length || 0}`;
  else if (native.message) sub += ` · ${native.message}`;
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

  // Групповая кнопка мультирума: нативный SberCast, группу строит прошивка.
  const hasSource = connected.some(isPlayableSource);
  const mrBtn = $('[data-action="g-multiroom"]', els.groupPanel);
  if (mrBtn) {
    const busy =
      state.nativeBusy || native.state === 'starting' || native.state === 'stopping';
    const active = native.state === 'active';
    const icon = active ? 'stop' : 'cast';
    const ico = $('[data-icon]', mrBtn);
    if (ico && ico.dataset.icon !== icon) {
      ico.dataset.icon = icon;
      ico.innerHTML = ICONS[icon];
    }
    mrBtn.classList.toggle('active', active);
    mrBtn.disabled = busy || (!active && (!hasSource || connected.length < 2));
    mrBtn.title = active
      ? 'Остановить нативный мультирум'
      : hasSource
        ? 'Нативный мультирум: группу строит сама колонка'
        : 'Включите музыку Звука или радио на одной из колонок';
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
    case 'queue':
      openQueue(sp);
      break;
    case 'bluetooth':
      openBluetooth(sp);
      break;
    case 'search':
      openSearch(sp);
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

/* ── мультирум ───────────────────────────────────────── */

/**
 * Карточка всегда управляет НАТИВНЫМ мультирумом. Программная
 * синхронизация через deeplink оставлена только в API (`/api/multiroom/*`),
 * в интерфейсе её нет — она даёт слышимый рассинхрон.
 */
async function onMultiroom(sp) {
  const native = state.nativeMultiroom || {};
  if (native.state === 'active' || native.state === 'starting' || native.state === 'stopping') {
    return stopNativeMultiroom();
  }
  if (!isPlayableSource(sp)) {
    toast('Включите музыку Звука или радио на этой колонке', 'error');
    return;
  }
  return startNativeMultiroom(sp);
}

/* ── нативный мультирум ─────────────────────────────── */

async function startNativeMultiroom(sp) {
  const nm = state.nativeMultiroom || {};
  if (state.nativeBusy || nm.state === 'starting' || nm.state === 'stopping') return;
  state.nativeBusy = true;
  render();
  try {
    const data = await api('/api/multiroom/native/start', {
      method: 'POST',
      body: { masterId: sp.id },
    });
    if (data.state) applySnapshot(data.state);
    const message = data.native?.message;
    toast(message || 'Нативный мультирум включён', message ? 'error' : 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    state.nativeBusy = false;
    render();
  }
}

async function stopNativeMultiroom() {
  if (state.nativeBusy) return;
  state.nativeBusy = true;
  render();
  toast('Распускаю группу — колонки выйдут из мультирума за ~10 секунд');
  try {
    const data = await api('/api/multiroom/native/stop', { method: 'POST' });
    if (data.state) applySnapshot(data.state);
    const message = data.native?.message;
    toast(message || 'Нативный мультирум выключен', message ? 'error' : 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    state.nativeBusy = false;
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

    if (action === 'g-diagnostics') {
      openDiagnostics();
      return;
    }

    if (action === 'g-multiroom') {
      const native = state.nativeMultiroom || {};
      if (native.state === 'active' || native.state === 'starting' || native.state === 'stopping') {
        await stopNativeMultiroom();
        return;
      }
      const source = connected.find(isPlayableSource);
      if (!source) {
        toast('Включите музыку Звука или радио на одной из колонок', 'error');
        return;
      }
      await startNativeMultiroom(source);
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

/* ── Звук: поиск и отправка ──────────────────────────── */

function speakerName(id) {
  return state.speakers.find((sp) => String(sp.id) === String(id))?.name || 'колонку';
}

function setSearchStatus(text, kind = '') {
  els.searchStatus.hidden = !text;
  els.searchStatus.className = `zp-status ${kind}`;
  els.searchStatus.replaceChildren();
  if (text) els.searchStatus.textContent = text;
}

function clearSearchStatus() {
  setSearchStatus('');
}

function sectionTitle(key) {
  return {
    tracks: 'Треки',
    playlists: 'Плейлисты',
    artists: 'Исполнители',
    releases: 'Альбомы',
  }[key] || key;
}

function makeCover(src, fallbackIcon = 'queue') {
  const box = document.createElement('div');
  box.className = 'zp-cover';
  const addFallback = () => {
    box.classList.add('noart');
    const ico = document.createElement('span');
    ico.dataset.icon = fallbackIcon;
    ico.innerHTML = ICONS[fallbackIcon] || '';
    box.append(ico);
  };
  if (src) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = src;
    img.addEventListener('error', () => {
      img.remove();
      addFallback();
    });
    box.append(img);
  } else {
    addFallback();
  }
  return box;
}

function fallbackIcon(kind) {
  if (kind === 'artist') return 'heart';
  if (kind === 'track' || kind === 'podcast') return 'play';
  return 'queue';
}

function makeResultRow(item, { origin }) {
  const targetName = speakerName(state.searchSpeakerId);
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'zp-item';
  row.dataset.origin = origin;
  row.dataset.kind = item.kind;
  row.dataset.id = item.id;
  row.dataset.title = item.title || `ID ${item.id}`;
  row.dataset.subtitle = item.subtitle || '';
  row.dataset.cover = item.cover || '';
  row.dataset.duration = item.duration ? String(item.duration) : '';
  row.title = `Играть на «${targetName}»`;
  row.setAttribute('aria-label', `Играть «${item.title || item.id}» на «${targetName}»`);

  row.append(makeCover(item.cover, fallbackIcon(item.kind)));

  const info = document.createElement('div');
  info.className = 'zp-info';
  const name = document.createElement('div');
  name.className = 'zp-name';
  name.textContent = item.title || `ID ${item.id}`;
  const meta = document.createElement('div');
  meta.className = 'zp-meta';
  const bits = [];
  if (item.subtitle) bits.push(item.subtitle);
  if (item.duration) bits.push(fmtTime(item.duration));
  if (item.explicit) bits.push('18+');
  if (item.count >= 2) bits.push(`×${item.count}`);
  meta.textContent = bits.join(' · ') || (item.kind === 'track' ? 'Трек' : '');
  info.append(name, meta);
  row.append(info);

  const play = document.createElement('span');
  play.className = 'zp-play';
  play.dataset.icon = 'playSmall';
  play.innerHTML = ICONS.playSmall;
  play.setAttribute('aria-hidden', 'true');
  const playLabel = document.createElement('span');
  playLabel.className = 'zp-play-label';
  playLabel.textContent = 'Играть';
  play.append(playLabel);
  row.append(play);

  return row;
}

function appendResultSection(title, items, { origin, clear = false, showCount = true } = {}) {
  if (!items.length) return null;

  const section = document.createElement('section');
  section.className = 'zp-section';
  const head = document.createElement('div');
  head.className = 'zp-section-head';
  const heading = document.createElement('h3');
  heading.textContent = title;
  head.append(heading);
  if (showCount) {
    const count = document.createElement('span');
    count.textContent = String(items.length);
    head.append(count);
  }
  if (clear) {
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'zp-history-clear';
    clearBtn.dataset.historyClear = '';
    clearBtn.textContent = 'Очистить';
    head.append(clearBtn);
  }
  section.append(head);

  const list = document.createElement('div');
  list.className = 'zp-list';
  for (const item of items) list.append(makeResultRow(item, { origin }));
  section.append(list);
  els.searchResults.append(section);
  return section;
}

function renderSearchIntro() {
  els.searchResults.replaceChildren();
  const box = document.createElement('div');
  box.className = 'search-intro';
  const ico = document.createElement('span');
  ico.className = 'search-intro-ico';
  ico.dataset.icon = 'search';
  ico.innerHTML = ICONS.search;
  const title = document.createElement('div');
  title.className = 'search-intro-title';
  title.textContent = 'Найдите трек по названию';
  const text = document.createElement('div');
  text.className = 'search-intro-text';
  text.textContent =
    'Результаты появятся здесь. Запущенное из поиска сохранится в истории и будет предлагаться в следующий раз.';
  box.append(ico, title, text);
  els.searchResults.append(box);
}

function renderSearchResults(data) {
  els.searchResults.replaceChildren();
  els.searchResults.scrollTop = 0;
  const sections = data?.sections || {};
  const order = ['tracks', 'playlists', 'artists', 'releases'];
  let total = 0;

  for (const key of order) {
    const items = Array.isArray(sections[key]) ? sections[key] : [];
    if (!items.length) continue;
    total += items.length;
    appendResultSection(sectionTitle(key), items, { origin: 'search' });
  }

  if (!total) {
    setSearchStatus(`Ничего не найдено по запросу «${data?.query || ''}».`, 'none');
  } else {
    const suffix = data?.stale ? ' · показаны сохранённые результаты' : '';
    setSearchStatus(`Найдено: ${total}${suffix}`, 'ok');
  }
}

function renderHistory(items) {
  els.searchResults.replaceChildren();
  els.searchResults.scrollTop = 0;

  const valid = (Array.isArray(items) ? items : []).filter(
    (item) => item && item.kind && item.id,
  );
  if (!valid.length) {
    renderSearchIntro();
    setSearchStatus('', '');
    return;
  }

  const frequent = valid.filter((item) => Number(item.count) >= 2).slice(0, 5);
  const recent = valid.filter((item) => Number(item.count) < 2).slice(0, 10);

  appendResultSection('Часто запускаете', frequent, { origin: 'history', clear: true });
  appendResultSection('Недавние', recent, {
    origin: 'history',
    clear: !frequent.length,
    showCount: false,
  });

  setSearchStatus('', '');
}

async function runSearch(query) {
  const q = String(query ?? '').trim();
  if (!state.searchSpeakerId) return;
  if (q.length < 2) {
    toast('Введите хотя бы два символа', 'error');
    return;
  }
  const seq = ++state.searchSeq;
  state.historySeq += 1;
  els.searchBtn.disabled = true;
  els.searchResults.replaceChildren();
  setSearchStatus('Ищем в каталоге Звука…', 'loading');

  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}&limit=6`);
    if (seq !== state.searchSeq || !state.searchSpeakerId) return;
    renderSearchResults(data);
  } catch (err) {
    if (seq !== state.searchSeq) return;
    els.searchResults.replaceChildren();
    setSearchStatus('', '');
    els.linkDetails.open = true;
    const box = document.createElement('div');
    box.className = 'zp-error';
    const message = document.createElement('div');
    message.textContent = err.message;
    const hint = document.createElement('div');
    hint.className = 'zp-error-hint';
    hint.append('Поиск — не единственный путь: вставьте ссылку на zvuk.com или числовой ID в разделе ниже. ');
    const link = document.createElement('a');
    link.href = `https://zvuk.com/search?query=${encodeURIComponent(q)}`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Открыть поиск на zvuk.com';
    hint.append(link);
    box.append(message, hint);
    els.searchResults.append(box);
  } finally {
    if (seq === state.searchSeq) els.searchBtn.disabled = false;
  }
}

async function loadHistory() {
  const speakerId = state.searchSpeakerId;
  if (!speakerId) return;
  const seq = ++state.historySeq;
  els.searchResults.replaceChildren();
  setSearchStatus('Загружаем историю…', 'loading');

  try {
    const data = await api('/api/history?limit=24');
    if (seq !== state.historySeq || state.searchSpeakerId !== speakerId) return;
    renderHistory(data?.items);
  } catch {
    if (seq !== state.historySeq) return;
    renderSearchIntro();
    setSearchStatus('История сейчас недоступна — поиск работает', 'none');
  }
}

async function clearHistory() {
  const seq = ++state.historySeq;
  try {
    await api('/api/history', { method: 'DELETE' });
    if (seq !== state.historySeq) return;
    renderSearchIntro();
    toast('История поиска очищена');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/** Вернуть пользователя к карточке колонки, из которой открывали поиск. */
function focusCard(id) {
  const card = cards.get(id);
  if (!card?.node) return;
  const node = card.node;
  node.classList.remove('flash');
  void node.offsetWidth;
  node.classList.add('flash');
  window.setTimeout(() => node.classList.remove('flash'), 1800);
  if (typeof node.scrollIntoView === 'function') {
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function closeSearch() {
  const speakerId = state.searchSpeakerId;
  state.searchSpeakerId = null;
  state.searchSeq += 1;
  state.historySeq += 1;
  els.searchInput.value = '';
  els.searchClear.hidden = true;
  els.linkInput.value = '';
  els.linkDetails.open = false;
  els.searchResults.replaceChildren();
  els.searchBtn.disabled = false;
  closeDialog(els.searchDialog);
  focusCard(speakerId);
}

function openSearch(sp) {
  state.searchSpeakerId = sp.id;
  state.searchSeq += 1;
  state.historySeq += 1;
  els.searchTitle.textContent = `Найти · ${sp.name}`;
  els.searchTarget.textContent = `Выбранный трек заиграет на «${sp.name}»`;
  els.searchInput.value = '';
  els.searchClear.hidden = true;
  els.linkInput.value = '';
  els.linkDetails.open = false;
  els.searchResults.replaceChildren();
  clearSearchStatus();
  els.searchBtn.disabled = false;
  openDialog(els.searchDialog);
  loadHistory();
  window.setTimeout(() => {
    if (state.searchSpeakerId === sp.id) els.searchInput.focus();
  }, 60);
}

async function playContent(payload, label, targetId, button = null, extra = {}) {
  const id = targetId;
  if (!id) {
    toast('Нет подключённой колонки', 'error');
    return false;
  }
  if (button) button.classList.add('busy');
  const body = { ...payload };
  if (extra.origin) body.origin = extra.origin;
  if (extra.meta) body.meta = extra.meta;
  try {
    const data = await api(`/api/speakers/${id}/play`, { method: 'POST', body });
    if (data.state) applySnapshot(data.state);
    const title = label || data.content?.title || `ID ${data.content?.id || ''}`;
    const target = speakerName(id);
    if (data.failed?.length) {
      toast(`${title}: ${data.failed.join('; ')}`, 'error');
    } else if (data.confirmed) {
      toast(`«${title}» → ${target}`, 'success');
    } else {
      toast(`Команда отправлена: ${title} → ${target}. Колонка ещё переключается.`, 'success');
    }
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  } finally {
    if (button) button.classList.remove('busy');
  }
}

function rowMeta(row) {
  return {
    kind: row.dataset.kind,
    id: row.dataset.id,
    title: row.dataset.title || null,
    subtitle: row.dataset.subtitle || null,
    cover: row.dataset.cover || null,
    duration: Number(row.dataset.duration) || null,
  };
}

function bindSearch() {
  els.searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    runSearch(els.searchInput.value);
  });

  els.searchInput.addEventListener('input', () => {
    els.searchClear.hidden = !els.searchInput.value.trim();
    if (!els.searchInput.value.trim()) {
      state.searchSeq += 1;
      loadHistory();
    } else {
      state.historySeq += 1;
      clearSearchStatus();
    }
  });

  els.searchClear.addEventListener('click', () => closeSearch());
  els.closeSearch.addEventListener('click', () => closeSearch());

  els.searchDialog.addEventListener('close', () => {
    if (!state.searchSpeakerId) return;
    const speakerId = state.searchSpeakerId;
    state.searchSpeakerId = null;
    state.searchSeq += 1;
    state.historySeq += 1;
    focusCard(speakerId);
  });

  els.linkForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = els.linkInput.value.trim();
    const speakerId = state.searchSpeakerId;
    if (!value) {
      toast('Вставьте ссылку zvuk.com или ID', 'error');
      return;
    }
    if (!speakerId) return;
    const ok = await playContent({ url: value }, value, speakerId, els.linkBtn);
    if (ok) closeSearch();
  });

  els.searchResults.addEventListener('click', async (event) => {
    if (event.target.closest('[data-history-clear]')) {
      await clearHistory();
      return;
    }
    const row = event.target.closest('.zp-item');
    if (!row || row.classList.contains('busy')) return;
    const speakerId = state.searchSpeakerId;
    if (!speakerId) return;
    const ok = await playContent(
      { kind: row.dataset.kind, id: row.dataset.id },
      row.dataset.title,
      speakerId,
      row,
      { origin: row.dataset.origin, meta: rowMeta(row) },
    );
    if (ok) closeSearch();
  });
}

/* ── очередь колонки ─────────────────────────────────── */

function openDialog(dialog) {
  if (!dialog) return;
  try {
    if (!dialog.open) dialog.showModal();
  } catch {
    dialog.setAttribute('open', '');
  }
}

function closeDialog(dialog) {
  if (!dialog) return;
  try {
    dialog.close();
  } catch {
    dialog.removeAttribute('open');
  }
}

function typeLabel(type) {
  return {
    endless: 'Волна',
    album: 'Альбом',
    user: 'Плейлист',
    playlist: 'Плейлист',
    artist: 'Исполнитель',
    release: 'Альбом',
    podcast: 'Подкаст',
  }[String(type || '').toLowerCase()] || null;
}

function renderQueue(data) {
  const context = data?.context || {};
  const bits = [context.playlistTitle, typeLabel(context.playlistType)].filter(Boolean);
  els.queueContext.textContent = bits.length
    ? bits.join(' · ')
    : 'Колонка не сообщает текущий плейлист';

  els.queueList.replaceChildren();
  const items = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) {
    els.queueStatus.hidden = false;
    els.queueStatus.textContent =
      'Очередь пуста или колонка не отдаёт её для этого источника (радио, Bluetooth, волна).';
    return;
  }

  if (data.catalogError) {
    els.queueStatus.hidden = false;
    els.queueStatus.textContent = `Названия недоступны: ${data.catalogError}`;
  } else {
    els.queueStatus.hidden = true;
  }

  items.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = `queue-item${item.current ? ' current' : ''}`;
    row.dataset.trackId = item.trackId;

    const num = document.createElement('span');
    num.className = 'queue-num';
    num.textContent = item.current ? '♪' : String(index + 1);

    row.append(num, makeCover(item.cover, 'play'));

    const info = document.createElement('div');
    info.className = 'queue-info';
    const name = document.createElement('div');
    name.className = 'queue-name';
    name.textContent = item.title || `Трек ${item.trackId}`;
    const meta = document.createElement('div');
    meta.className = 'queue-meta';
    const parts = [];
    if (item.artists?.length) parts.push(item.artists.join(', '));
    if (item.duration) parts.push(fmtTime(item.duration));
    if (item.explicit) parts.push('18+');
    meta.textContent = parts.join(' · ') || (item.current ? 'Играет сейчас' : '');
    info.append(name, meta);
    row.append(info);

    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'zp-play';
    play.dataset.queuePlay = item.trackId;
    play.dataset.title = item.title || `Трек ${item.trackId}`;
    play.title = 'Играть этот трек';
    play.setAttribute('aria-label', `Играть «${play.dataset.title}»`);
    play.innerHTML = ICONS.playSmall;
    row.append(play);

    els.queueList.append(row);
  });
}

async function loadQueue() {
  const id = state.queueSpeakerId;
  if (!id) return;
  els.queueStatus.hidden = false;
  els.queueStatus.textContent = 'Загружаем очередь…';
  els.queueRefresh.disabled = true;
  try {
    const data = await api(`/api/speakers/${id}/queue`);
    if (state.queueSpeakerId !== id) return;
    renderQueue(data);
  } catch (err) {
    if (state.queueSpeakerId !== id) return;
    els.queueList.replaceChildren();
    els.queueStatus.hidden = false;
    els.queueStatus.textContent = err.message;
  } finally {
    els.queueRefresh.disabled = false;
  }
}

async function openQueue(sp) {
  state.queueSpeakerId = sp.id;
  els.queueTitle.textContent = `Очередь · ${sp.name}`;
  els.queueContext.textContent = '';
  els.queueList.replaceChildren();
  openDialog(els.queueDialog);
  await loadQueue();
}

function bindQueue() {
  els.closeQueue.addEventListener('click', () => {
    state.queueSpeakerId = null;
    closeDialog(els.queueDialog);
  });
  els.queueDialog.addEventListener('close', () => {
    state.queueSpeakerId = null;
  });
  els.queueRefresh.addEventListener('click', () => loadQueue());
  els.queueList.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-queue-play]');
    if (!button || button.classList.contains('busy')) return;
    const ok = await playContent(
      { kind: 'track', id: button.dataset.queuePlay },
      button.dataset.title,
      state.queueSpeakerId,
      button,
    );
    if (ok) loadQueue();
  });
}

/* ── bluetooth ───────────────────────────────────────── */

const BT_HINT =
  'Колонка станет видимой по Bluetooth. Подключите к ней телефон или компьютер ' +
  'в настройках Bluetooth — звук пойдёт с вашего устройства.';

function setBtStatus(el, text, kind = '') {
  el.hidden = !text;
  el.className = `queue-status${kind ? ` ${kind}` : ''}`;
  el.textContent = text || '';
}

function makeBtRow(device, { scanned = false } = {}) {
  const row = document.createElement('div');
  row.className = 'bt-item';
  row.dataset.mac = device.mac;

  const ico = document.createElement('span');
  ico.className = 'bt-item-ico';
  ico.innerHTML = ICONS.bluetooth;
  ico.setAttribute('aria-hidden', 'true');

  const info = document.createElement('div');
  info.className = 'bt-info';
  const name = document.createElement('div');
  name.className = 'bt-name';
  name.textContent = device.name || device.mac;
  const meta = document.createElement('div');
  meta.className = 'bt-meta';
  if (scanned) {
    const bits = [device.mac];
    if (typeof device.rssi === 'number') bits.push(`${device.rssi} dBm`);
    meta.textContent = bits.join(' · ');
  } else {
    meta.append(device.mac);
    const status = document.createElement('span');
    status.className = `bt-state${device.connected ? ' on' : ''}`;
    status.textContent = device.connected ? 'подключено' : 'спарено';
    meta.append(' · ', status);
  }
  info.append(name, meta);
  row.append(ico, info);

  if (!scanned) {
    const actions = document.createElement('div');
    actions.className = 'bt-actions';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn small';
    toggle.dataset.btAction = device.connected ? 'disconnect' : 'connect';
    toggle.textContent = device.connected ? 'Отключить' : 'Подключить';
    actions.append(toggle);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn danger';
    remove.dataset.btAction = 'remove';
    remove.title = 'Забыть устройство';
    remove.setAttribute('aria-label', 'Забыть устройство');
    remove.innerHTML = ICONS.trash;
    actions.append(remove);

    row.append(actions);
  }

  return row;
}

function renderBt(bt) {
  const data = bt || {};
  const devices = Array.isArray(data.devices) ? data.devices : [];
  els.btList.replaceChildren();
  for (const device of devices) els.btList.append(makeBtRow(device));

  if (data.error) setBtStatus(els.btStatus, data.error, 'error');
  else if (!devices.length) {
    setBtStatus(
      els.btStatus,
      'Нет спаренных устройств. Включите режим сопряжения и подключите телефон или компьютер.',
    );
  } else {
    setBtStatus(els.btStatus, '');
  }

  const scanned = Array.isArray(data.scanned) ? data.scanned : [];
  els.btScanList.replaceChildren();
  for (const device of scanned) els.btScanList.append(makeBtRow(device, { scanned: true }));

  if (data.scanning) setBtStatus(els.btScanStatus, 'Сканируем Bluetooth-устройства рядом…');
  else if (!scanned.length) {
    setBtStatus(
      els.btScanStatus,
      'Нажмите «Найти», чтобы увидеть устройства рядом. Подключать нужно уже спаренные — из списка выше.',
    );
  } else {
    setBtStatus(els.btScanStatus, 'Подключать нужно уже спаренные — из списка выше.');
  }

  els.btScan.disabled = state.btBusy || Boolean(data.scanning);
}

function applyBtResponse(data) {
  if (data?.state) applySnapshot(data.state);
  if (data?.bt) state.bt = data.bt;
  renderBt(state.bt);
}

async function loadBluetooth({ silent = false } = {}) {
  const id = state.btSpeakerId;
  if (!id) return;
  if (!silent) setBtStatus(els.btStatus, 'Загружаем список устройств…');
  els.btRefresh.disabled = true;
  try {
    const data = await api(`/api/speakers/${id}/bluetooth`);
    if (state.btSpeakerId !== id) return;
    applyBtResponse(data);
  } catch (err) {
    if (state.btSpeakerId !== id) return;
    setBtStatus(els.btStatus, err.message, 'error');
  } finally {
    els.btRefresh.disabled = false;
  }
}

async function runBtScan() {
  const id = state.btSpeakerId;
  if (!id || state.btBusy) return;
  state.btBusy = true;
  els.btScan.disabled = true;
  els.btScan.textContent = 'Ищем…';
  setBtStatus(els.btScanStatus, 'Сканируем Bluetooth-устройства рядом…');
  try {
    const data = await api(`/api/speakers/${id}/bluetooth/scan`, { method: 'POST' });
    if (state.btSpeakerId !== id) return;
    applyBtResponse(data);
  } catch (err) {
    if (state.btSpeakerId !== id) return;
    state.bt = { ...(state.bt || {}), error: err.message, scanning: false };
  } finally {
    state.btBusy = false;
    els.btScan.textContent = 'Найти';
    renderBt(state.bt);
  }
}

async function runBtDiscoverable() {
  const id = state.btSpeakerId;
  if (!id || state.btBusy) return;
  state.btBusy = true;
  els.btDiscoverable.disabled = true;
  els.btHint.textContent = 'Включаем режим сопряжения…';
  try {
    const data = await api(`/api/speakers/${id}/bluetooth/discoverable`, { method: 'POST' });
    if (state.btSpeakerId !== id) return;
    applyBtResponse(data);
    els.btHint.textContent =
      'Режим сопряжения включён. Откройте Bluetooth на телефоне или компьютере, ' +
      'найдите колонку и подключитесь к ней.';
    toast('Bluetooth-сопряжение включено на колонке', 'success');
    window.setTimeout(() => loadBluetooth({ silent: true }), 1200);
  } catch (err) {
    if (state.btSpeakerId !== id) return;
    els.btHint.textContent = BT_HINT;
    toast(err.message, 'error');
  } finally {
    state.btBusy = false;
    els.btDiscoverable.disabled = false;
  }
}

async function runBtCommand(mac, command, button) {
  const id = state.btSpeakerId;
  if (!id || state.btBusy) return;
  state.btBusy = true;
  if (button) {
    button.disabled = true;
    button.classList.add('busy');
  }
  const labels = { connect: 'Подключаем…', disconnect: 'Отключаем…', remove: 'Удаляем…' };
  setBtStatus(els.btStatus, labels[command] || 'Отправляем команду…');
  try {
    const data = await api(`/api/speakers/${id}/bluetooth/command`, {
      method: 'POST',
      body: { mac, command },
    });
    if (state.btSpeakerId !== id) return;
    applyBtResponse(data);
    const messages = {
      connect: 'Команда подключения отправлена',
      disconnect: 'Устройство отключено',
      remove: 'Устройство удалено из спаренных',
    };
    toast(messages[command] || 'Готово', 'success');
  } catch (err) {
    if (state.btSpeakerId !== id) return;
    setBtStatus(els.btStatus, err.message, 'error');
    toast(err.message, 'error');
  } finally {
    state.btBusy = false;
    if (button) {
      button.disabled = false;
      button.classList.remove('busy');
    }
    els.btScan.disabled = false;
  }
}

function openBluetooth(sp) {
  state.btSpeakerId = sp.id;
  state.btBusy = false;
  state.bt = null;
  els.btTitle.textContent = `Bluetooth · ${sp.name}`;
  els.btTarget.textContent = 'Сопряжение и подключение устройств к этой колонке';
  els.btHint.textContent = BT_HINT;
  els.btDiscoverable.disabled = false;
  els.btRefresh.disabled = false;
  els.btScan.disabled = false;
  els.btList.replaceChildren();
  els.btScanList.replaceChildren();
  setBtStatus(els.btStatus, '');
  setBtStatus(els.btScanStatus, '');
  openDialog(els.btDialog);
  loadBluetooth();
}

function bindBluetooth() {
  els.closeBt.addEventListener('click', () => {
    state.btSpeakerId = null;
    closeDialog(els.btDialog);
  });
  els.btDialog.addEventListener('close', () => {
    state.btSpeakerId = null;
  });
  els.btRefresh.addEventListener('click', () => loadBluetooth());
  els.btScan.addEventListener('click', () => runBtScan());
  els.btDiscoverable.addEventListener('click', () => runBtDiscoverable());
  els.btList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-bt-action]');
    if (!button) return;
    const row = button.closest('.bt-item');
    if (!row) return;
    runBtCommand(row.dataset.mac, button.dataset.btAction, button);
  });
}

/* ── diagnostics ─────────────────────────────────────── */

const DIAG_MODE_LABELS = { MASTER: 'мастер', SLAVE: 'ведомая', NONE: 'вне группы' };

function diagMode(mode) {
  if (!mode) return '—';
  return DIAG_MODE_LABELS[mode] || mode;
}

function fmtMs(value) {
  return Number.isFinite(value) ? `${Math.round(value)} мс` : '—';
}

function fmtAge(value) {
  if (!Number.isFinite(value)) return '—';
  return value < 1000 ? `${Math.round(value)} мс` : `${(value / 1000).toFixed(1)} с`;
}

function setDiagStatus(text, kind = '') {
  els.diagStatus.hidden = !text;
  els.diagStatus.className = `queue-status diag-status ${kind}`;
  els.diagStatus.textContent = text || '';
}

function setDiagBusy(busy) {
  state.diagBusy = busy;
  els.diagRefresh.disabled = busy;
  els.diagClock.disabled = busy;
  els.diagSync.disabled = busy;
}

function diagCell(row, text, className = '') {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = text;
  row.append(cell);
  return cell;
}

function renderDiagnostics() {
  const data = state.diagData;
  if (!data) return;
  const rows = data.speakers || [];
  const group = data.group || {};
  const groupText =
    group.mode === 'native'
      ? `нативная группа: ${(group.members || []).join(', ') || '—'}`
      : 'нативная группа не запущена';
  els.diagSub.textContent = `Роли, задержка сети и рассинхрон · ${groupText}`;

  const reco = data.recommendedMaster;
  els.diagReco.hidden = false;
  els.diagReco.replaceChildren();
  if (reco) {
    const title = document.createElement('b');
    title.textContent = `Лучший мастер: ${reco.name}`;
    const detail = document.createElement('span');
    detail.textContent = ` — ${reco.reason}`;
    els.diagReco.append(title, detail);
  } else {
    els.diagReco.textContent =
      'Нет играющей колонки: включите трек Звука или радио, чтобы выбрать мастера.';
  }

  els.diagTable.replaceChildren();
  if (!rows.length) return;

  const table = document.createElement('table');
  table.className = 'diag-grid';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['Колонка', 'Роль', 'Играет', 'Позиция', 'RTT', 'Данные', 'Часы', 'UDP']) {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement('tbody');
  for (const sp of rows) {
    const tr = document.createElement('tr');
    if (sp.mode === 'MASTER') tr.className = 'master';
    diagCell(tr, sp.name, 'diag-name');
    diagCell(tr, diagMode(sp.mode), sp.mode === 'MASTER' ? 'diag-mode master' : 'diag-mode');
    diagCell(tr, sp.playing ? 'да' : 'нет', sp.playing ? 'diag-play on' : 'diag-play');
    diagCell(
      tr,
      Number.isFinite(sp.position) ? `${Math.round(sp.position)} с` : '—',
      'diag-num',
    );
    diagCell(tr, fmtMs(sp.rttMs), 'diag-num');
    diagCell(tr, fmtAge(sp.stateAgeMs), 'diag-num');
    diagCell(tr, fmtMs(sp.clockOffsetMs), 'diag-num');
    diagCell(tr, sp.udpProtocolVersion === null ? '—' : `v${sp.udpProtocolVersion}`, 'diag-num');
    if (sp.mrGroup?.length) {
      tr.title = `Группа: ${sp.mrGroup.join(', ')}`;
    }
    tbody.append(tr);
  }
  table.append(tbody);
  els.diagTable.append(table);
}

async function refreshDiagnostics() {
  if (state.diagBusy) return;
  setDiagBusy(true);
  setDiagStatus('Опрашиваю колонки…');
  try {
    state.diagData = await api('/api/diagnostics?fresh=1');
    setDiagStatus('');
    renderDiagnostics();
  } catch (err) {
    setDiagStatus(err.message, 'error');
  } finally {
    setDiagBusy(false);
  }
}

function renderDiagResult(title, lines) {
  els.diagResult.hidden = false;
  els.diagResult.replaceChildren();
  const heading = document.createElement('b');
  heading.textContent = title;
  els.diagResult.append(heading);
  for (const line of lines) {
    const row = document.createElement('div');
    row.textContent = line;
    els.diagResult.append(row);
  }
}

async function measureDiagClock() {
  if (state.diagBusy) return;
  setDiagBusy(true);
  setDiagStatus('Измеряю часы колонок (несколько запросов на каждую)…');
  try {
    const data = await api('/api/diagnostics/clock', {
      method: 'POST',
      body: { samples: 5, intervalMs: 60 },
    });
    const lines = (data.devices || []).map((d) => {
      if (!Number.isFinite(d.offsetMs)) return `${d.name}: нет данных`;
      const rel = Number.isFinite(d.relativeMs)
        ? `, относительно медианы ${d.relativeMs > 0 ? '+' : ''}${d.relativeMs} мс`
        : '';
      return `${d.name}: ${d.offsetMs > 0 ? '+' : ''}${d.offsetMs} мс${rel}, RTT ${fmtMs(d.rttMs)} (${d.samples} зам.)`;
    });
    if (Number.isFinite(data.spreadMs)) {
      lines.push(`Разброс часов между колонками: ${data.spreadMs} мс`);
    }
    if (data.devices?.length < 2) {
      lines.push('Для сравнения нужно минимум две подключённые колонки.');
    }
    renderDiagResult('Часы колонок', lines);
    setDiagStatus('');
  } catch (err) {
    setDiagStatus(err.message, 'error');
  } finally {
    setDiagBusy(false);
  }
}

async function measureDiagSync() {
  if (state.diagBusy) return;
  const playing = state.speakers.filter((s) => s.status === 'connected' && s.player?.playing);
  if (playing.length < 2) {
    setDiagStatus(
      'Для замера нужны минимум две играющие колонки. Включите трек Звука и запустите нативный мультирум.',
      'error',
    );
    return;
  }
  setDiagBusy(true);
  setDiagStatus('Собираю живую позицию с колонок ~10 секунд…');
  try {
    const data = await api('/api/diagnostics/sync', {
      method: 'POST',
      body: { durationMs: 10000, intervalMs: 100 },
    });
    if (!data.ok) {
      const reasons = {
        'need-two-playing': 'Недостаточно играющих колонок.',
        'not-enough-common-positions': 'Колонки не успели отсчитать общие секунды трека.',
        'no-position-data': 'Нет живой позиции трека: включите обычный трек (не endless-радио) и убедитесь, что он играет.',
        'not-enough-devices': 'Подключено меньше двух колонок.',
      };
      renderDiagResult(
        'Синхронность: нет данных',
        [reasons[data.reason] || data.message || data.reason || 'Неизвестная причина'],
      );
      setDiagStatus('');
      return;
    }
    const lines = [];
    if (data.masterId) {
      const master = (data.devices || []).find((d) => d.id === data.masterId);
      if (master) lines.push(`Опора: ${master.name}`);
    }
    for (const d of data.devices || []) {
      if (d.id === data.masterId) continue;
      const off = Number.isFinite(d.offsetMs) ? d.offsetMs : null;
      lines.push(
        `${d.name}: ${off === null ? 'нет общих секунд' : `${off > 0 ? '+' : ''}${off} мс`}, сэмплов ${d.samples || 0}`,
      );
    }
    lines.push(`Вердикт: ${data.label} · худшее отклонение ${fmtMs(data.worstMs)}`);
    if (Number.isFinite(data.resolutionMs)) {
      lines.push(
        `Разрешение замера ~±${data.resolutionMs} мс: меньшие значения — в пределах шума опроса.`,
      );
    }
    lines.push('Отрицательное значение — колонка отсчитала секунду раньше мастера, положительное — позже.');
    renderDiagResult('Синхронность нативной группы', lines);
    setDiagStatus('');
  } catch (err) {
    setDiagStatus(err.message, 'error');
  } finally {
    setDiagBusy(false);
  }
}

function openDiagnostics() {
  els.diagResult.hidden = true;
  els.diagResult.replaceChildren();
  setDiagStatus('');
  openDialog(els.diagDialog);
  refreshDiagnostics();
}

function bindDiagnostics() {
  els.closeDiag.addEventListener('click', () => closeDialog(els.diagDialog));
  els.diagRefresh.addEventListener('click', () => refreshDiagnostics());
  els.diagClock.addEventListener('click', () => measureDiagClock());
  els.diagSync.addEventListener('click', () => measureDiagSync());
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
  state.nativeMultiroom = data.nativeMultiroom || null;
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
  bindSearch();
  bindQueue();
  bindBluetooth();
  bindDiagnostics();
  connectEvents();
  poll();
  pollTimer = setInterval(poll, 15000);
  requestAnimationFrame(tick);
}

init();
