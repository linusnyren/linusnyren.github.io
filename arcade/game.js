import mqtt from './vendor/mqtt.esm.js';
import { COLS, ROWS, OPP, newGame, steer, tick, tickMs, sanitize, electHost, addToFame, autopilot } from './engine.js';

// ---------- config ----------
const BROKER = 'wss://broker.hivemq.com:8884/mqtt';
const P = 'linusnyren/dachshund-snake/v1';
const T = { presence: `${P}/presence`, bye: `${P}/bye`, state: `${P}/state`, input: `${P}/input`, emote: `${P}/emote`, fame: `${P}/fame` };
const HEARTBEAT_MS = 2000, SETTLE_MS = 2500, RESTART_MS = 3500;
const EMOTES = ['🐶', '🦴', '🔥', '💀', '😂'];
const CELL = 40;

// ---------- identity ----------
const ADJ = ['Turbo', 'Sir', 'Captain', 'Neon', 'Lil', 'Mega', 'Sneaky', 'Hyper', 'Cosmic', 'Wiggly', 'Pixel', 'Retro'];
const NOUN = ['Wiener', 'Sausage', 'Bork', 'Doggo', 'Pupper', 'Snoot', 'Bean', 'Noodle', 'Zoomie', 'Beans', 'Woofer'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
const me = {
  id: Math.random().toString(36).slice(2, 10),
  name: cleanName(localStorage.getItem('dsnake-name')) || `${pick(ADJ)}${pick(NOUN)}${Math.floor(Math.random() * 90 + 10)}`,
  joined: Date.now(),
};
localStorage.setItem('dsnake-name', me.name);

// ---------- dom ----------
const $ = (id) => document.getElementById(id);
const canvas = $('c'), ctx = canvas.getContext('2d');
const ui = { game: $('game'), score: $('score'), hi: $('hi'), speed: $('speed'), online: $('online'), players: $('players'), fame: $('fame'), feed: $('feed'), banner: $('banner'), status: $('status'), stage: $('stage'), emotes: $('emotes') };
const li = (text, cls) => { const el = document.createElement('li'); if (cls) el.className = cls; if (Array.isArray(text)) text.forEach((t) => { const s = document.createElement('span'); s.textContent = t; el.append(s); }); else el.textContent = text; return el; };

// ---------- shared state ----------
const peers = new Map();
let client, connected = false, settled = false, hostId = null, amHost = false;
let state = null, view = null, fame = [], hiLocal = 0;
let hostTimer = null, restartTimer = null;
let golden = localStorage.getItem('dsnake-golden') === '1';
const lastInput = new Map();

// ---------- network ----------
function publish(topic, obj, opts = {}) {
  if (connected) client.publish(topic, JSON.stringify(obj), { qos: 0, ...opts });
}

function heartbeat() {
  const p = { id: me.id, name: me.name, joined: me.joined, active: !document.hidden, golden };
  peers.set(me.id, { ...p, seen: Date.now() });
  publish(`${T.presence}/${me.id}`, p);
}

function connect() {
  client = mqtt.connect(BROKER, {
    clientId: `dsnake_${me.id}`, clean: true, keepalive: 20, reconnectPeriod: 2000, connectTimeout: 8000,
    will: { topic: `${T.bye}/${me.id}`, payload: me.id, qos: 0, retain: false },
  });
  client.on('connect', () => {
    connected = true;
    setStatus('● connected to the grid', 'ok');
    client.subscribe([`${T.presence}/+`, `${T.bye}/+`, T.state, T.input, T.emote, T.fame]);
    heartbeat();
    setTimeout(() => { settled = true; elect(); }, SETTLE_MS);
  });
  client.on('reconnect', () => setStatus('● reconnecting…', 'bad'));
  client.on('offline', () => { connected = false; setStatus('● offline', 'bad'); });
  client.on('error', (e) => setStatus(`● ${e.message}`, 'bad'));
  client.on('message', onMessage);
}

function onMessage(topic, buf) {
  let msg;
  try { msg = JSON.parse(buf.toString()); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  const now = Date.now();

  if (topic.startsWith(`${T.presence}/`)) {
    if (typeof msg.id !== 'string' || msg.id.length > 12 || !Number.isFinite(msg.joined)) return;
    peers.set(msg.id, { id: msg.id, name: cleanName(msg.name) || '???', joined: msg.joined, active: !!msg.active, golden: !!msg.golden, seen: now });
    return;
  }
  if (topic.startsWith(`${T.bye}/`)) { peers.delete(topic.split('/').pop()); elect(); return; }

  if (topic === T.state) {
    if (amHost && msg.from !== me.id) {
      // Someone else is hosting too. Defer to them if the election agrees.
      if (electHost(peers, now) !== me.id) stepDown();
      else return;
    }
    if (amHost) return;
    if (hostId && msg.from && msg.from !== hostId && peers.has(hostId)) return;
    const s = sanitize(msg);
    if (!s) return;
    receive(s, msg.ev, cleanName(msg.evBy));
    return;
  }

  if (topic === T.input) {
    const name = cleanName(msg.name) || '???';
    if (!OPP[msg.dir] || typeof msg.id !== 'string') return;
    // crude per-player flood limit
    const t = lastInput.get(msg.id) || 0;
    if (now - t < 60) return;
    lastInput.set(msg.id, now);
    feed(`${ARROWS[msg.dir]} ${name}`, msg.id === me.id);
    if (amHost && msg.id !== me.id) steer(state, msg.dir, name);
    return;
  }

  if (topic === T.emote) {
    if (!EMOTES.includes(msg.e)) return;
    floatEmote(msg.e, cleanName(msg.name));
    return;
  }

  if (topic === T.fame && Array.isArray(msg.list)) {
    fame = msg.list.slice(0, 10).map((e) => ({ score: Number.isInteger(e?.score) ? e.score : 0, crew: Array.isArray(e?.crew) ? e.crew.map(cleanName).filter(Boolean).slice(0, 6) : [], at: Number(e?.at) || 0 })).filter((e) => e.score > 0);
    renderFame();
  }
}

// ---------- host election + host loop ----------
function elect() {
  const now = Date.now();
  for (const [id, p] of peers) if (id !== me.id && now - p.seen > 6000) peers.delete(id);
  if (!settled || !connected) return;
  hostId = electHost(peers, now);
  if (hostId === me.id && !amHost) becomeHost();
  else if (hostId !== me.id && amHost) stepDown();
  renderPlayers();
}

function becomeHost() {
  amHost = true;
  state = state ? sanitize(state) : null;
  if (!state || (state.status === 'over' && Date.now() - state.endedAt > RESTART_MS)) state = newGame(state);
  if (state.status === 'over') scheduleRestart();
  banner('👑 YOU ARE THE HOST — your browser runs the game', 4000);
  loop();
}

function stepDown() {
  amHost = false;
  clearTimeout(hostTimer); clearTimeout(restartTimer);
}

function loop() {
  clearTimeout(hostTimer);
  if (!amHost) return;
  let ev = null, evBy = null;
  if (state.status === 'playing') {
    if (state.auto && !state.queue.length) {
      const d = autopilot(state);
      if (d !== state.dir) state.queue.push({ dir: d, name: null });
    }
    evBy = state.queue[0]?.name ?? null;
    ev = tick(state);
    if (ev === 'die' || ev === 'win') onGameEnd();
  }
  const { queue, ...wire } = state;
  publish(T.state, { ...wire, from: me.id, ev, evBy }, { retain: true });
  receive(sanitize(state), ev, evBy);
  hostTimer = setTimeout(loop, state.status === 'playing' ? tickMs(state.score) : 1000);
}

function onGameEnd() {
  state.endedAt = Date.now();
  if (state.score > 0 && !state.auto) {
    fame = addToFame(fame, { score: state.score, crew: state.crew.slice(0, 6), at: Date.now() });
    publish(T.fame, { list: fame }, { retain: true });
    renderFame();
  }
  scheduleRestart();
}

function scheduleRestart() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => { if (amHost) { state = newGame(state); banner(`GAME #${state.game} — GO GO GO`, 1500); } }, RESTART_MS);
}

