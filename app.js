'use strict';
/* オペ時計 */
const VERSION = '1.0.12';
const KEY = 'opeclock.v1';
const $ = (id) => document.getElementById(id);

/* ---------- 保存 ---------- */
const DEFAULTS = {
  settings: {
    view: 'both', main: 'clock', showSeconds: true, colonBlink: true,
    bg: '#000000', fg: '#ffffff', font: 'bold',
    warnOn: true, warnMin: 5, overBlink: true,
    presets: [5, 10, 15, 30, 45, 60],
    arrowAnim: true, schedBlink: true,
    rev: 3,
  },
  timer: { mode: 'down', duration: 10 * 60000, elapsedBefore: 0, runStart: null, targetHM: null, targetNext: false },
  lists: [], activeId: null,
};
let S = load();
function load() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
  const base = JSON.parse(JSON.stringify(DEFAULTS));
  if (!d) return base;
  const st = Object.assign(base.settings, d.settings || {});
  // 1.0.6 で矢印の初期設定を「動く」に変えた。それより前に入れた端末も一度だけ「動く」にそろえる
  if (!(d.settings && d.settings.rev >= 3)) { st.arrowAnim = true; st.rev = 3; }
  return {
    settings: st,
    timer: Object.assign(base.timer, d.timer || {}),
    lists: Array.isArray(d.lists) ? d.lists : [],
    activeId: d.activeId || null,
  };
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
if (!S.lists.length) { S.lists.push({ id: uid(), name: '予定', items: [] }); }
if (!S.lists.find(l => l.id === S.activeId)) S.activeId = S.lists[0].id;
function uid() { return Math.random().toString(36).slice(2, 10); }
function activeList() { return S.lists.find(l => l.id === S.activeId) || S.lists[0]; }

/* ---------- 時刻合わせ ---------- */
const sync = { offset: 0, ok: false, at: null, source: '', rtt: null, running: false, lastErr: '' };
function now() { return Date.now() + sync.offset; }
async function sample(src) {
  const t0 = Date.now();
  const r = await fetch(src.url + (src.url.includes('?') ? '&' : '?') + '_=' + t0, { cache: 'no-store', method: src.method || 'GET' });
  const t1 = Date.now();
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const server = await src.parse(r);
  if (!isFinite(server)) throw new Error('parse');
  return { offset: server - (t0 + t1) / 2 + (src.bias || 0), rtt: t1 - t0, server, t0, t1 };
}
// 秒までしか返さない相手：本当の時刻は [秒, 秒+1) のどこか。間隔をずらして何回か聞き、ずれのありうる幅を狭める
async function measureCoarse(src) {
  let lo = -Infinity, hi = Infinity, rtt = Infinity;
  for (let i = 0; i < 6; i++) {
    const s = await sample({ ...src, bias: 0 });
    lo = Math.max(lo, s.server - s.t1);
    hi = Math.min(hi, s.server + 1000 - s.t0);
    rtt = Math.min(rtt, s.rtt);
    await new Promise((r) => setTimeout(r, 170));
  }
  if (!(lo <= hi)) throw new Error('range');
  return { offset: (lo + hi) / 2, rtt };
}
async function measure(src) {
  if (src.coarse) return measureCoarse(src);
  let best = null;
  for (let i = 0; i < 3; i++) {
    const s = await sample(src);
    if (!best || s.rtt < best.rtt) best = s;
  }
  return best;
}
const SOURCES = [
  { name: 'timeapi.io', url: 'https://timeapi.io/api/time/current/zone?timeZone=Asia/Tokyo',
    parse: async (r) => { const j = await r.json(); return Date.UTC(j.year, j.month - 1, j.day, j.hour - 9, j.minute, j.seconds, j.milliSeconds); } },
  { name: 'Cloudflare', url: 'https://www.cloudflare.com/cdn-cgi/trace', coarse: true,
    parse: async (r) => { const m = /ts=([\d.]+)/.exec(await r.text()); return m ? parseFloat(m[1]) * 1000 : NaN; } },
  { name: 'このページのサーバー', url: location.href.split('#')[0].replace(/[^/]*$/, '') + 'manifest.webmanifest', method: 'HEAD', coarse: true,
    parse: async (r) => { const d = r.headers.get('date'); return d ? Date.parse(d) : NaN; } },
];
async function doSync() {
  if (sync.running || !navigator.onLine) { renderSync(); return; }
  sync.running = true;
  let done = false;
  for (const src of SOURCES) {
    try {
      const best = await measure(src);
      sync.offset = best.offset; sync.rtt = best.rtt; sync.ok = true; sync.at = Date.now(); sync.source = src.name; sync.lastErr = '';
      done = true;
      break;
    } catch (e) { sync.lastErr = String(e.message || e); }
  }
  sync.failedLast = !done; // つながっているはずなのにどこにも届かなかった
  sync.running = false;
  renderSync();
}
function syncFresh() { return sync.ok && sync.at && Date.now() - sync.at < 2 * 3600000; }
// 緑＝ネットにつながっていて、2 時間以内に合わせてある。それ以外は灰色（補正は最後に測ったずれを使い続ける）
function syncGreen() { return syncFresh() && navigator.onLine && !sync.failedLast; }
function hm(ms) { const d = jst(ms); return pad(d.h) + ':' + pad(d.m); }
function syncText() {
  if (!sync.ok) return navigator.onLine ? '時刻合わせができていません。端末の時計を使っています。' : 'オフラインです。端末の時計を使っています。';
  const off = sync.offset / 1000;
  const offTxt = `${off >= 0 ? '+' : ''}${off.toFixed(2)} 秒`;
  const at = hm(sync.at + sync.offset);
  if (!navigator.onLine) return `オフラインです（${at} に測ったずれ ${offTxt} を使っています）`;
  if (sync.failedLast) return `ネットの時刻に届きません（${at} に測ったずれ ${offTxt} を使っています）`;
  return `最終補正 ${at}／ずれ ${offTxt}（${sync.source}）` + (syncFresh() ? '' : '\n2 時間以上合わせていません。');
}
function renderSync() {
  $('syncDot').classList.toggle('ok', syncGreen());
  $('syncInfo').textContent = syncText();
  if (!$('syncPop').classList.contains('hidden')) showSyncPop(true);
}
setInterval(doSync, 3600000);
window.addEventListener('online', doSync);
window.addEventListener('offline', renderSync);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { doSync(); wake(); } });

