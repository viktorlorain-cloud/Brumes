/* Moteur de règles de Brumes.
   Aucune dépendance à l'affichage : l'état est un objet JSON sérialisable,
   et chaque action renvoie la liste des événements à animer. */

export const RES = ['bois', 'pierre', 'lin', 'grain', 'cristal'];
export const RES_INFO = {
  bois:    { nom: 'Bois',    ic: '🪵', terrain: 'Sylve',     col: '#3d7a46' },
  pierre:  { nom: 'Pierre',  ic: '🪨', terrain: 'Carrière',  col: '#c0683c' },
  lin:     { nom: 'Lin',     ic: '🧵', terrain: 'Lande',     col: '#98b957' },
  grain:   { nom: 'Grain',   ic: '🌾', terrain: 'Terrasses', col: '#dfac45' },
  cristal: { nom: 'Cristal', ic: '💎', terrain: 'Pics',      col: '#7c879e' },
};
/* Île standard (2-4 joueurs) : 19 tuiles. Grande île (5-6 joueurs) : 31 tuiles, coins rognés. */
const TERRAIN_COUNTS = { bois: 4, pierre: 3, lin: 4, grain: 4, cristal: 3 };
const TERRAIN_COUNTS_BIG = { bois: 7, pierre: 5, lin: 7, grain: 6, cristal: 5 };
const NUMBERS = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];
const NUMBERS_BIG = [2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 8, 8, 8, 9, 9, 9, 9, 10, 10, 10, 11, 11, 11, 12, 12];
export const PIPS = n => 6 - Math.abs(7 - n);
const BASE_COSTS = { sentier: { bois: 1, pierre: 1 }, camp: { bois: 1, pierre: 1, lin: 1, grain: 1 }, bastion: { grain: 2, cristal: 3 } };
export const LIMITS = { sentier: 15, camp: 5, bastion: 4 };
export const PLAYER_DEFS = [
  { nom: 'Corail', col: '#ef5b4c' }, { nom: 'Lagon', col: '#22b3a4' },
  { nom: 'Ambre', col: '#f2a920' }, { nom: 'Indigo', col: '#8a6dff' },
  { nom: 'Azur', col: '#3f9cff' }, { nom: 'Rose', col: '#f262a6' },
];
export const MAX_PLAYERS = 6;
export const SIZE = 1;

/* Hasard : graine pour l'île (reproductible), Math.random pour le reste (tiré par l'hôte) */
export function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
let rand = Math.random;
const shuffle = arr => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
const pick = arr => arr[Math.floor(rand() * arr.length)];

/* ---------- Marées ---------- */
function buildTideDeck() {
  const d = [];
  for (const r of RES) d.push({ type: 'abondance', res: r }, { type: 'disette', res: r }, { type: 'haut', res: r }, { type: 'bas', res: r });
  d.push({ type: 'chantier-sentier', res: 'pierre' });
  return shuffle(d);
}
export function tideTitle(t) {
  if (!t) return '—';
  const n = t.res ? RES_INFO[t.res].nom : '';
  return ({ abondance: `Abondance · ${n}`, disette: `Disette · ${n}`, haut: `Cours haut · ${n}`, bas: `Cours bas · ${n}`,
    'chantier-sentier': 'Chantier · Sentiers', 'chantier-carnet': 'Chantier · Carnets', calme: 'Mer calme' })[t.type];
}
export function tideDesc(t) {
  if (!t) return '';
  const r = t.res ? RES_INFO[t.res] : null;
  return ({
    abondance: `Les tuiles ${r?.terrain} produisent le double de ${r?.nom}.`,
    disette: `Les tuiles ${r?.terrain} ne produisent rien. Les joueurs privés reçoivent un jeton de Fortune.`,
    haut: `La banque prend le ${r?.nom} à 1 contre 1.`,
    bas: `Tous les taux d'échange sur le ${r?.nom} augmentent de 1.`,
    'chantier-sentier': 'Un sentier ne coûte que 1 Bois.',
    'chantier-carnet': 'Les carnets coûtent 1 Cristal de moins (carnets pas encore disponibles).',
    calme: 'Aucun effet. Le Phare échange à 3 contre 1.',
  })[t.type] + (t.res && t.type !== 'chantier-carnet' ? ` Phare : ${r.nom} à 2 contre 1.` : '');
}
/* Les marées sont rares : 2 ou 3 par partie, à des tours tirés au sort (dès le tour 3,
   au moins 3 tours d'écart), chacune annoncée un tour à l'avance et sur des ressources différentes. */