// ---------- local input ----------
const ARROWS = { up: '⬆️', down: '⬇️', left: '⬅️', right: '➡️' };
function sendDir(dir) {
  audio.unlock();
  publish(T.input, { id: me.id, name: me.name, dir });
  if (amHost) steer(state, dir, me.name);
  const b = document.querySelector(`.pad button[data-dir=${dir}]`);
  b?.classList.add('hit'); setTimeout(() => b?.classList.remove('hit'), 90);
}
let lastEmote = 0;
function sendEmote(e) {
  if (Date.now() - lastEmote < 350) return;
  lastEmote = Date.now();
  publish(T.emote, { e, name: me.name });
}

const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
let kIdx = 0;
const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right' };
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  kIdx = k === KONAMI[kIdx] ? kIdx + 1 : (k === KONAMI[0] ? 1 : 0);
  if (kIdx === KONAMI.length) {
    kIdx = 0; golden = !golden; localStorage.setItem('dsnake-golden', golden ? '1' : '0');
    banner(golden ? '🌟 KONAMI! GOLDEN DOGGO UNLOCKED 🌟' : 'golden doggo off', 3000); audio.win(); heartbeat();
  }
  if (KEYS[k]) { e.preventDefault(); sendDir(KEYS[k]); }
  const n = Number(e.key);
  if (n >= 1 && n <= EMOTES.length) sendEmote(EMOTES[n - 1]);
});
document.querySelectorAll('[data-dir]').forEach((b) => b.addEventListener('pointerdown', (e) => { e.preventDefault(); sendDir(b.dataset.dir); }));
document.querySelectorAll('[data-emote]').forEach((b) => b.addEventListener('click', () => sendEmote(b.dataset.emote)));
let touch = null;
canvas.addEventListener('pointerdown', (e) => { touch = [e.clientX, e.clientY]; canvas.focus(); });
canvas.addEventListener('pointerup', (e) => {
  if (!touch) return;
  const dx = e.clientX - touch[0], dy = e.clientY - touch[1];
  touch = null;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
  sendDir(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
});
$('nameBtn').addEventListener('click', () => {
  const n = cleanName(prompt('Pick a player name (max 16 chars):', me.name));
  if (n) { me.name = n; localStorage.setItem('dsnake-name', n); heartbeat(); renderPlayers(); }
});
$('soundBtn').addEventListener('click', (e) => { audio.on = !audio.on; audio.unlock(); e.currentTarget.textContent = audio.on ? '🔊 SOUND' : '🔇 SOUND'; });
document.addEventListener('visibilitychange', () => { heartbeat(); elect(); });

// ---------- audio ----------
const audio = {
  on: false, ac: null,
  unlock() { if (!this.ac) try { this.ac = new AudioContext(); } catch {} },
  beep(freqs, dur = 0.08, type = 'square', vol = 0.06) {
    if (!this.on || !this.ac) return;
    const t0 = this.ac.currentTime;
    freqs.forEach((f, i) => {
      const o = this.ac.createOscillator(), g = this.ac.createGain();
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(vol, t0 + i * dur); g.gain.exponentialRampToValueAtTime(0.0001, t0 + (i + 1) * dur);
      o.connect(g).connect(this.ac.destination); o.start(t0 + i * dur); o.stop(t0 + (i + 1) * dur);
    });
  },
  eat() { this.beep([660, 990, 1320], 0.06); },
  die() { this.beep([440, 330, 220, 110], 0.14, 'sawtooth', 0.08); },
  win() { this.beep([523, 659, 784, 1046, 1318], 0.08); },
};

// ---------- view model (interpolation, particles, fx) ----------
const particles = [];
let shakeT = 0, flashT = 0, lastBy = null;
function receive(s, ev, evBy) {
  if (!s) return;
  const now = performance.now();
  const sameGame = view && view.cur.game === s.game;
  if (sameGame && s.seq <= view.cur.seq && s.status === view.cur.status) return;
  const prev = sameGame && s.seq === view.cur.seq + 1 ? view.cur.snake : s.snake;
  view = { prev, cur: s, at: now, dur: tickMs(s.score) };
  state = amHost ? state : s;
  if (!sameGame && s.status === 'playing' && view) banner(`GAME #${s.game} — INSERT COIN 🪙`, 1600);
  if (ev === 'eat') {
    audio.eat();
    const [x, y] = s.snake[0];
    for (let i = 0; i < 26; i++) particles.push({ x: x * CELL + CELL / 2, y: y * CELL + CELL / 2, vx: (Math.random() - 0.5) * 9, vy: (Math.random() - 0.5) * 9 - 2, life: 1, c: pick(['#ffe259', '#fff8e7', '#ff2bd6', '#00f0ff']) });
    particles.push({ x: x * CELL + CELL / 2, y: y * CELL, vx: 0, vy: -1.2, life: 1.6, text: evBy ? `+1 ${evBy}` : '+1' });
  }
  if (ev === 'die' || ev === 'win') {
    ev === 'die' ? audio.die() : audio.win();
    shakeT = 1; flashT = 1;
    ui.stage.classList.remove('shake'); void ui.stage.offsetWidth; ui.stage.classList.add('shake');
    lastBy = s.death?.by;
  }
  hiLocal = Math.max(hiLocal, s.score, fame[0]?.score || 0);
  ui.game.textContent = `#${s.game}`;
  ui.score.textContent = String(s.score).padStart(3, '0');
  ui.hi.textContent = String(hiLocal).padStart(3, '0');
  ui.speed.textContent = `${(210 / tickMs(s.score)).toFixed(1)}x`;
}

// ---------- rendering ----------
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => t * t * (3 - 2 * t);

function drawBoard(t) {
  ctx.fillStyle = '#0b0418';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    if ((x + y) % 2) { ctx.fillStyle = 'rgba(255,255,255,0.025)'; ctx.fillRect(x * CELL, y * CELL, CELL, CELL); }
  }
  ctx.strokeStyle = 'rgba(255,43,214,0.13)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= COLS; x++) { ctx.moveTo(x * CELL + 0.5, 0); ctx.lineTo(x * CELL + 0.5, ROWS * CELL); }
  for (let y = 0; y <= ROWS; y++) { ctx.moveTo(0, y * CELL + 0.5); ctx.lineTo(COLS * CELL, y * CELL + 0.5); }
  ctx.stroke();
  // sweeping radar line for extra drama
  const sx = ((t / 4000) % 1) * canvas.width;
  const g = ctx.createLinearGradient(sx - 120, 0, sx, 0);
  g.addColorStop(0, 'rgba(0,240,255,0)'); g.addColorStop(1, 'rgba(0,240,255,0.08)');
  ctx.fillStyle = g; ctx.fillRect(sx - 120, 0, 120, canvas.height);
}