/* ---------- 日本時間 ---------- */
const WD = ['日', '月', '火', '水', '木', '金', '土'];
function pad(n) { return String(n).padStart(2, '0'); }
function jst(ms) {
  const d = new Date(ms + 9 * 3600000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds(), w: d.getUTCDay() };
}
function todayAt(hhmm, ref) { // "13:30" → 今日の日本時間の ms
  const [h, m] = hhmm.split(':').map(Number);
  const j = jst(ref);
  return Date.UTC(j.y, j.mo - 1, j.d, h - 9, m, 0, 0);
}

/* ---------- 入力の読み方 ---------- */
function z2h(s) { return String(s).normalize('NFKC'); }
function parseDuration(str) { // 右から 秒・分・時
  const s = z2h(str).replace(/\D/g, '');
  if (!s) return null;
  const n = s.padStart(6, '0').slice(-6);
  const h = +n.slice(0, 2), m = +n.slice(2, 4), sec = +n.slice(4, 6);
  if (m > 59 || sec > 59) return null;
  return ((h * 60 + m) * 60 + sec) * 1000;
}
function parseHM(str) { // "1550" "15:50" "15時50分" "9:05" → "15:50"
  const s = z2h(str).trim();
  let h, m;
  let r = /^(\d{1,2})\s*[:時]\s*(\d{1,2})\s*分?$/.exec(s) || /^(\d{1,2})\s*時$/.exec(s);
  if (r) { h = +r[1]; m = r[2] ? +r[2] : 0; }
  else if (/^\d{3,4}$/.test(s)) { h = +s.slice(0, -2); m = +s.slice(-2); }
  else return null;
  if (h > 23 || m > 59) return null;
  return pad(h) + ':' + pad(m);
}
function fmtDur(ms, plus) {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  return (plus ? '+' : '') + (h ? h + ':' + pad(m) : pad(m)) + ':' + pad(s);
}

/* ---------- 予定 ---------- */
function sortedItems(list) { return (list.items || []).filter(i => i.t).slice().sort((a, b) => a.t < b.t ? -1 : a.t > b.t ? 1 : 0); }
function scheduleState(t) {
  const items = sortedItems(activeList());
  let reach = null, next = null;
  for (const it of items) {
    const at = todayAt(it.t, t);
    if (at <= t && t - at < 10000) reach = { ...it, at };
    if (at > t && !next) next = { ...it, at };
  }
  return { reach, next };
}