function planTides() {
  const deck = buildTideDeck(), plan = [], used = new Set();
  const count = rand() < 0.5 ? 2 : 3;
  let round = 3 + Math.floor(rand() * 2);
  for (let i = 0; i < count; i++) {
    let c = deck.pop(); while (c && used.has(c.res)) c = deck.pop();
    if (!c) break;
    used.add(c.res); plan.push({ round, card: c });
    round += 3 + Math.floor(rand() * 3);
  }
  return plan;
}

/* ---------- Génération de l'île ---------- */
const NEIGH = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
function axialToXZ(q, r) { return { x: SIZE * Math.sqrt(3) * (q + r / 2), z: SIZE * 1.5 * r }; }

const isCorner = (q, r, R) => { const s = -q - r; return [Math.abs(q), Math.abs(r), Math.abs(s)].filter(v => v === R).length === 2 && [q, r, s].includes(0); };
export function generateIsland(seed, big = false) {
  const saved = rand; rand = mulberry32(seed);
  const R = big ? 3 : 2;
  const tiles = [];
  for (let q = -R; q <= R; q++) for (let r = -R; r <= R; r++) if (Math.abs(q + r) <= R && !(big && isCorner(q, r, R))) {
    const p = axialToXZ(q, r);
    tiles.push({ id: tiles.length, q, r, x: p.x, z: p.z, terrain: null, number: null, revealed: false, neighbors: [], vertices: [] });
  }
  const key = (q, r) => tiles.findIndex(t => t.q === q && t.r === r);
  for (const t of tiles) t.neighbors = NEIGH.map(([dq, dr]) => key(t.q + dq, t.r + dr)).filter(i => i >= 0);
  const center = tiles.find(t => t.q === 0 && t.r === 0);
  const land = tiles.filter(t => t !== center);

  const counts = big ? TERRAIN_COUNTS_BIG : TERRAIN_COUNTS;
  const bag = []; for (const r of RES) for (let i = 0; i < counts[r]; i++) bag.push(r);
  for (let a = 0; a < 20000; a++) {
    shuffle(bag); land.forEach((t, i) => t.terrain = bag[i]);
    if (land.every(t => t.neighbors.filter(n => tiles[n].terrain === t.terrain).length <= 1)) break;
  }
  center.terrain = 'phare';

  /* Numéros : règles strictes (pas de 6/8 voisins, pas de doublons voisins), puis on garde
     le tirage le mieux réparti : aucune intersection trop riche, les numéros rouges sur des
     ressources différentes, et des chances proches pour chaque ressource. */
  const nums = (big ? NUMBERS_BIG : NUMBERS).slice();
  const corners = []; // les 3 tuiles autour de chaque intersection intérieure
  for (const t of land) for (let i = 0; i < 6; i++) {
    const a = t.neighbors.find(n => tiles[n].q === t.q + NEIGH[i][0] && tiles[n].r === t.r + NEIGH[i][1]);
    const b = t.neighbors.find(n => tiles[n].q === t.q + NEIGH[(i + 1) % 6][0] && tiles[n].r === t.r + NEIGH[(i + 1) % 6][1]);
    if (a != null && b != null) corners.push([t, tiles[a], tiles[b]]);
  }
  const avg = nums.reduce((s, n) => s + PIPS(n), 0) / land.length;
  let best = null, bestScore = Infinity;
  for (let a = 0; a < 30000 && bestScore > 0; a++) {
    shuffle(nums); land.forEach((t, i) => t.number = nums[i]);
    const strict = land.every(t => t.neighbors.every(n => {
      const o = tiles[n]; if (o.number == null) return true;
      if (o.number === t.number) return false;
      return !((t.number === 6 || t.number === 8) && (o.number === 6 || o.number === 8));
    }));
    if (!strict) continue;
    let score = 0;
    for (const c of corners) { const pips = c.reduce((s, t) => s + (t.number ? PIPS(t.number) : 0), 0); if (pips > 12) score += pips - 12; }
    for (const r of RES) {
      const own = land.filter(t => t.terrain === r);
      const reds = own.filter(t => t.number === 6 || t.number === 8).length;
      if (reds > (big ? 2 : 1)) score += 3 * (reds - (big ? 2 : 1));
      const mean = own.reduce((s, t) => s + PIPS(t.number), 0) / own.length;
      score += Math.max(0, Math.abs(mean - avg) - 0.6) * 2;
    }
    if (score < bestScore) { bestScore = score; best = land.map(t => t.number); }
  }
  if (best) land.forEach((t, i) => t.number = best[i]);

  const vertices = [], edges = [], vKey = new Map(), eKey = new Map();
  for (const t of tiles) {
    const ids = [];
    for (let i = 0; i < 6; i++) {
      const ang = Math.PI / 180 * (60 * i - 30);
      const x = t.x + SIZE * Math.cos(ang), z = t.z + SIZE * Math.sin(ang);
      const k = `${Math.round(x * 100)},${Math.round(z * 100)}`;
      if (!vKey.has(k)) { vKey.set(k, vertices.length); vertices.push({ id: vertices.length, x, z, tiles: [], adj: [], edges: [], building: null, port: null }); }
      const v = vertices[vKey.get(k)]; v.tiles.push(t.id); ids.push(v.id);
    }
    t.vertices = ids;
    for (let i = 0; i < 6; i++) {
      const a = ids[i], b = ids[(i + 1) % 6];
      const k = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (!eKey.has(k)) { eKey.set(k, edges.length); edges.push({ id: edges.length, v: [a, b], tiles: [], road: null }); vertices[a].adj.push(b); vertices[b].adj.push(a); vertices[a].edges.push(edges.length - 1); vertices[b].edges.push(edges.length - 1); }
      edges[eKey.get(k)].tiles.push(t.id);
    }
  }

  const coast = edges.filter(e => e.tiles.length === 1).map(e => {
    const a = vertices[e.v[0]], b = vertices[e.v[1]];
    return { e, ang: Math.atan2((a.z + b.z) / 2, (a.x + b.x) / 2) };
  }).sort((p, q) => p.ang - q.ang);
  const portTypes = shuffle(big ? ['3:1', '3:1', '3:1', '3:1', '3:1', ...RES, 'lin'] : ['3:1', '3:1', '3:1', '3:1', ...RES]);
  const nPorts = portTypes.length;
  const offset = Math.floor(rand() * 3);
  const ports = [];
  for (let i = 0; i < nPorts; i++) {
    const e = coast[(Math.round(i * coast.length / nPorts) + offset) % coast.length].e;
    ports.push({ edge: e.id, type: portTypes[i] });
    for (const v of e.v) vertices[v].port = portTypes[i];
  }
  center.revealed = true; for (const n of center.neighbors) tiles[n].revealed = true;
  rand = saved;
  return { tiles, vertices, edges, ports, center: center.id, big };
}