function drawBone([x, y], t) {
  const cx = x * CELL + CELL / 2, cy = y * CELL + CELL / 2 + Math.sin(t / 220) * 3;
  const pulse = (t / 1400) % 1;
  ctx.beginPath(); ctx.arc(cx, cy, 10 + pulse * 18, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(255,226,89,${0.6 * (1 - pulse)})`; ctx.lineWidth = 3; ctx.stroke();
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(-0.5 + Math.sin(t / 400) * 0.15);
  ctx.shadowColor = '#ffe259'; ctx.shadowBlur = 18; ctx.fillStyle = '#fff8e7';
  ctx.fillRect(-10, -4, 20, 8);
  for (const [bx, by] of [[-11, -4.5], [-11, 4.5], [11, -4.5], [11, 4.5]]) { ctx.beginPath(); ctx.arc(bx, by, 5.2, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}

function dogPoints(t) {
  const k = Math.min(1, (t - view.at) / view.dur);
  const e = view.cur.status === 'playing' ? ease(k) : 1;
  const { prev, cur } = view;
  return cur.snake.map((p, i) => {
    const q = prev[i] ?? prev[prev.length - 1] ?? p;
    return [lerp(q[0], p[0], e) * CELL + CELL / 2, lerp(q[1], p[1], e) * CELL + CELL / 2];
  });
}

function drawDog(pts, t, dead) {
  const body = golden ? (() => { const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height); ['#ff2a6d', '#ffe259', '#5dff9e', '#00f0ff', '#ff2bd6'].forEach((c, i) => g.addColorStop(i / 4, c)); return g; })() : '#b5651d';
  // tail
  const n = pts.length, [tx, ty] = pts[n - 1], [px, py] = pts[n - 2];
  const ta = Math.atan2(ty - py, tx - px), wag = Math.sin(t / 70) * 0.6;
  ctx.save(); ctx.translate(tx, ty); ctx.rotate(ta + wag);
  ctx.strokeStyle = '#8a4a14'; ctx.lineWidth = 6; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(6, 0); ctx.quadraticCurveTo(20, -4, 26, -14); ctx.stroke(); ctx.restore();
  // paws: little trotting legs on front & back segments
  const legs = [1, n - 2].filter((i, j, a) => i > 0 && a.indexOf(i) === j);
  legs.forEach((i, j) => {
    const [x, y] = pts[i], [nx, ny] = pts[i - 1];
    const a = Math.atan2(ny - y, nx - x), step = dead ? 0 : Math.sin(t / 60 + j * Math.PI) * 5;
    for (const side of [1, -1]) {
      ctx.fillStyle = '#5c2e0e';
      ctx.beginPath();
      ctx.ellipse(x - Math.sin(a) * 17 * side + Math.cos(a) * step * side, y + Math.cos(a) * 17 * side + Math.sin(a) * step * side, 6, 5, a, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  // body
  const path = () => { ctx.beginPath(); ctx.moveTo(...pts[0]); for (let i = 1; i < n; i++) ctx.lineTo(...pts[i]); };
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.shadowColor = golden ? '#ffe259' : 'rgba(0,0,0,0.7)'; ctx.shadowBlur = golden ? 24 : 10; ctx.shadowOffsetY = golden ? 0 : 4;
  path(); ctx.strokeStyle = '#5c2e0e'; ctx.lineWidth = 32; ctx.stroke();
  ctx.shadowColor = 'transparent';
  path(); ctx.strokeStyle = body; ctx.lineWidth = 27; ctx.stroke();
  ctx.save(); ctx.translate(-2, -4); path(); ctx.strokeStyle = 'rgba(255,200,140,0.35)'; ctx.lineWidth = 8; ctx.stroke(); ctx.restore();
  // collar
  const [hx, hy] = pts[0], [nx, ny] = pts[1];
  const ha = Math.atan2(hy - ny, hx - nx);
  ctx.save(); ctx.translate(lerp(hx, nx, 0.42), lerp(hy, ny, 0.42)); ctx.rotate(ha);
  ctx.fillStyle = '#00f0ff'; ctx.shadowColor = '#00f0ff'; ctx.shadowBlur = 12; ctx.fillRect(-3, -15, 6, 30);
  ctx.fillStyle = '#ffe259'; ctx.beginPath(); ctx.arc(2, 15, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  // head (drawn facing +x)
  ctx.save(); ctx.translate(hx, hy); ctx.rotate(ha);
  const flop = dead ? 0.6 : Math.sin(t / 110) * 0.35;
  ctx.fillStyle = '#5c2e0e';
  for (const s of [1, -1]) {
    ctx.save(); ctx.translate(-6, 10 * s); ctx.rotate((0.5 + flop) * s);
    ctx.beginPath(); ctx.ellipse(-6, 5 * s, 12, 7, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  ctx.fillStyle = golden ? '#ffd23f' : '#c97a2e'; ctx.beginPath(); ctx.ellipse(2, 0, 18, 15, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = golden ? '#ffe98a' : '#d98c3f'; ctx.beginPath(); ctx.ellipse(15, 1, 11, 8.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#111'; ctx.beginPath(); ctx.ellipse(25, 0, 4.5, 4, 0, 0, Math.PI * 2); ctx.fill();
  if (dead) {
    ctx.strokeStyle = '#000'; ctx.lineWidth = 2.5;
    for (const s of [1, -1]) { ctx.beginPath(); ctx.moveTo(3, 6 * s - 3); ctx.lineTo(9, 6 * s + 3); ctx.moveTo(9, 6 * s - 3); ctx.lineTo(3, 6 * s + 3); ctx.stroke(); }
  } else {
    for (const s of [1, -1]) {
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(6, 7 * s, 4.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(7.5, 7 * s, 2.6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(8.3, 7 * s - 1, 0.9, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.fillStyle = '#ff4f8b';
  const tongue = dead ? 12 : 7 + Math.sin(t / 90) * 3;
  ctx.beginPath(); ctx.ellipse(21, 8, 4, tongue / 2, 0.3, 0, Math.PI * 2); ctx.fill();
  if (golden) { ctx.font = '18px serif'; ctx.fillText('👑', -10, -14); }
  ctx.restore();
}

function drawParticles() {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx; p.y += p.vy; p.vy += p.text ? 0 : 0.25; p.life -= 0.025;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    ctx.globalAlpha = Math.min(1, p.life);
    if (p.text) {
      ctx.font = '900 22px Impact, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#ffe259';
      ctx.shadowColor = '#ff2bd6'; ctx.shadowBlur = 10; ctx.fillText(p.text, p.x, p.y); ctx.shadowBlur = 0;
    } else { ctx.fillStyle = p.c; ctx.fillRect(p.x - 3, p.y - 3, 6, 6); }
  }
  ctx.globalAlpha = 1;
}

function drawOverlay(t) {
  const s = view.cur;
  if (s.status !== 'over') return;
  ctx.fillStyle = 'rgba(5,1,15,0.72)'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = 'center';
  const sc = 1 + Math.sin(t / 200) * 0.04;
  ctx.save(); ctx.translate(canvas.width / 2, canvas.height / 2 - 30); ctx.scale(sc, sc);
  ctx.font = '900 96px Impact, "Arial Black", sans-serif';
  ctx.fillStyle = '#00f0ff'; ctx.fillText(s.death?.cause === 'win' ? 'YOU WIN' : 'GAME OVER', -4, 0);
  ctx.fillStyle = '#ff2bd6'; ctx.fillText(s.death?.cause === 'win' ? 'YOU WIN' : 'GAME OVER', 4, 0);
  ctx.fillStyle = '#fff'; ctx.shadowColor = '#ff2a6d'; ctx.shadowBlur = 30; ctx.fillText(s.death?.cause === 'win' ? 'YOU WIN' : 'GAME OVER', 0, 0);
  ctx.restore();
  ctx.font = '700 20px ui-monospace, Menlo, monospace'; ctx.fillStyle = '#e6f7ff'; ctx.shadowBlur = 0;
  const by = s.death?.by || lastBy;
  const why = s.death?.cause === 'wall' ? 'hit a wall' : s.death?.cause === 'self' ? 'bit its own tail' : 'ate EVERYTHING';
  ctx.fillText(`${by ? `${by} steered the doggo into` : 'the doggo'} ${by ? (s.death?.cause === 'wall' ? 'a wall' : 'its own tail') : why}`, canvas.width / 2, canvas.height / 2 + 30);
  ctx.fillStyle = '#ffe259'; ctx.fillText(`FINAL SCORE ${s.score} 🦴`, canvas.width / 2, canvas.height / 2 + 62);
  const left = Math.max(0, Math.ceil((RESTART_MS - (Date.now() - (s.endedAt || Date.now()))) / 1000));
  if (Math.floor(t / 500) % 2) { ctx.fillStyle = '#00f0ff'; ctx.fillText(`CONTINUE? ${left}…`, canvas.width / 2, canvas.height / 2 + 110); }
}

function drawAttract(t) {
  ctx.save();
  ctx.textAlign = 'center'; ctx.font = 'bold 22px "Press Start 2P", ui-monospace, monospace';
  ctx.fillStyle = 'rgba(0,240,255,0.85)'; ctx.shadowColor = '#00f0ff'; ctx.shadowBlur = 14;
  ctx.fillText('🤖 AUTOPILOT', canvas.width / 2, 44);
  if (Math.floor(t / 600) % 2) {
    ctx.font = 'bold 15px ui-monospace, monospace'; ctx.fillStyle = '#ffe259'; ctx.shadowColor = '#ff2bd6';
    ctx.fillText('PRESS ANY ARROW TO TAKE THE LEASH', canvas.width / 2, 72);
  }
  ctx.restore();
}

function drawWaiting(t) {
  drawBoard(t);
  ctx.textAlign = 'center'; ctx.fillStyle = '#00f0ff'; ctx.font = '700 24px ui-monospace, Menlo, monospace';
  ctx.fillText(connected ? 'SYNCING WITH OTHER PLAYERS' + '.'.repeat(Math.floor(t / 300) % 4) : 'CONNECTING TO THE GRID' + '.'.repeat(Math.floor(t / 300) % 4), canvas.width / 2, canvas.height / 2);
}

function frame(t) {
  if (!view) drawWaiting(t);
  else {
    ctx.save();
    if (shakeT > 0) { ctx.translate((Math.random() - 0.5) * 16 * shakeT, (Math.random() - 0.5) * 16 * shakeT); shakeT = Math.max(0, shakeT - 0.04); }
    drawBoard(t);
    if (view.cur.food) drawBone(view.cur.food, t);
    drawDog(dogPoints(t), t, view.cur.status === 'over');
    drawParticles();
    ctx.restore();
    if (flashT > 0) { ctx.fillStyle = `rgba(255,42,109,${flashT * 0.5})`; ctx.fillRect(0, 0, canvas.width, canvas.height); flashT = Math.max(0, flashT - 0.05); }
    if (view.cur.auto && view.cur.status === 'playing') drawAttract(t);
    drawOverlay(t);
  }
  requestAnimationFrame(frame);
}

// ---------- side panels ----------
function renderPlayers() {
  const list = [...peers.values()].sort((a, b) => a.joined - b.joined);
  ui.online.textContent = list.length;
  document.getElementById('humans').textContent = list.length === 1 ? 'HUMAN' : 'HUMANS';
  ui.players.replaceChildren(...list.map((p) => li([`${p.id === hostId ? '👑 ' : ''}${p.golden ? '🌟 ' : ''}${p.name}${p.id === me.id ? ' (you)' : ''}`, p.active ? '' : '💤'], p.id === me.id ? 'me' : '')));
}
function renderFame() {
  hiLocal = Math.max(hiLocal, fame[0]?.score || 0);
  ui.hi.textContent = String(hiLocal).padStart(3, '0');
  ui.fame.replaceChildren(...(fame.length ? fame.map((e, i) => li([`${['🥇', '🥈', '🥉'][i] || `${i + 1}.`} ${e.crew.join(', ') || '???'}`, `${e.score} 🦴`])) : [li('no legends yet', 'dim')]));
}
function feed(text, mine) {
  if (ui.feed.firstChild?.classList?.contains('dim')) ui.feed.replaceChildren();
  ui.feed.prepend(li(text, mine ? 'me' : ''));
  while (ui.feed.children.length > 8) ui.feed.lastChild.remove();
}
function floatEmote(e, name) {
  const el = document.createElement('div');
  el.className = 'emote'; el.style.left = `${5 + Math.random() * 85}%`;
  el.textContent = e;
  const s = document.createElement('small'); s.textContent = name; el.append(s);
  ui.emotes.append(el); setTimeout(() => el.remove(), 2700);
  if (ui.emotes.children.length > 40) ui.emotes.firstChild.remove();
}
let bannerTimer;
function banner(text, ms) {
  ui.banner.textContent = text; ui.banner.style.opacity = 1;
  clearTimeout(bannerTimer); if (ms) bannerTimer = setTimeout(() => (ui.banner.style.opacity = 0), ms);
}
function setStatus(text, cls) { ui.status.textContent = text; ui.status.className = `status ${cls}`; }

// ---------- go ----------
setInterval(heartbeat, HEARTBEAT_MS);
setInterval(elect, 700);
connect();
banner('CONNECTING TO THE GRID…');
setTimeout(() => connected && banner(`WELCOME, ${me.name.toUpperCase()} — STEER WITH ←↑↓→`, 3500), SETTLE_MS);
requestAnimationFrame(frame);
canvas.focus();

// test hook
window.__dsnake = { me, peers, get amHost() { return amHost; }, get hostId() { return hostId; }, get view() { return view; }, sendDir };