/* ---------- タイマー ---------- */
function timerElapsed() { const T = S.timer; return T.elapsedBefore + (T.runStart != null ? Date.now() - T.runStart : 0); }
function timerState(t, sched) {
  const T = S.timer;
  if (T.mode === 'up') {
    return { text: fmtDur(timerElapsed()), cls: '', label: 'カウントアップ' };
  }
  let remain, label;
  if (T.mode === 'down') {
    remain = T.duration - timerElapsed();
    label = 'カウントダウン ' + fmtDur(T.duration);
  } else {
    let target = null;
    if (T.targetNext) {
      if (sched.next) { target = sched.next.at; label = sched.next.t + ' ' + (sched.next.l || '') + ' まで'; }
      else label = '次の予定がありません';
    } else if (T.targetHM) { target = todayAt(T.targetHM, t); label = T.targetHM + ' まで'; }
    else label = '時刻が決まっていません';
    if (target == null) return { text: '--:--', cls: '', label };
    remain = target - t;
    remain = remain > 0 ? Math.ceil(remain / 1000) * 1000 : remain;
  }
  if (remain > 0) {
    const r = T.mode === 'down' ? Math.ceil(remain / 1000) * 1000 : remain;
    const warn = S.settings.warnOn && r <= S.settings.warnMin * 60000;
    return { text: fmtDur(r), cls: warn ? 'warn' : '', label };
  }
  if (remain === 0 || remain > -1000) return { text: fmtDur(0), cls: 'over' + (S.settings.overBlink ? ' blink' : ''), label };
  return { text: fmtDur(-remain, true), cls: 'over' + (S.settings.overBlink ? ' blink' : ''), label };
}
function startPause() {
  const T = S.timer;
  if (T.mode === 'target') return;
  if (T.runStart != null) { T.elapsedBefore += Date.now() - T.runStart; T.runStart = null; }
  else T.runStart = Date.now();
  save(); tick(true);
}
function resetTimer() { const T = S.timer; T.elapsedBefore = 0; T.runStart = null; save(); tick(true); }

/* ---------- デジタル時計風の数字 ---------- */
const SEGS = { // a b c d e f g
  '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg', '5': 'acdfg', '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', '-': 'g',
};
const SEGP = {
  a: '14,6 46,6 40,12 20,12', b: '48,8 48,47 42,43 42,14', c: '48,53 48,92 42,86 42,57',
  d: '14,94 46,94 40,88 20,88', e: '12,53 18,57 18,86 12,92', f: '12,8 18,14 18,43 12,47', g: '15,50 21,46 39,46 45,50 39,54 21,54',
};
function segChar(ch) {
  if (ch === ':') return '<svg class="sd colon" viewBox="0 0 24 100" style="width:.24em"><rect x="7" y="28" width="10" height="10"/><rect x="7" y="62" width="10" height="10"/></svg>';
  if (ch === '+') return '<svg class="sd" viewBox="0 0 50 100" style="width:.5em"><rect x="21" y="30" width="8" height="40"/><rect x="5" y="46" width="40" height="8"/></svg>';
  const on = SEGS[ch];
  if (on == null) return '<span>' + ch + '</span>';
  let s = '<svg class="sd" viewBox="0 0 60 100" style="width:.6em">';
  for (const k of 'abcdefg') s += `<polygon points="${SEGP[k]}"${on.includes(k) ? '' : ' class="off"'}/>`;
  return s + '</svg>';
}
function toHTML(text, colonBlink) {
  const seg = S.settings.font === 'seg';
  let out = '';
  for (const ch of text) {
    if (seg) { out += segChar(ch); continue; }
    if (ch === ':') out += '<span class="colon">:</span>';
    else out += ch;
  }
  if (colonBlink) out = out.replace(/class="(sd )?colon"/g, (m, a) => `class="${a || ''}colon blink"`);
  return out;
}

/* ---------- 表示の大きさ合わせ ---------- */
const fitCache = new Map();
function setText(fitEl, txtEl, text, cls, colonBlink) {
  const shape = text.replace(/\d/g, '0') + '|' + S.settings.font + '|' + (colonBlink ? 1 : 0);
  const prev = fitCache.get(txtEl.id) || {};
  if (prev.text !== text || prev.blink !== colonBlink || prev.font !== S.settings.font) {
    txtEl.innerHTML = toHTML(text, colonBlink);
  }
  const c = 'txt ' + (cls || '');
  if (txtEl.className !== c) txtEl.className = c;
  if (prev.shape !== shape || prev.dirty) fit(fitEl, txtEl);
  fitCache.set(txtEl.id, { text, blink: colonBlink, font: S.settings.font, shape });
}
// 数字の「インクのある部分」が文字の箱のどこにあるか（文字の大きさ 100px あたり）
const inkCache = new Map();
function inkBox(txtEl) {
  if (S.settings.font === 'seg') return { top: 6, bot: 94 };
  const cs = getComputedStyle(txtEl);
  const key = cs.fontWeight + ' ' + cs.fontFamily;
  if (inkCache.has(key)) return inkCache.get(key);
  let box = { top: 14, bot: 88 };
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `${cs.fontWeight} 100px ${cs.fontFamily}`;
    const m = ctx.measureText('0123456789');
    if (m.fontBoundingBoxAscent != null && m.actualBoundingBoxAscent) {
      const base = (100 - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 + m.fontBoundingBoxAscent;
      box = { top: base - m.actualBoundingBoxAscent, bot: base + m.actualBoundingBoxDescent };
    }
  } catch (e) {}
  inkCache.set(key, box);
  return box;
}
// 数字を枠いっぱいに大きくし、メインは画面の上下の真ん中に寄せる（大きさを優先し、はみ出す分だけずらす）
function fit(fitEl, txtEl) {
  const W = fitEl.clientWidth, H = fitEl.clientHeight;
  if (!W || !H) return;
  txtEl.style.transform = '';
  txtEl.style.fontSize = '100px';
  const r = txtEl.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const ink = inkBox(txtEl);
  const k = Math.min(W * 0.97 / r.width, H * 0.96 / (ink.bot - ink.top));
  const fs = Math.max(8, Math.floor(100 * k));
  txtEl.style.fontSize = fs + 'px';
  const box = fitEl.getBoundingClientRect(), t = txtEl.getBoundingClientRect();
  const inkTop = t.top + ink.top * fs / 100, inkBot = t.top + ink.bot * fs / 100;
  const want = txtEl.id === 'mainTxt' ? innerHeight / 2 : (box.top + box.bottom) / 2;
  let dy = want - (inkTop + inkBot) / 2;
  dy = Math.max(dy, box.top - inkTop);
  dy = Math.min(dy, box.bottom - inkBot);
  txtEl.style.transform = `translateY(${Math.round(dy)}px)`;
}
function refit() { for (const v of fitCache.values()) v.dirty = true; tick(true); }
new ResizeObserver(refit).observe($('stage'));