/* ---------- Création d'une partie ---------- */
/* seats : [{ clientId, name }] dans l'ordre des places */
/* quickBuild : les joueurs peuvent construire pendant le tour des autres (parties en ligne à 5-6) */
export function createGame({ seats, win = 10, seed = Math.floor(Math.random() * 1e9), code = null, hostId = null, quickBuild = false, turnTime = 0 }) {
  const n = seats.length;
  const isl = generateIsland(seed, n > 4);
  const S = {
    v: 1, gameId: `${seed}-${Date.now().toString(36)}`, seq: 0, code, hostId, seed, win, quickBuild, turnTime, timerLeftMs: null, ...isl,
    players: seats.map((s, i) => ({ id: i, clientId: s.clientId || null, nom: s.name || PLAYER_DEFS[i].nom, col: PLAYER_DEFS[i].col,
      res: Object.fromEntries(RES.map(r => [r, 0])), fortune: 0, built: { sentier: 0, camp: 0, bastion: 0 } })),
    bank: Object.fromEntries(RES.map(r => [r, n > 4 ? 24 : 19])),
    current: 0, phase: 'setup', round: 0,
    setupOrder: [...Array(n).keys(), ...[...Array(n).keys()].reverse()],
    setupStep: 0, setupSub: 'camp', lastCamp: null,
    robber: isl.center, tidePlan: [], tide: null, nextTide: null, dice: null, winner: null, offer: null,
  };
  rand = Math.random;
  S.tidePlan = planTides();
  S.current = S.setupOrder[0];
  return S;
}

