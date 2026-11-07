/* Interface, salons et synchronisation de la partie */
import { RES, RES_INFO, PLAYER_DEFS, MAX_PLAYERS, createGame, applyAction, tideTitle, tideDesc, total, vp, costOf, canBuild, canBuildOutOfTurn,
  legalCamps, legalRoads, legalBastions, legalRobber, rateFor } from './engine.js';
import { initView, buildView, playEvents, showMarkers, clearMarkers, onTap, viewGameId, resetCamera, markerScreenPositions } from './view.js';
import { openRoom } from './net.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const TRANSPORT = params.get('transport') === 'bc' ? 'bc' : 'supabase';
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* rien */ } },
};
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const ME = { id: params.get('id') || store.get('brumes:id') || rid(), name: store.get('brumes:name', '') };
if (!params.get('id')) store.set('brumes:id', ME.id);

/* Session courante */
let session = null; // { mode:'local'|'online', code, room, isHost, lobby, state, peers:Set, win }
let uiMode = null, waiting = false, waitTimer = null, takeoverTimer = null, lastTurnSeen = null;

/* ---------- Messages et petits retours visuels ---------- */
function toast(msg, ms = 2600) {
  const d = document.createElement('div'); d.className = 'toast'; d.textContent = msg; $('toasts').appendChild(d);
  while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
  setTimeout(() => d.remove(), ms);
}
function hint(msg) { $('hintText').textContent = msg || ''; }
function showOverlay(id) { for (const o of document.querySelectorAll('.overlay')) o.classList.toggle('show', o.id === id); }
function hideOverlays() { for (const o of document.querySelectorAll('.overlay')) o.classList.remove('show'); }
function showDice(d) {
  const box = $('dice'); box.classList.add('show');
  $('d1').classList.remove('seven'); $('d2').classList.remove('seven');
  let ticks = 7;
  const spin = setInterval(() => {
    if (ticks-- > 0) { $('d1').textContent = 1 + Math.floor(Math.random() * 6); $('d2').textContent = 1 + Math.floor(Math.random() * 6); return; }
    clearInterval(spin);
    $('d1').textContent = d[0]; $('d2').textContent = d[1];
    if (d[0] + d[1] === 7) { $('d1').classList.add('seven'); $('d2').classList.add('seven'); }
    setTimeout(() => box.classList.remove('show'), 1200);
  }, 70);
}

/* ---------- Qui suis-je dans la partie ? ---------- */
const S = () => session?.state;
function myPid() {
  const st = S(); if (!st) return -1;
  if (session.mode === 'local') return st.current;
  return st.players.findIndex(p => p.clientId === ME.id);
}
const isMyTurn = () => { const st = S(); return !!st && st.phase !== 'over' && myPid() === st.current && myPid() >= 0; };
/* Construction pendant le tour d'un autre joueur (parties en ligne à 5-6) */
const canQuickBuild = () => { const st = S(); return !!st && session.mode === 'online' && canBuildOutOfTurn(st, myPid()); };