/* ---------- 描画 ---------- */
let lastSec = -1;
function tick(force) {
  const t = now();
  const j = jst(t);
  const sec = Math.floor(t / 1000);
  if (!force && sec === lastSec && !S.timer.runStart) { return; }
  lastSec = sec;
  const st = S.settings;
  const sched = scheduleState(t);
  const clockText = pad(j.h) + ':' + pad(j.m) + (st.showSeconds ? ':' + pad(j.s) : '');
  const clockBlink = !st.showSeconds && st.colonBlink;
  const tm = timerState(t, sched);
  $('date').textContent = `${j.mo}月${j.d}日(${WD[j.w]})`;

  const showClock = st.view !== 'timer', showTimer = st.view !== 'clock';
  const mainIsClock = st.view === 'clock' || (st.view === 'both' && st.main === 'clock');
  if (mainIsClock) {
    $('mainLabel').textContent = '';
    setText($('mainFit'), $('mainTxt'), clockText, '', clockBlink);
    if (showTimer) { $('subLabel').textContent = tm.label; setText($('subFit'), $('subTxt'), tm.text, tm.cls, false); }
  } else {
    $('mainLabel').textContent = tm.label;
    setText($('mainFit'), $('mainTxt'), tm.text, tm.cls, false);
    if (showClock) { $('subLabel').textContent = ''; setText($('subFit'), $('subTxt'), clockText, '', clockBlink); }
  }

  const nx = $('next');
  const show = (st.schedBlink && sched.reach) ? sched.reach : sched.next;
  if (show) {
    nx.classList.remove('hidden');
    $('nextTime').textContent = show.t;
    $('nextLabel').textContent = show.l || '';
  } else nx.classList.add('hidden');
  nx.classList.toggle('reach', !!(st.schedBlink && sched.reach));

  const running = S.timer.runStart != null;
  $('btnStart').classList.toggle('running', running);
  $('btnStart').querySelector('span').textContent = running ? '停止' : '開始';
  $('btnStart').hidden = S.timer.mode === 'target' || st.view === 'clock';
  $('btnReset').hidden = S.timer.mode === 'target' || st.view === 'clock';
  $('btnTimer').hidden = st.view === 'clock';
}
setInterval(() => tick(false), 100);

/* ---------- 見た目の設定を反映 ---------- */
function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16 & 255, n >> 8 & 255, n & 255].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function applyLook() {
  const st = S.settings, r = document.documentElement.style, b = document.body;
  r.setProperty('--bg', st.bg); r.setProperty('--fg', st.fg);
  const light = lum(st.bg) > 0.4;
  r.setProperty('--warn', light ? '#a86b00' : '#ffd400');
  r.setProperty('--over', light ? '#d10000' : '#ff3b30');
  document.querySelector('meta[name=theme-color]').setAttribute('content', st.bg);
  b.classList.toggle('light', st.font === 'light');
  b.classList.toggle('arrowAnim', !!st.arrowAnim);
  b.classList.toggle('vClock', st.view === 'clock');
  b.classList.toggle('vTimer', st.view === 'timer');
  refit();
}
function orient() { document.body.classList.toggle('portrait', innerHeight > innerWidth); }
window.addEventListener('resize', orient);