/* ---------- Lectures ---------- */
export const total = p => RES.reduce((s, r) => s + p.res[r], 0);
export const vp = p => p.built.camp + 2 * p.built.bastion;
export function costOf(S, kind) {
  if (kind === 'sentier' && S.tide?.type === 'chantier-sentier') return { bois: 1 };
  return BASE_COSTS[kind];
}
export const canPay = (p, cost) => Object.entries(cost).every(([r, n]) => p.res[r] >= n);

export function legalCamps(S, pid, setup = S.phase === 'setup') {
  return S.vertices.filter(v => !v.building && v.adj.every(a => !S.vertices[a].building) &&
    (setup || v.edges.some(e => S.edges[e].road === pid))).map(v => v.id);
}
export function legalRoads(S, pid, setup = S.phase === 'setup') {
  if (setup) return S.lastCamp == null ? [] : S.vertices[S.lastCamp].edges.filter(e => S.edges[e].road == null);
  return S.edges.filter(e => e.road == null && e.v.some(vid => {
    const v = S.vertices[vid];
    if (v.building && v.building.owner === pid) return true;
    if (v.building && v.building.owner !== pid) return false;
    return v.edges.some(e2 => e2 !== e.id && S.edges[e2].road === pid);
  })).map(e => e.id);
}
export const legalBastions = (S, pid) => S.vertices.filter(v => v.building && v.building.owner === pid && v.building.type === 'camp').map(v => v.id);
export const legalRobber = S => S.tiles.filter(t => t.revealed && t.id !== S.robber).map(t => t.id);

export function rateFor(S, pid, r) {
  const tide = S.tide;
  if (tide?.type === 'haut' && tide.res === r) return 1;
  let rate = 4;
  const owned = S.vertices.filter(v => v.building && v.building.owner === pid);
  if (owned.some(v => v.port === '3:1')) rate = 3;
  if (owned.some(v => v.port === r)) rate = 2;
  if (owned.some(v => v.tiles.includes(S.center))) {
    if (tide && tide.res && tide.type !== 'chantier-carnet' && tide.res === r) rate = Math.min(rate, 2);
    else if (!tide || tide.type === 'calme') rate = Math.min(rate, 3);
  }
  if (tide?.type === 'bas' && tide.res === r) rate += 1;
  return rate;
}

/* Construction hors tour : seulement pendant la phase principale du joueur actif */
export const canBuildOutOfTurn = () => false; // construction hors tour retirée
export function canBuild(S, pid, kind) {
  const p = S.players[pid];
  if (!p || S.phase !== 'main' || (S.current !== pid && !canBuildOutOfTurn(S, pid))) return false;
  if (!canPay(p, costOf(S, kind)) || p.built[kind] >= LIMITS[kind]) return false;
  if (kind === 'sentier') return legalRoads(S, pid).length > 0;
  if (kind === 'camp') return legalCamps(S, pid).length > 0;
  return legalBastions(S, pid).length > 0;
}