/* ---------- Affichage du HUD ---------- */
function renderHUD(bumped = []) {
  const st = S(); if (!st) return;
  const me = myPid(), mine = me >= 0 ? st.players[me] : null;
  const online = session.mode === 'online';
  $('players').classList.toggle('compact', st.players.length > 4);
  $('players').innerHTML = st.players.map(q => {
    const away = online && q.clientId && session.peers && !session.peers.has(q.clientId);
    const isMe = online && q.id === me, compact = st.players.length > 4;
    return `<div class="pchip ${q.id === st.current ? 'active' : ''} ${away ? 'away' : ''} ${isMe ? 'me' : ''}"><span class="dot" style="background:${q.col}"></span><b>${esc(q.nom)}${isMe && !compact ? ' (vous)' : ''}</b><span>${vp(q)} pts</span><small>${total(q)} 🂠</small></div>`;
  }).join('') + `<button type="button" class="menuBtn" id="btnMenu" aria-label="Menu de la partie">⋯</button>`;
  $('btnMenu').onclick = openMenu;
  $('tideNow').querySelector('strong').textContent = st.phase === 'setup' ? "Après l'installation" : tideTitle(st.tide);
  $('tideNext').querySelector('strong').textContent = st.phase === 'setup' ? '—' : tideTitle(st.nextTide);
  if (mine) {
    $('hand').innerHTML = RES.map(r => `<div class="card ${bumped.includes(r) ? 'bump' : ''}"><span class="ic">${RES_INFO[r].ic}</span><span class="n">${mine.res[r]}</span><span class="lb">${RES_INFO[r].nom}</span></div>`).join('') +
      `<div class="card ${bumped.includes('fortune') ? 'bump' : ''}"><span class="ic" style="color:var(--lamp)">✦</span><span class="n">${mine.fortune}</span><span class="lb">Fortune</span></div>`;
  } else $('hand').innerHTML = '<div class="spect">Vous regardez la partie</div>';
  const mt = isMyTurn() && !waiting;
  const mb = (mt || canQuickBuild()) && !waiting;
  $('btnRoll').disabled = !(mt && st.phase === 'roll');
  $('btnSentier').disabled = !(mb && canBuild(st, me, 'sentier'));
  $('btnCamp').disabled = !(mb && canBuild(st, me, 'camp'));
  $('btnBastion').disabled = !(mb && canBuild(st, me, 'bastion'));
  $('btnBank').disabled = !(mt && st.phase === 'main');
  $('btnEnd').disabled = !(mt && st.phase === 'main');
  $('btnSentier').querySelector('.co').textContent = st.tide?.type === 'chantier-sentier' ? '🪵 seulement' : '🪵🪨';
  for (const [id, m] of [['btnSentier', 'sentier'], ['btnCamp', 'camp'], ['btnBastion', 'bastion']]) $(id).classList.toggle('on', uiMode === m);
  $('toasts').style.top = `${Math.round($('top').getBoundingClientRect().bottom + 8)}px`;
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

/* Repères à afficher et message d'aide, selon l'état et le tour */
function refreshInteraction() {
  const st = S(); if (!st) return;
  const me = myPid(), cur = st.players[st.current];
  if (st.phase === 'over') { clearMarkers(); hint(''); return; }
  if (!isMyTurn() || waiting) {
    if (!waiting && canQuickBuild() && uiMode && canBuild(st, me, uiMode)) {
      if (uiMode === 'sentier') { showMarkers('edge', legalRoads(st, me)); hint('Hors tour : touchez un emplacement pour tracer le sentier'); }
      else if (uiMode === 'camp') { showMarkers('vertex', legalCamps(st, me)); hint('Hors tour : touchez une intersection pour installer le camp'); }
      else { showMarkers('vertex', legalBastions(st, me)); hint('Hors tour : touchez un de vos camps pour en faire un bastion'); }
      return;
    }
    clearMarkers(); uiMode = null;
    hint(waiting ? 'Envoi…' : session.mode === 'online' ? `Au tour de ${cur.nom}${canQuickBuild() ? ' · vous pouvez construire' : ''}` : '');
    return;
  }
  if (st.phase === 'setup') {
    const nth = st.setupStep < st.players.length ? '1er' : '2e';
    if (st.setupSub === 'camp') { showMarkers('vertex', legalCamps(st, me, true)); hint(`${cur.nom} : posez votre ${nth} camp`); }
    else { showMarkers('edge', legalRoads(st, me, true)); hint(`${cur.nom} : tracez un sentier depuis ce camp`); }
    return;
  }
  if (st.phase === 'robber') { showMarkers('tile', legalRobber(st)); hint(`${cur.nom} : envoyez le Rôdeur sur une tuile`); return; }
  if (uiMode === 'sentier') { showMarkers('edge', legalRoads(st, me)); hint('Touchez un emplacement lumineux pour tracer le sentier'); return; }
  if (uiMode === 'camp') { showMarkers('vertex', legalCamps(st, me)); hint('Touchez une intersection lumineuse pour installer le camp'); return; }
  if (uiMode === 'bastion') { showMarkers('vertex', legalBastions(st, me)); hint('Touchez un de vos camps pour en faire un bastion'); return; }
  clearMarkers();
  hint(st.phase === 'roll' ? `${cur.nom} : lancez les dés` : 'Construisez, échangez, puis finissez le tour');
}
function refreshAll(bumped) { renderHUD(bumped); refreshInteraction(); }

/* ---------- Réception d'un nouvel état ---------- */
function onNewState(state, events, sequential) {
  session.state = state;
  if (session.mode === 'online') store.set('brumes:last', { code: session.code, state });
  else store.set('brumes:local', state);
  const animate = sequential && viewGameId() === state.gameId;
  if (animate) playEvents(state, events); else buildView(state);
  waiting = false; clearTimeout(waitTimer);
  let bumped = [];
  if (animate) {
    for (const ev of events) {
      if (ev.k === 'toast') setTimeout(() => toast(ev.msg, ev.ms), ev.delay || 0);
      else if (ev.k === 'dice') showDice(ev.d);
      else if (ev.k === 'prod') { const me = myPid(); bumped = [...new Set(ev.gains.filter(g => g.owner === me).map(g => g.res))]; if (ev.fortune.includes(me)) bumped.push('fortune'); }
      else if (ev.k === 'bump' && ev.pid === myPid()) bumped = ev.res;
      else if (ev.k === 'win') setTimeout(() => showWin(ev.pid), 1300);
    }
  } else if (state.phase === 'over' && state.winner != null) showWin(state.winner);
  if (bumped.length) { renderHUD(); setTimeout(() => refreshAll(bumped), 750); } else refreshAll();
  // Signal discret quand c'est à moi de jouer
  const turnKey = `${state.gameId}:${state.round}:${state.current}:${state.setupStep}`;
  if (session.mode === 'online' && isMyTurn() && lastTurnSeen !== turnKey) {
    lastTurnSeen = turnKey;
    toast("C'est à vous de jouer");
    try { navigator.vibrate?.(80); } catch { /* vibration indisponible */ }
  }
}
function showWin(pid) {
  const st = S(); const p = st.players[pid];
  $('winTitle').textContent = `${p.nom} remporte l'expédition`;
  $('winText').textContent = `${vp(p)} points en ${st.round} tours de table.`;
  showOverlay('winOverlay');
}

/* ---------- Jouer une action ---------- */
function act(action) {
  const st = S(); if (!st) return;
  uiMode = null;
  if (session.mode === 'local' || session.isHost) {
    const pid = session.mode === 'local' ? st.current : myPid();
    hostApply(pid, action);
  } else {
    waiting = true; refreshAll();
    session.room.send({ type: 'action', from: ME.id, action });
    clearTimeout(waitTimer);
    waitTimer = setTimeout(() => { waiting = false; toast("Pas de réponse de l'hôte. Réessayez dans un instant."); refreshAll(); session.room.send({ type: 'hello', from: ME.id, name: ME.name }); }, 7000);
  }
}
function hostApply(pid, action) {
  const st = S();
  const res = applyAction(st, pid, action);
  if (!res.ok) { if (pid === myPid()) toast(res.error); else session.room?.send({ type: 'error', to: st.players[pid]?.clientId, msg: res.error }); refreshAll(); return; }
  st.seq++; st.hostId = session.mode === 'online' ? ME.id : null;
  if (session.mode === 'online') session.room.send({ type: 'state', state: st, events: res.events });
  onNewState(st, res.events, true);
}

onTap((kind, id) => {
  const st = S(); if (!st || waiting) return;
  if (!isMyTurn()) {
    if (!canQuickBuild()) return;
    if (uiMode === 'sentier' && kind === 'edge') return act({ t: 'road', e: id });
    if (uiMode === 'camp' && kind === 'vertex') return act({ t: 'camp', v: id });
    if (uiMode === 'bastion' && kind === 'vertex') return act({ t: 'bastion', v: id });
    return;
  }
  if (st.phase === 'setup') return act(kind === 'vertex' ? { t: 'camp', v: id } : { t: 'road', e: id });
  if (st.phase === 'robber' && kind === 'tile') return act({ t: 'robber', tile: id });
  if (uiMode === 'sentier' && kind === 'edge') return act({ t: 'road', e: id });
  if (uiMode === 'camp' && kind === 'vertex') return act({ t: 'camp', v: id });
  if (uiMode === 'bastion' && kind === 'vertex') return act({ t: 'bastion', v: id });
});
$('btnRoll').onclick = () => act({ t: 'roll' });
$('btnEnd').onclick = () => act({ t: 'end' });
for (const [id, m] of [['btnSentier', 'sentier'], ['btnCamp', 'camp'], ['btnBastion', 'bastion']]) $(id).onclick = () => { uiMode = uiMode === m ? null : m; refreshAll(); };
$('tideNow').onclick = () => S()?.tide && toast(tideDesc(S().tide), 4000);
$('tideNext').onclick = () => S()?.nextTide && toast(`Ensuite : ${tideDesc(S().nextTide)}`, 4000);

/* ---------- Banque ---------- */
let give_ = null, get_ = null;
function renderBank() {
  const st = S(), me = myPid(), p = st.players[me];
  $('giveGrid').innerHTML = RES.map(r => { const rate = rateFor(st, me, r); return `<button type="button" class="resbtn ${give_ === r ? 'sel' : ''}" data-r="${r}" ${p.res[r] < rate ? 'disabled' : ''}><span class="ic">${RES_INFO[r].ic}</span>${RES_INFO[r].nom}<small>${rate}:1 · ${p.res[r]} en main</small></button>`; }).join('') +
    `<button type="button" class="resbtn ${give_ === 'fortune' ? 'sel' : ''}" data-r="fortune" ${p.fortune < 3 ? 'disabled' : ''}><span class="ic" style="color:var(--lamp)">✦</span>Fortune<small>3 jetons · ${p.fortune} en main</small></button>`;
  $('getGrid').innerHTML = RES.map(r => `<button type="button" class="resbtn ${get_ === r ? 'sel' : ''}" data-r="${r}" ${st.bank[r] < 1 || r === give_ ? 'disabled' : ''}><span class="ic">${RES_INFO[r].ic}</span>${RES_INFO[r].nom}<small>banque : ${st.bank[r]}</small></button>`).join('');
  const rate = give_ === 'fortune' ? 3 : give_ ? rateFor(st, me, give_) : 0;
  $('tradeSummary').textContent = give_ && get_ ? `${rate} ${give_ === 'fortune' ? '✦' : RES_INFO[give_].ic}  →  1 ${RES_INFO[get_].ic}` : 'Choisissez quoi donner et quoi recevoir';
  $('btnTrade').disabled = !(give_ && get_);
  $('giveGrid').querySelectorAll('button').forEach(b => b.onclick = () => { give_ = b.dataset.r; if (get_ === give_) get_ = null; renderBank(); });
  $('getGrid').querySelectorAll('button').forEach(b => b.onclick = () => { get_ = b.dataset.r; renderBank(); });
}
$('btnBank').onclick = () => { give_ = null; get_ = null; renderBank(); showOverlay('bankOverlay'); };
$('btnBankClose').onclick = hideOverlays;
$('btnTrade').onclick = () => { if (!give_ || !get_) return; const a = { t: 'trade', give: give_, get: get_ }; hideOverlays(); act(a); };

/* ---------- Menu de partie ---------- */
function openMenu() {
  const online = session?.mode === 'online';
  $('menuCode').textContent = online ? `Partie ${session.code}` : 'Partie sur ce téléphone';
  $('menuInvite').style.display = online ? '' : 'none';
  showOverlay('menuOverlay');
}
$('btnMenuClose').onclick = hideOverlays;
$('menuInvite').onclick = () => shareInvite(session.code);
$('btnLeave').onclick = () => { leave(); goHome(); };
$('btnAgain').onclick = () => { leave(); store.del('brumes:last'); store.del('brumes:local'); goHome(); };

/* ---------- Salons en ligne ---------- */
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const newCode = () => Array.from({ length: 4 }, () => ALPH[Math.floor(Math.random() * ALPH.length)]).join('');
const WEB_URL = 'https://viktorlorain-cloud.github.io/Brumes/';
const APK_URL = 'https://github.com/viktorlorain-cloud/Brumes/releases/latest/download/Brumes.apk';
const IN_APP = !!window.Capacitor;
function inviteUrl(code) {
  const u = new URL(IN_APP || !/^https?:$/.test(location.protocol) ? WEB_URL : location.href);
  u.search = `?partie=${code}`; u.hash = ''; return u.toString();
}
async function shareInvite(code) {
  const url = inviteUrl(code), text = `Rejoins ma partie de Brumes : code ${code}`;
  try { if (navigator.share) { await navigator.share({ title: 'Brumes', text, url }); return; } } catch { /* partage annulé */ }
  try { await navigator.clipboard.writeText(`${text}\n${url}`); toast('Invitation copiée'); } catch { toast(`Code de la partie : ${code}`); }
}

function leave() {
  clearTimeout(takeoverTimer); clearTimeout(waitTimer);
  try { session?.room?.close(); } catch { /* déjà fermé */ }
  session = null; uiMode = null; waiting = false;
  clearMarkers(); hint('');
}
function goHome() { renderHome(); showOverlay('homeOverlay'); }

async function connect(code, isHost, fallbackState = null) {
  session = { mode: 'online', code, isHost, lobby: null, state: null, peers: new Set([ME.id]), room: null };
  $('lobbyStatus').textContent = 'Connexion…';
  try {
    session.room = await openRoom(code, ME, { onMessage, onPeers }, TRANSPORT);
  } catch (e) {
    toast('Connexion impossible. Vérifiez le réseau et réessayez.', 4000); session = null; goHome(); return false;
  }
  if (isHost && fallbackState) {
    session.state = fallbackState; fallbackState.hostId = ME.id; fallbackState.seq++;
    session.room.send({ type: 'state', state: fallbackState, events: [] });
    hideOverlays(); onNewState(fallbackState, [], false);
  }
  return true;
}

async function createOnline() {
  if (!requireName()) return;
  const code = newCode();
  showOverlay('lobbyOverlay');
  if (!await connect(code, true)) return;
  session.lobby = { code, hostId: ME.id, seats: [{ clientId: ME.id, name: ME.name }], win: winPts };
  renderLobby(); broadcastLobby();
}
async function joinOnline(code, resumeState = null) {
  if (!requireName()) return;
  code = code.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  if (code.length !== 4) { toast('Le code fait 4 lettres'); return; }
  showOverlay('lobbyOverlay');
  $('lobbyCode').textContent = code; $('lobbySeats').innerHTML = ''; $('btnLaunch').style.display = 'none';
  if (!await connect(code, false)) return;
  let tries = 0;
  const hello = () => {
    if (!session || session.code !== code || session.state || session.lobby) return;
    if (tries++ >= 6) {
      if (resumeState && resumeState.hostId === ME.id) { session.isHost = true; session.state = resumeState; resumeState.seq++; session.room.send({ type: 'state', state: resumeState, events: [] }); hideOverlays(); onNewState(resumeState, [], false); toast('Partie reprise : vous êtes l’hôte'); return; }
      $('lobbyStatus').textContent = "Aucune partie trouvée avec ce code. Vérifiez-le, ou demandez à l'hôte d'ouvrir l'appli.";
      return;
    }
    session.room.send({ type: 'hello', from: ME.id, name: ME.name });
    setTimeout(hello, 1500);
  };
  hello();
}
function broadcastLobby() { if (session?.isHost && session.lobby) session.room.send({ type: 'lobby', lobby: session.lobby }); }

function renderLobby() {
  const l = session.lobby; if (!l) return;
  $('lobbyCode').textContent = l.code;
  $('lobbySeats').innerHTML = l.seats.map((s, i) => `<li><span class="dot" style="background:${PLAYER_DEFS[i].col}"></span><b>${esc(s.name)}</b>${s.clientId === l.hostId ? '<small>hôte</small>' : ''}${s.clientId === ME.id ? '<small>vous</small>' : ''}${session.peers.has(s.clientId) ? '' : '<small class="off">hors ligne</small>'}</li>`).join('') +
    Array.from({ length: MAX_PLAYERS - l.seats.length }, () => '<li class="free"><span class="dot"></span>Place libre</li>').join('');
  const host = session.isHost;
  $('btnLaunch').style.display = host ? '' : 'none';
  $('btnLaunch').disabled = l.seats.length < 2;
  $('lobbyStatus').textContent = host ? (l.seats.length < 2 ? 'Envoyez le code à vos amis pour qu’ils vous rejoignent.' : `Prêt : ${l.seats.length} joueurs, ${l.win} points pour gagner${l.seats.length > 4 ? ', sur la grande île, avec construction pendant le tour des autres' : ''}.`) : "En attente que l'hôte lance la partie…";
}
$('btnInvite').onclick = () => session && shareInvite(session.code);
$('btnLobbyLeave').onclick = () => { leave(); goHome(); };
$('btnLaunch').onclick = () => {
  const l = session.lobby; if (!session.isHost || l.seats.length < 2) return;
  const st = createGame({ seats: l.seats, win: l.win, code: l.code, hostId: ME.id, quickBuild: l.seats.length > 4 });
  session.lobby = null; session.state = st; st.seq = 1;
  session.room.send({ type: 'state', state: st, events: [] });
  hideOverlays(); resetCamera(); onNewState(st, [], false);
  toast('La brume cache les terrains. Les numéros restent visibles.', 3600);
};

function onMessage(m) {
  if (!session) return;
  if (m.to && m.to !== ME.id) return;
  if (m.type === 'hello' && session.isHost) {
    if (session.state) { session.room.send({ type: 'state', state: session.state, events: [] }); return; }
    const l = session.lobby; if (!l) return;
    const seat = l.seats.find(s => s.clientId === m.from);
    if (seat) seat.name = m.name || seat.name;
    else if (l.seats.length < MAX_PLAYERS) l.seats.push({ clientId: m.from, name: m.name || PLAYER_DEFS[l.seats.length].nom });
    else { session.room.send({ type: 'error', to: m.from, msg: `La partie est complète (${MAX_PLAYERS} joueurs).` }); return; }
    renderLobby(); broadcastLobby();
    return;
  }
  if (m.type === 'lobby' && !session.isHost && !session.state) { session.lobby = m.lobby; renderLobby(); return; }
  if (m.type === 'action' && session.isHost && session.state) {
    const pid = session.state.players.findIndex(p => p.clientId === m.from);
    if (pid < 0) { session.room.send({ type: 'error', to: m.from, msg: 'Vous regardez cette partie sans y jouer.' }); return; }
    hostApply(pid, m.action); return;
  }
  if (m.type === 'state') {
    const cur = S(), st = m.state;
    if (cur && cur.gameId === st.gameId && st.seq <= cur.seq) {
      if (session.isHost && st.hostId !== ME.id && st.seq === cur.seq) { session.room.send({ type: 'state', state: cur, events: [] }); }
      return;
    }
    if (session.isHost && st.hostId !== ME.id) session.isHost = false;
    const sequential = !!cur && cur.gameId === st.gameId && st.seq === cur.seq + 1;
    session.lobby = null;
    if (document.getElementById('lobbyOverlay').classList.contains('show')) { hideOverlays(); resetCamera(); }
    onNewState(st, m.events || [], sequential);
    return;
  }
  if (m.type === 'error') { waiting = false; clearTimeout(waitTimer); toast(m.msg, 3500); refreshAll(); }
}

function onPeers(ids) {
  if (!session) return;
  session.peers = new Set(ids);
  if (session.lobby) renderLobby();
  if (session.state) renderHUD();
  // Si l'hôte disparaît pendant la partie, le joueur connecté le mieux placé reprend l'arbitrage
  const st = S();
  if (!st || session.isHost || !st.hostId || session.peers.has(st.hostId)) { clearTimeout(takeoverTimer); takeoverTimer = null; return; }
  if (takeoverTimer) return;
  takeoverTimer = setTimeout(() => {
    takeoverTimer = null;
    const s2 = S(); if (!session || !s2 || session.isHost || session.peers.has(s2.hostId)) return;
    const present = s2.players.filter(p => session.peers.has(p.clientId)).map(p => p.id);
    if (!present.length || s2.players[present[0]].clientId !== ME.id) return;
    session.isHost = true; s2.hostId = ME.id; s2.seq++;
    const events = [{ k: 'toast', msg: `${s2.players[present[0]].nom} reprend l’arbitrage de la partie` }];
    session.room.send({ type: 'state', state: s2, events });
    onNewState(s2, events, false);
    toast('L’hôte est parti : votre téléphone arbitre maintenant la partie', 4000);
  }, 6000);
}

/* ---------- Partie locale ---------- */
function startLocal(n) {
  leave();
  const seats = PLAYER_DEFS.slice(0, n).map(d => ({ name: d.nom }));
  session = { mode: 'local', state: createGame({ seats, win: winPts }) };
  hideOverlays(); resetCamera(); onNewState(session.state, [], false);
  toast('La brume cache les terrains. Les numéros restent visibles.', 3600);
}

/* ---------- Écran d'accueil ---------- */
let winPts = 10, localN = 3;
function requireName() {
  const n = $('nameInput').value.trim().slice(0, 12);
  if (!n) { toast('Choisissez un nom pour que vos amis vous reconnaissent'); $('nameInput').focus(); return false; }
  ME.name = n; store.set('brumes:name', n); return true;
}
function renderHome() {
  $('nameInput').value = ME.name || '';
  const last = store.get('brumes:last'), local = store.get('brumes:local');
  const canResume = last && last.state && last.state.phase !== 'over' && last.state.players.some(p => p.clientId === ME.id);
  $('btnResume').style.display = canResume ? '' : 'none';
  if (canResume) $('btnResume').textContent = `Reprendre la partie ${last.code}`;
  $('btnResumeLocal').style.display = local && local.phase !== 'over' ? '' : 'none';
  if (params.get('partie')) $('codeInput').value = params.get('partie').toUpperCase().slice(0, 4);
}
for (const [seg, set] of [['segWin', v => winPts = v], ['segLocal', v => localN = v]]) {
  $(seg).querySelectorAll('button').forEach(b => b.onclick = () => { $(seg).querySelectorAll('button').forEach(x => x.classList.remove('sel')); b.classList.add('sel'); set(+b.dataset.v); });
}
$('btnCreate').onclick = createOnline;
$('btnJoin').onclick = () => joinOnline($('codeInput').value);
$('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinOnline($('codeInput').value); });
$('btnLocal').onclick = () => startLocal(localN);
$('btnResume').onclick = () => { const last = store.get('brumes:last'); if (!requireName()) return; joinOnline(last.code, last.state); };
$('btnResumeLocal').onclick = () => { leave(); session = { mode: 'local', state: store.get('brumes:local') }; hideOverlays(); resetCamera(); onNewState(session.state, [], false); };

/* Installation sur l'écran d'accueil */
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('btnInstall').style.display = ''; });
$('btnInstall').onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice.catch(() => null); installEvt = null; $('btnInstall').style.display = 'none'; };
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (standalone || IN_APP) $('installHelp').style.display = 'none';
if (!IN_APP && /Android/i.test(navigator.userAgent)) { $('btnApk').href = APK_URL; $('btnApk').style.display = ''; }
if ('serviceWorker' in navigator && location.protocol === 'https:' && !IN_APP) navigator.serviceWorker.register('./sw.js').catch(() => null);

/* ---------- Démarrage ---------- */
initView($('scene'));
buildView(createGame({ seats: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], seed: 20261107 }));
goHome();
if (params.get('partie')) $('codeInput').focus();

/* Accès pour les tests automatiques */
window.__brumes = { get session() { return session; }, ME, markerScreenPositions, act, hostApply, legalCamps, legalRoads };