/* ---------- 操作ボタンとロック ---------- */
let locked = false, ctlTimer = null;
function showControls() {
  $('controls').classList.remove('hidden');
  clearTimeout(ctlTimer);
  ctlTimer = setTimeout(hideControls, 5000);
}
function hideControls() { $('controls').classList.add('hidden'); clearTimeout(ctlTimer); }
function anySheetOpen() { return !!document.querySelector('.sheet:not(.hidden)'); }
function toast(msg, ms) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms || 1500);
}
function setLock(v) { locked = v; document.body.classList.toggle('locked', v); if (v) { hideControls(); $('syncPop').classList.add('hidden'); } }

const stage = $('stage');
let press = null;
stage.addEventListener('pointerdown', (e) => {
  if (!locked) return;
  press = { x: e.clientX, y: e.clientY, t: setTimeout(() => { press = null; setLock(false); toast('ロックを解除しました'); }, 2000) };
});
const cancelPress = () => { if (press) { clearTimeout(press.t); press = null; } };
stage.addEventListener('pointerup', cancelPress);
stage.addEventListener('pointercancel', cancelPress);
stage.addEventListener('pointermove', (e) => { if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 15) cancelPress(); });
stage.addEventListener('contextmenu', (e) => e.preventDefault());
stage.addEventListener('click', (e) => {
  if (locked) return;
  if (e.target.closest('#syncDot')) return;
  if (!$('syncPop').classList.contains('hidden')) { $('syncPop').classList.add('hidden'); return; }
  if ($('controls').classList.contains('hidden')) showControls(); else hideControls();
});
$('controls').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  e.stopPropagation();
  const a = b.dataset.act;
  if (a === 'startPause') { startPause(); showControls(); }
  else if (a === 'reset') { resetTimer(); showControls(); }
  else if (a === 'menu') { hideControls(); openSheet('menu'); }
  else if (a === 'timer') { hideControls(); openSheet('timer'); }
});
document.querySelectorAll('#sheetMenu [data-open]').forEach(b => b.addEventListener('click', () => { closeSheets(); openSheet(b.dataset.open); }));
$('lockBtn').onclick = () => { closeSheets(); setLock(true); toast('ロックしました（長押し 2 秒で解除）', 2200); };
document.addEventListener('keydown', (e) => {
  if (locked || anySheetOpen() || e.target.matches('input,select,textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); startPause(); }
});

/* 時刻合わせの点 */
function showSyncPop(keep) {
  const p = $('syncPop');
  p.innerHTML = '';
  const t = document.createElement('div'); t.style.whiteSpace = 'pre-line'; t.textContent = sync.running ? '時刻を合わせています…' : syncText();
  const b = document.createElement('button'); b.textContent = '今すぐ合わせる';
  b.style.cssText = 'min-height:44px;padding:0 14px;font-size:16px;color:#f2f2f2;background:#2a2a2a;border:1px solid #444;border-radius:10px';
  b.onclick = (e) => { e.stopPropagation(); doSync().then(() => showSyncPop(true)); showSyncPop(true); };
  p.append(t, b);
  p.classList.remove('hidden');
  if (!keep) { clearTimeout(showSyncPop._t); showSyncPop._t = setTimeout(() => p.classList.add('hidden'), 8000); }
}
$('syncDot').addEventListener('click', (e) => {
  e.stopPropagation();
  if (locked) return;
  hideControls();
  showSyncPop(false);
  doSync();
});
$('syncPop').addEventListener('click', (e) => e.stopPropagation());

/* ---------- シート ---------- */
function openSheet(name) {
  const id = { menu: 'sheetMenu', timer: 'sheetTimer', schedule: 'sheetSchedule', settings: 'sheetSettings' }[name];
  if (name === 'timer') renderTimerSheet();
  if (name === 'schedule') renderSchedule();
  if (name === 'settings') renderSettings();
  $(id).classList.remove('hidden');
}
function closeSheets() {
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  for (const l of S.lists) sortList(l);
  save();
  document.querySelectorAll('.sheet').forEach(s => s.classList.add('hidden'));
}
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeSheets));
document.querySelectorAll('.sheet').forEach(s => s.addEventListener('click', (e) => { if (e.target === s) closeSheets(); }));
// 入力欄以外の場所に触れたらキーボードを閉じる
document.querySelectorAll('.sheetIn').forEach(s => s.addEventListener('pointerdown', (e) => {
  const a = document.activeElement;
  if (a && a.matches('input, select, textarea') && !e.target.closest('input, select, textarea, label')) a.blur();
}));