/* ---------- Mutations internes ---------- */
function pay(S, p, cost) { for (const [r, n] of Object.entries(cost)) { p.res[r] -= n; S.bank[r] += n; } }
function give(S, p, r, n) { const k = Math.min(n, S.bank[r]); p.res[r] += k; S.bank[r] -= k; return k; }
function reveal(S, ids) { const out = []; for (const id of ids) { const t = S.tiles[id]; if (!t.revealed) { t.revealed = true; out.push(id); } } return out; }
function startRound(S) {
  S.round++;
  S.tide = S.tidePlan.find(p => p.round === S.round)?.card || null;
  S.nextTide = S.tidePlan.find(p => p.round === S.round + 1)?.card || null;
}
export const tidesLeft = S => S.tidePlan.filter(p => p.round > S.round).length;
function produce(S, n) {
  const gains = [];
  const demand = Object.fromEntries(RES.map(r => [r, new Map()]));
  for (const t of S.tiles) {
    if (t.number !== n || t.id === S.robber || !RES.includes(t.terrain)) continue;
    if (S.tide?.type === 'disette' && S.tide.res === t.terrain) continue;
    const mult = (S.tide?.type === 'abondance' && S.tide.res === t.terrain) ? 2 : 1;
    for (const vid of t.vertices) {
      const b = S.vertices[vid].building; if (!b) continue;
      const k = (b.type === 'bastion' ? 2 : 1) * mult;
      const m = demand[t.terrain]; m.set(b.owner, (m.get(b.owner) || 0) + k);
      gains.push({ tile: t.id, vertex: vid, owner: b.owner, res: t.terrain, n: k });
    }
  }
  const received = new Set(), blocked = [];
  for (const r of RES) {
    const m = demand[r]; const need = [...m.values()].reduce((a, b) => a + b, 0);
    if (!need) continue;
    if (need > S.bank[r] && m.size > 1) { blocked.push(r); continue; }
    for (const [pid, k] of m) if (give(S, S.players[pid], r, k) > 0) received.add(pid);
  }
  const fortune = [];
  for (const p of S.players) if (!received.has(p.id)) { p.fortune++; fortune.push(p.id); }
  return { gains: gains.filter(g => !blocked.includes(g.res)), fortune, blocked };
}
/* On ne gagne que pendant son propre tour : un seuil atteint hors tour est validé au début de son tour */
function checkWin(S, p, ev) {
  if (p.id === S.current && vp(p) >= S.win) { S.phase = 'over'; S.winner = p.id; ev.push({ k: 'win', pid: p.id }); }
}

/* ---------- Échanges entre joueurs ---------- */
function cleanBundle(b) { const o = {}; for (const r of RES) { const n = Math.floor(Number(b?.[r]) || 0); if (n > 0) o[r] = Math.min(n, 19); } return o; }
export const bundleText = b => Object.entries(b).map(([r, n]) => `${n} ${RES_INFO[r].ic}`).join(' + ');
function respondOffer(S, pid, a, ev, fail) {
  const o = S.offer;
  if (!o || o.id !== a.id) return fail("Cette proposition n'existe plus.");
  if (pid === o.from) return fail('Vous ne pouvez pas répondre à votre propre proposition.');
  if (a.accept && !canPay(S.players[pid], o.want)) return fail("Vous n'avez pas les cartes demandées.");
  o.responses[pid] = a.accept ? 'accept' : 'decline';
  ev.push({ k: 'offer' });
  if (a.accept) ev.push({ k: 'toast', msg: `${S.players[pid].nom} accepte l'échange` });
  return { ok: true, events: ev };
}

/* Défausse sur un 7 : {t:'discard', cards:{bois:2,...}} — jouable hors tour par chaque joueur concerné */
function discardCards(S, pid, a, ev, fail) {
  if (S.phase !== 'discard' || !S.discard || S.discard[pid] == null) return fail("Vous n'avez rien à défausser.");
  const p = S.players[pid], need = S.discard[pid], cards = a.cards || {};
  let n = 0;
  for (const [r, k] of Object.entries(cards)) {
    if (!RES.includes(r) || !Number.isInteger(k) || k < 0 || k > p.res[r]) return fail('Défausse impossible.');
    n += k;
  }
  if (n !== need) return fail(`Choisissez exactement ${need} cartes.`);
  for (const [r, k] of Object.entries(cards)) { p.res[r] -= k; S.bank[r] += k; }
  delete S.discard[pid];
  ev.push({ k: 'toast', msg: `${p.nom} défausse ${need} cartes` });
  if (!Object.keys(S.discard).length) { S.discard = null; S.phase = 'robber'; ev.push({ k: 'toast', msg: `${S.players[S.current].nom} déplace le Rôdeur`, delay: 300 }); }
  return { ok: true, events: ev };
}
/* Défausse au hasard (temps écoulé) */
export function randomDiscard(S, pid) {
  const p = S.players[pid], cards = {}; let k = S.discard?.[pid] || 0;
  const left = { ...p.res };
  while (k > 0) { const r = RES.filter(x => left[x] > 0)[Math.floor(Math.random() * RES.filter(x => left[x] > 0).length)]; left[r]--; cards[r] = (cards[r] || 0) + 1; k--; }
  return { t: 'discard', cards };
}