/* タイマーのシート */
let sheetMode = 'down';
function renderTimerSheet() {
  sheetMode = S.timer.mode;
  showModePane();
  const box = $('presetBtns'); box.innerHTML = '';
  for (const m of S.settings.presets) {
    const b = document.createElement('button'); b.textContent = m + ' 分';
    b.onclick = () => setDown(m * 60000);
    box.append(b);
  }
  $('downInput').value = ''; $('downPreview').textContent = ''; $('downPreview').className = 'preview';
  $('targetInput').value = S.timer.targetHM ? S.timer.targetHM.replace(':', '') : '';
  previewTarget();
}
function showModePane() {
  document.querySelectorAll('#modeTabs button').forEach(b => b.classList.toggle('on', b.dataset.mode === sheetMode));
  document.querySelectorAll('#sheetTimer .pane').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== sheetMode));
}
$('modeTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { sheetMode = b.dataset.mode; showModePane(); } });
function setDown(ms) {
  Object.assign(S.timer, { mode: 'down', duration: ms, elapsedBefore: 0, runStart: null });
  save(); closeSheets(); tick(true); toast('カウントダウン ' + fmtDur(ms) + '（開始は画面をタップ → 右端の「開始」）', 2000);
}
$('downInput').addEventListener('input', () => {
  const v = $('downInput').value, p = $('downPreview');
  if (!v) { p.textContent = ''; return; }
  const ms = parseDuration(v);
  if (ms == null) { p.textContent = '分と秒は 59 までです'; p.className = 'preview bad'; }
  else { p.textContent = fmtDur(ms); p.className = 'preview'; }
});
$('downInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('downSet').click(); });
$('downSet').onclick = () => {
  const ms = parseDuration($('downInput').value);
  if (ms == null || ms === 0) { $('downPreview').textContent = '時間を入れてください'; $('downPreview').className = 'preview bad'; return; }
  setDown(ms);
};
$('upSet').onclick = () => {
  Object.assign(S.timer, { mode: 'up', elapsedBefore: 0, runStart: null });
  save(); closeSheets(); tick(true); toast('カウントアップ（開始は画面をタップ → 右端の「開始」）', 2000);
};
function previewTarget() {
  const v = $('targetInput').value, p = $('targetPreview');
  if (!v) { p.textContent = ''; return null; }
  const hmv = parseHM(v);
  if (!hmv) { p.textContent = '時刻として読めません'; p.className = 'preview bad'; return null; }
  p.textContent = hmv; p.className = 'preview'; return hmv;
}
$('targetInput').addEventListener('input', previewTarget);
$('targetInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('targetSet').click(); });
$('targetSet').onclick = () => {
  const hmv = previewTarget();
  if (!hmv) { $('targetPreview').textContent = '時刻を入れてください'; $('targetPreview').className = 'preview bad'; return; }
  Object.assign(S.timer, { mode: 'target', targetHM: hmv, targetNext: false, runStart: null });
  save(); closeSheets(); tick(true); toast(hmv + ' までカウントダウン', 1800);
};
$('targetNext').onclick = () => {
  Object.assign(S.timer, { mode: 'target', targetNext: true, runStart: null });
  save(); closeSheets(); tick(true); toast('次の予定までカウントダウン', 1800);
};

/* 予定のシート */
function renderSchedule() {
  const sel = $('listSelect'); sel.innerHTML = '';
  for (const l of S.lists) { const o = document.createElement('option'); o.value = l.id; o.textContent = l.name; sel.append(o); }
  sel.value = S.activeId;
  const box = $('items'); box.innerHTML = '';
  const list = activeList();
  const t = now();
  list.items.forEach((it, idx) => {
    const row = document.createElement('div'); row.className = 'item';
    if (it.t && todayAt(it.t, t) <= t) row.classList.add('past');
    const ti = document.createElement('input'); ti.className = 't'; ti.value = it.t || ''; ti.placeholder = '13:30'; ti.inputMode = 'numeric';
    const li = document.createElement('input'); li.className = 'l'; li.value = it.l || ''; li.placeholder = '配信開始';
    const del = document.createElement('button'); del.textContent = '消す';
    ti.enterKeyHint = 'next'; li.enterKeyHint = 'done';
    ti.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); li.focus(); } });
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); li.blur(); } });
    ti.onchange = () => {
      const v = parseHM(ti.value);
      if (ti.value && !v) { toast('時刻として読めません'); ti.value = it.t || ''; return; }
      it.t = v || ''; ti.value = it.t; save(); tick(true); // 並べ替えは画面を閉じたときに行う（入力中に行が動かないように）
    };
    li.onchange = () => { it.l = li.value.trim(); save(); tick(true); };
    del.onclick = () => { list.items.splice(idx, 1); save(); renderSchedule(); tick(true); };
    row.append(ti, li, del); box.append(row);
  });
  if (!list.items.length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'まだ予定がありません。「行を足す」か、テキストファイルを読み込んでください。'; box.append(p); }
}
function sortList(list) { list.items.sort((a, b) => (a.t || '99') < (b.t || '99') ? -1 : (a.t || '99') > (b.t || '99') ? 1 : 0); }
$('listSelect').onchange = () => { S.activeId = $('listSelect').value; save(); renderSchedule(); tick(true); };
$('listNew').onclick = () => {
  const name = prompt('予定表の名前', '新しい予定');
  if (name == null) return;
  const l = { id: uid(), name: name.trim() || '新しい予定', items: [] };
  S.lists.push(l); S.activeId = l.id; save(); renderSchedule(); tick(true);
};
$('listRename').onclick = () => {
  const l = activeList(); const name = prompt('予定表の名前', l.name);
  if (name == null || !name.trim()) return;
  l.name = name.trim(); save(); renderSchedule();
};
$('listDelete').onclick = () => {
  const l = activeList();
  if (!confirm(`「${l.name}」を消します。元に戻せません。よいですか？`)) return;
  S.lists = S.lists.filter(x => x.id !== l.id);
  if (!S.lists.length) S.lists.push({ id: uid(), name: '予定', items: [] });
  S.activeId = S.lists[0].id; save(); renderSchedule(); tick(true);
};
$('itemAdd').onclick = () => {
  const l = activeList(); l.items.push({ t: '', l: '' }); save(); renderSchedule();
  const ins = $('items').querySelectorAll('input.t'); if (ins.length) ins[ins.length - 1].focus();
};

function decode(buf) {
  let u = new Uint8Array(buf);
  if (u[0] === 0xEF && u[1] === 0xBB && u[2] === 0xBF) u = u.subarray(3);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u); }
  catch (e) { return new TextDecoder('shift_jis').decode(u); }
}
function parseScheduleText(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let name = null; const items = []; let skipped = 0;
  for (let raw of lines) {
    const line = z2h(raw).trim();
    if (!line) continue;
    if (line.startsWith('#')) { if (name == null && !items.length) name = line.replace(/^#+\s*/, '').trim() || null; continue; }
    const cells = line.replace(/"/g, '');
    const m = /^(\d{1,2}\s*[:時]\s*\d{1,2}\s*分?|\d{1,2}\s*時|\d{3,4})(?=$|[\s,\t、])[\s,\t、]*(.*)$/.exec(cells);
    const t = m && parseHM(m[1].replace(/\s/g, ''));
    if (!t) { skipped++; continue; }
    items.push({ t, l: m[2].replace(/^[,\t、\s]+|[,\t、\s]+$/g, '').replace(/\s*[,\t]\s*/g, ' ') });
  }
  return { name, items, skipped };
}
$('fileIn').onchange = async () => {
  const f = $('fileIn').files[0]; $('fileIn').value = '';
  if (!f) return;
  const r = parseScheduleText(decode(await f.arrayBuffer()));
  if (!r.items.length) { toast('予定が 1 行も読めませんでした', 2500); return; }
  const l = { id: uid(), name: r.name || f.name.replace(/\.[^.]+$/, ''), items: r.items };
  sortList(l); S.lists.push(l); S.activeId = l.id; save(); renderSchedule(); tick(true);
  toast(`${r.items.length} 件を読み込みました` + (r.skipped ? `（読めなかった行 ${r.skipped}）` : ''), 2500);
};
$('exportBtn').onclick = async () => {
  const l = activeList();
  const text = '# ' + l.name + '\n' + sortedItems(l).map(i => i.t + ' ' + (i.l || '')).join('\n') + '\n';
  const fname = l.name.replace(/[\\/:*?"<>|]/g, '_') + '.txt';
  const file = new File([text], fname, { type: 'text/plain' });
  if (navigator.canShare && navigator.canShare({ files: [file] }) && /iPad|iPhone|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = fname;
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
};

/* 設定のシート */
const COLOR_PRESETS = [
  { name: '黒地に白', bg: '#000000', fg: '#ffffff' },
  { name: '黒地にグレー', bg: '#000000', fg: '#9a9a9a' },
  { name: '白地に黒', bg: '#ffffff', fg: '#000000' },
  { name: '紺地に白', bg: '#0b1a3a', fg: '#ffffff' },
];
function renderSettings() {
  const st = S.settings;
  document.querySelectorAll('#sheetSettings .seg3[data-set]').forEach(g => {
    g.querySelectorAll('button').forEach(b => b.classList.toggle('on', st[g.dataset.set] === b.dataset.v));
  });
  document.querySelectorAll('#sheetSettings input[data-set]').forEach(i => {
    const k = i.dataset.set;
    if (i.type === 'checkbox') i.checked = !!st[k];
    else if (k === 'presets') i.value = st.presets.join(', ');
    else i.value = st[k];
  });
  const box = $('colorPresets'); box.innerHTML = '';
  for (const c of COLOR_PRESETS) {
    const b = document.createElement('button'); b.className = 'swatch';
    b.innerHTML = `<i style="background:${c.bg};color:${c.fg}">12</i>`;
    b.append(c.name);
    b.onclick = () => { st.bg = c.bg; st.fg = c.fg; save(); applyLook(); renderSettings(); };
    box.append(b);
  }
  $('syncInfo').textContent = syncText();
  $('wakeInfo').textContent = wakeText();
  const canFull = !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
  const standalone = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || navigator.standalone;
  $('fullBtn').classList.toggle('hidden', !canFull || standalone);
  renderUpdateInfo();
}
document.querySelectorAll('#sheetSettings .seg3[data-set]').forEach(g => g.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  S.settings[g.dataset.set] = b.dataset.v; save(); applyLook(); renderSettings();
}));
document.querySelectorAll('#sheetSettings input[data-set]').forEach(i => i.addEventListener(i.type === 'color' ? 'input' : 'change', () => {
  const k = i.dataset.set, st = S.settings;
  if (i.type === 'checkbox') st[k] = i.checked;
  else if (k === 'warnMin') { const n = Math.round(+i.value); st.warnMin = n >= 1 && n <= 99 ? n : st.warnMin; i.value = st.warnMin; }
  else if (k === 'presets') {
    const arr = z2h(i.value).split(/[^\d]+/).map(Number).filter(n => n > 0 && n <= 999);
    if (arr.length) st.presets = arr.slice(0, 12);
    i.value = st.presets.join(', ');
  }
  else st[k] = i.value;
  save(); applyLook(); tick(true);
}));
$('syncNow').onclick = () => { $('syncInfo').textContent = '時刻を合わせています…'; doSync(); };
$('fullBtn').onclick = () => {
  const el = document.documentElement;
  (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
  closeSheets();
};

/* ---------- 画面を消さない ---------- */
let wakeLock = null, wakeState = 'まだ';
async function wake() {
  if (!('wakeLock' in navigator)) { wakeState = 'なし'; return; }
  if (wakeLock && !wakeLock.released) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeState = 'ok';
    wakeLock.addEventListener('release', () => { if (document.visibilityState === 'visible') setTimeout(wake, 1000); });
  } catch (e) { wakeState = 'ng'; }
}
function wakeText() {
  const ios = /iPad|iPhone/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (wakeState === 'ok' && !ios) return '画面が暗くならないようにしています。';
  if (wakeState === 'ok') return '画面が暗くならないようにしています。iPad では効かないことがあるので、念のため iPad の「設定」→「画面表示と明るさ」→「自動ロック」を「なし」にしてください。';
  return '画面を消さない機能が使えませんでした。端末の設定で画面の自動消灯（iPad は「自動ロック」）を「なし」にしてください。';
}
document.addEventListener('pointerdown', () => { if (wakeState !== 'ok') wake(); }, { passive: true });

/* ---------- オフライン対応 ---------- */
// 新しい版は、届いたあと「開いた直後」か「設定のボタン」で切り替える。本番中に勝手に画面を読み込み直さない
let swReg = null, updateReady = false, shownAt = Date.now();
function checkUpdate() { if (swReg && navigator.onLine) swReg.update().catch(() => {}); }
function applyUpdate() { location.reload(); }
function maybeAutoUpdate() {
  if (updateReady && !locked && !anySheetOpen() && S.timer.runStart == null && Date.now() - shownAt < 20000) applyUpdate();
}
function renderUpdateInfo() {
  $('verInfo').textContent = 'オペ時計 ' + VERSION + (updateReady ? '（新しい版が届いています）' : '');
  $('updBtn').textContent = updateReady ? '新しい版に切り替える' : '新しい版があるか確かめる';
}
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => { swReg = r; checkUpdate(); }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // 初めて入れたときは切り替え不要
    updateReady = true; renderUpdateInfo(); maybeAutoUpdate();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    shownAt = Date.now();
    if (updateReady) maybeAutoUpdate(); else checkUpdate();
  });
  window.addEventListener('online', checkUpdate);
  setInterval(checkUpdate, 3600000);
}
$('updBtn').onclick = () => {
  if (updateReady) { applyUpdate(); return; }
  if (!swReg || !navigator.onLine) { toast('ネットにつながっていません', 2000); return; }
  $('verInfo').textContent = '確かめています…';
  swReg.update().then(() => setTimeout(() => {
    renderUpdateInfo();
    if (!updateReady && !(swReg.installing || swReg.waiting)) toast('いまの版が最新です', 2000);
  }, 3000)).catch(() => { renderUpdateInfo(); toast('確かめられませんでした', 2000); });
};

/* ---------- 起動 ---------- */
orient();
applyLook();
renderSync();
tick(true);
doSync();
wake();