/* ---------- Actions ----------
   applyAction(S, pid, action) modifie S et renvoie { ok, error, events }.
   action : {t:'camp',v} {t:'road',e} {t:'bastion',v} {t:'roll'} {t:'robber',tile} {t:'trade',give,get} {t:'end'} */
export function applyAction(S, pid, a) {
  rand = Math.random;
  const ev = [];
  const fail = error => ({ ok: false, error, events: [] });
  if (S.phase === 'over') return fail('La partie est terminée.');
  const p = S.players[pid];
  if (!p) return fail('Joueur inconnu.');
  const outOfTurn = pid !== S.current;
  if (a.t === 'respond') return respondOffer(S, pid, a, ev, fail);
  if (a.t === 'discard') return discardCards(S, pid, a, ev, fail);
  if (S.phase === 'discard' && !outOfTurn) return fail('Attendez que chacun ait défaussé ses cartes.');
  if (outOfTurn && !(['road', 'camp', 'bastion'].includes(a.t) && canBuildOutOfTurn(S, pid)))
    return fail(S.quickBuild && ['road', 'camp', 'bastion'].includes(a.t) ? 'Vous pourrez construire quand le joueur actif aura lancé les dés.' : "Ce n'est pas votre tour.");

  if (S.phase === 'setup') {
    if (S.setupSub === 'camp' && a.t === 'camp') {
      if (!legalCamps(S, pid, true).includes(a.v)) return fail('Emplacement impossible.');
      S.vertices[a.v].building = { owner: pid, type: 'camp' }; p.built.camp++; S.lastCamp = a.v;
      ev.push({ k: 'camp', v: a.v, pid, setup: true });
      const nw = reveal(S, S.vertices[a.v].tiles); if (nw.length) ev.push({ k: 'reveal', tiles: nw });
      if (S.setupStep >= S.players.length) {
        const got = [];
        for (const tid of S.vertices[a.v].tiles) { const t = S.tiles[tid]; if (RES.includes(t.terrain) && give(S, p, t.terrain, 1)) got.push(t.terrain); }
        if (got.length) ev.push({ k: 'toast', msg: `${p.nom} reçoit ${got.map(r => RES_INFO[r].ic).join(' ')}`, delay: 900 });
      }
      S.setupSub = 'road';
      return { ok: true, events: ev };
    }
    if (S.setupSub === 'road' && a.t === 'road') {
      if (!legalRoads(S, pid, true).includes(a.e)) return fail('Le sentier doit partir de votre nouveau camp.');
      S.edges[a.e].road = pid; p.built.sentier++;
      ev.push({ k: 'road', e: a.e, pid, setup: true, from: S.lastCamp });
      const nw = reveal(S, S.edges[a.e].tiles); if (nw.length) ev.push({ k: 'reveal', tiles: nw });
      S.setupStep++; S.setupSub = 'camp'; S.lastCamp = S.setupStep >= S.setupOrder.length ? null : S.lastCamp;
      if (S.setupStep >= S.setupOrder.length) {
        S.phase = 'roll'; S.current = 0; startRound(S);
        ev.push({ k: 'toast', msg: `Que l'expédition commence ! ${S.tidePlan.length} marées vont bouleverser l'île pendant la partie.`, ms: 4200, delay: 900 });
      } else S.current = S.setupOrder[S.setupStep];
      return { ok: true, events: ev };
    }
    return fail("Action impossible pendant l'installation.");
  }

  if (a.t === 'roll') {
    if (S.phase !== 'roll') return fail('Les dés sont déjà lancés.');
    const d1 = 1 + Math.floor(rand() * 6), d2 = 1 + Math.floor(rand() * 6), n = d1 + d2;
    S.dice = [d1, d2]; ev.push({ k: 'dice', d: [d1, d2], pid });
    if (n === 7) {
      // Au-delà de 7 cartes, chaque joueur choisit lui-même la moitié (arrondie en dessous) à défausser
      S.discard = {};
      for (const q of S.players) { const tot = total(q); if (tot > 7) S.discard[q.id] = Math.floor(tot / 2); }
      ev.push({ k: 'toast', msg: '7 : le Rôdeur sort de la brume', delay: 700 });
      if (Object.keys(S.discard).length) {
        S.phase = 'discard';
        ev.push({ k: 'toast', msg: `Plus de 7 cartes : ${Object.keys(S.discard).map(i => S.players[i].nom).join(', ')} ${Object.keys(S.discard).length > 1 ? 'doivent' : 'doit'} défausser la moitié de sa main`, delay: 1000, ms: 3500 });
      } else { S.discard = null; S.phase = 'robber'; }
      return { ok: true, events: ev };
    }
    const res = produce(S, n);
    ev.push({ k: 'prod', gains: res.gains, fortune: res.fortune });
    if (res.blocked.length) ev.push({ k: 'toast', msg: `La banque manque de ${res.blocked.map(r => RES_INFO[r].nom).join(', ')} : personne n'en reçoit`, delay: 700 });
    if (res.fortune.length) ev.push({ k: 'toast', msg: `✦ Fortune pour ${res.fortune.map(i => S.players[i].nom).join(', ')}`, delay: 1200 });
    S.phase = 'main';
    return { ok: true, events: ev };
  }

  if (a.t === 'robber') {
    if (S.phase !== 'robber') return fail('Le Rôdeur ne peut pas bouger maintenant.');
    if (!legalRobber(S).includes(a.tile)) return fail('Tuile impossible.');
    S.robber = a.tile; ev.push({ k: 'robber', tile: a.tile });
    const victims = S.players.filter(q => q.id !== pid && total(q) > 0 && S.tiles[a.tile].vertices.some(v => S.vertices[v].building?.owner === q.id));
    if (victims.length) {
      const v = pick(victims); const r = pick(RES.filter(x => v.res[x] > 0)); v.res[r]--; p.res[r]++;
      ev.push({ k: 'toast', msg: `Le Rôdeur vole ${RES_INFO[r].ic} à ${v.nom} pour ${p.nom}`, delay: 800 });
    } else ev.push({ k: 'toast', msg: 'Le Rôdeur ne trouve rien à voler', delay: 800 });
    S.phase = 'main';
    return { ok: true, events: ev };
  }

  if (S.phase !== 'main') return fail("Lancez d'abord les dés.");

  if (a.t === 'road') {
    if (!canBuild(S, pid, 'sentier') || !legalRoads(S, pid).includes(a.e)) return fail('Sentier impossible ici.');
    pay(S, p, costOf(S, 'sentier')); S.edges[a.e].road = pid; p.built.sentier++;
    ev.push({ k: 'road', e: a.e, pid });
    const nw = reveal(S, S.edges[a.e].tiles); if (nw.length) ev.push({ k: 'reveal', tiles: nw });
    if (outOfTurn) ev.push({ k: 'toast', msg: `${p.nom} trace un sentier pendant le tour de ${S.players[S.current].nom}` });
    return { ok: true, events: ev };
  }
  if (a.t === 'camp') {
    if (!canBuild(S, pid, 'camp') || !legalCamps(S, pid).includes(a.v)) return fail('Camp impossible ici.');
    pay(S, p, costOf(S, 'camp')); S.vertices[a.v].building = { owner: pid, type: 'camp' }; p.built.camp++;
    ev.push({ k: 'camp', v: a.v, pid });
    const nw = reveal(S, S.vertices[a.v].tiles); if (nw.length) ev.push({ k: 'reveal', tiles: nw });
    if (outOfTurn) ev.push({ k: 'toast', msg: `${p.nom} installe un camp pendant le tour de ${S.players[S.current].nom}` });
    checkWin(S, p, ev);
    return { ok: true, events: ev };
  }
  if (a.t === 'bastion') {
    if (!canBuild(S, pid, 'bastion') || !legalBastions(S, pid).includes(a.v)) return fail('Bastion impossible ici.');
    pay(S, p, costOf(S, 'bastion')); S.vertices[a.v].building.type = 'bastion'; p.built.camp--; p.built.bastion++;
    ev.push({ k: 'bastion', v: a.v, pid });
    if (outOfTurn) ev.push({ k: 'toast', msg: `${p.nom} élève un bastion pendant le tour de ${S.players[S.current].nom}` });
    checkWin(S, p, ev);
    return { ok: true, events: ev };
  }
  if (a.t === 'trade') {
    if (!RES.includes(a.get) || S.bank[a.get] < 1 || a.get === a.give) return fail('Échange impossible.');
    if (a.give === 'fortune') { if (p.fortune < 3) return fail('Il faut 3 jetons de Fortune.'); p.fortune -= 3; }
    else if (RES.includes(a.give)) { const rate = rateFor(S, pid, a.give); if (p.res[a.give] < rate) return fail('Pas assez de cartes.'); p.res[a.give] -= rate; S.bank[a.give] += rate; }
    else return fail('Échange impossible.');
    give(S, p, a.get, 1);
    ev.push({ k: 'bump', pid, res: [a.get] });
    return { ok: true, events: ev };
  }
  if (a.t === 'offer') {
    const give = cleanBundle(a.give), want = cleanBundle(a.want);
    if (!Object.keys(give).length || !Object.keys(want).length) return fail('Choisissez ce que vous donnez et ce que vous voulez.');
    if (Object.keys(give).some(r => want[r])) return fail('On ne peut pas échanger une ressource contre la même.');
    if (!canPay(p, give)) return fail("Vous n'avez pas ces cartes.");
    S.offer = { id: `${S.round}-${S.current}-${Date.now().toString(36)}`, from: pid, give, want, responses: {} };
    ev.push({ k: 'offer' });
    return { ok: true, events: ev };
  }
  if (a.t === 'cancelOffer') { S.offer = null; ev.push({ k: 'offer' }); return { ok: true, events: ev }; }
  if (a.t === 'confirmOffer') {
    const o = S.offer;
    if (!o || o.id !== a.id) return fail("Cette proposition n'existe plus.");
    const q = S.players[a.with];
    if (!q || o.responses[a.with] !== 'accept') return fail("Ce joueur n'a pas accepté.");
    if (!canPay(p, o.give)) return fail("Vous n'avez plus ces cartes.");
    if (!canPay(q, o.want)) return fail(`${q.nom} n'a plus ces cartes.`);
    for (const [r, n] of Object.entries(o.give)) { p.res[r] -= n; q.res[r] += n; }
    for (const [r, n] of Object.entries(o.want)) { q.res[r] -= n; p.res[r] += n; }
    S.offer = null;
    ev.push({ k: 'offer' }, { k: 'toast', msg: `${p.nom} échange ${bundleText(o.give)} contre ${bundleText(o.want)} avec ${q.nom}` });
    return { ok: true, events: ev };
  }
  if (a.t === 'end') {
    S.current = (S.current + 1) % S.players.length;
    S.dice = null;
    if (S.current === 0) {
      startRound(S);
      if (S.tide) ev.push({ k: 'tide', tide: S.tide }, { k: 'toast', msg: `Marée : ${tideTitle(S.tide)}. ${tideDesc(S.tide)}`, ms: 5000 });
      else if (S.nextTide) ev.push({ k: 'toast', msg: `Une marée arrive au prochain tour : ${tideTitle(S.nextTide)}`, ms: 4200 });
    }
    S.offer = null;
    S.phase = 'roll';
    ev.push({ k: 'turn', pid: S.current });
    checkWin(S, S.players[S.current], ev);
    return { ok: true, events: ev };
  }
  return fail('Action inconnue.');
}
