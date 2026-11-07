/* Affichage 3D du plateau (Three.js). Lit l'état, ne le modifie jamais. */
import * as THREE from 'three';
import { RES, RES_INFO, PIPS } from './engine.js';

let S = null;
const FOG_COL = new THREE.Color('#6d8594');
const SEA_BASE = new THREE.Color('#123447');
const TOP = 0.15;
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let renderer, scene, camera, sea, sun, world, markers, view = null, seaTarget = SEA_BASE.clone();
let tapHandler = () => {};

export function initView(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  scene = new THREE.Scene();
  scene.background = new THREE.Color('#0e2533');
  scene.fog = new THREE.Fog('#0e2533', 13, 26);
  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  scene.add(new THREE.HemisphereLight('#d6ecff', '#1d2f3a', 1.0));
  sun = new THREE.DirectionalLight('#ffe3bd', 1.7);
  sun.position.set(4, 10, 5); sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 1, far: 30 });
  scene.add(sun);
  sea = new THREE.Mesh(new THREE.CircleGeometry(40, 64), new THREE.MeshStandardMaterial({ color: SEA_BASE.clone(), roughness: 0.55, metalness: 0.1 }));
  sea.rotation.x = -Math.PI / 2; sea.position.y = -0.22; sea.receiveShadow = true; scene.add(sea);
  const shallows = new THREE.Mesh(new THREE.CircleGeometry(5.3, 64), new THREE.MeshStandardMaterial({ color: '#2a7186', roughness: 0.7, transparent: true, opacity: 0.75 }));
  shallows.rotation.x = -Math.PI / 2; shallows.position.y = -0.2; scene.add(shallows);
  world = new THREE.Group(); scene.add(world);
  markers = new THREE.Group(); scene.add(markers);
  setupInput(canvas);
  window.addEventListener('resize', layoutCamera);
  layoutCamera();
  requestAnimationFrame(loop);
}
export function onTap(fn) { tapHandler = fn; }

const mat = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.85, ...o });
function shadowed(m) { m.castShadow = true; m.receiveShadow = true; return m; }
function textTexture(draw, w = 128, h = 128) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; return tex;
}
function numberTexture(n) {
  return textTexture((g, w, h) => {
    g.fillStyle = (n === 6 || n === 8) ? '#c8372d' : '#25323a';
    g.font = '800 60px Figtree, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(n), w / 2, h / 2 - 8);
    const p = PIPS(n);
    for (let i = 0; i < p; i++) { g.beginPath(); g.arc(w / 2 + (i - (p - 1) / 2) * 11, h / 2 + 30, 4, 0, Math.PI * 2); g.fill(); }
  });
}
function labelSprite(text, sub) {
  const tex = textTexture((g, w, h) => {
    g.fillStyle = 'rgba(10,22,30,0.85)'; g.beginPath(); g.roundRect(6, 22, w - 12, h - 44, 18); g.fill();
    g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = '700 34px Figtree, system-ui, sans-serif'; g.fillText(text, w / 2, sub ? h / 2 - 12 : h / 2);
    if (sub) { g.font = '700 22px Figtree, system-ui, sans-serif'; g.fillStyle = '#ffcf6b'; g.fillText(sub, w / 2, h / 2 + 20); }
  });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, fog: false }));
  s.scale.set(0.62, 0.62, 1); return s;
}
function emojiSprite(e, size = 0.34) {
  const tex = textTexture((g, w, h) => { g.font = '84px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(e, w / 2, h / 2 + 6); });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(size, size, 1); return s;
}
function ringPos(i, n, rad, rot = 0) { const a = rot + i / n * Math.PI * 2; return [Math.cos(a) * rad, Math.sin(a) * rad]; }
function scaled(g, f) { const outer = new THREE.Group(); g.scale.setScalar(f); outer.add(g); outer.userData = g.userData; return outer; }

/* ---------- Décors ---------- */
function makeDecor(terrain, rot) {
  const g = new THREE.Group();
  if (terrain === 'bois') {
    for (let i = 0; i < 6; i++) {
      const [x, z] = ringPos(i, 6, 0.6 + (i % 2) * 0.08, rot);
      const s = 0.8 + ((i * 37) % 5) / 10;
      const trunk = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.12, 5), mat('#6b4a2e')));
      trunk.position.set(x, 0.06, z);
      const top = shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.13 * s, 0.38 * s, 6), mat(i % 2 ? '#2f6b3b' : '#3b8048')));
      top.position.set(x, 0.12 + 0.19 * s, z);
      g.add(trunk, top);
    }
  } else if (terrain === 'pierre') {
    for (let i = 0; i < 4; i++) {
      const [x, z] = ringPos(i, 4, 0.58, rot);
      const b = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12 + (i % 2) * 0.1, 0.16), mat(i % 2 ? '#a24f2b' : '#d27a4a')));
      b.position.set(x, 0.08, z); b.rotation.y = i * 0.7; g.add(b);
      const b2 = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.1), mat('#e39a6c')));
      b2.position.set(x + 0.05, 0.2 + (i % 2) * 0.1, z); b2.rotation.y = i; g.add(b2);
    }
  } else if (terrain === 'lin') {
    for (let i = 0; i < 9; i++) {
      const [x, z] = ringPos(i, 9, 0.5 + (i % 3) * 0.1, rot);
      const tuft = shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.22, 5), mat('#7fa44a')));
      tuft.position.set(x, 0.11, z); g.add(tuft);
      const fl = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 4), mat('#7aa8ff', { emissive: '#22406f' }));
      fl.position.set(x, 0.24, z); g.add(fl);
    }
  } else if (terrain === 'grain') {
    for (let i = 0; i < 3; i++) {
      const step = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.82 - i * 0.1, 0.84 - i * 0.1, 0.05, 6, 1, true, rot + i * 0.3, Math.PI * 0.9), mat(i % 2 ? '#c99632' : '#e8bd55', { side: THREE.DoubleSide })));
      step.position.y = 0.03 + i * 0.05; g.add(step);
    }
    for (let i = 0; i < 6; i++) {
      const [x, z] = ringPos(i, 6, 0.62, rot + Math.PI);
      const sheaf = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 0.2, 6), mat('#f2c860')));
      sheaf.position.set(x, 0.1, z); g.add(sheaf);
    }
  } else if (terrain === 'cristal') {
    [[0.55, rot], [0.6, rot + 2.2], [0.5, rot + 4.1]].forEach(([rad, a], i) => {
      const x = Math.cos(a) * rad, z = Math.sin(a) * rad, h = 0.55 + i * 0.12;
      const m = shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.3, h, 5), mat('#6f7a8f')));
      m.position.set(x, h / 2, z); g.add(m);
      const cap = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.2, 5), mat('#eef3f8'));
      cap.position.set(x, h - 0.08, z); g.add(cap);
    });
    for (let i = 0; i < 3; i++) {
      const [x, z] = ringPos(i, 3, 0.62, rot + 1.1);
      const c = shadowed(new THREE.Mesh(new THREE.OctahedronGeometry(0.09), mat('#7ff0ff', { emissive: '#1aa6c4', emissiveIntensity: 0.9, roughness: 0.2 })));
      c.position.set(x, 0.12, z); c.scale.y = 1.6; g.add(c);
    }
  }
  return g;
}
function makeFog(rot) {
  const g = new THREE.Group();
  for (let i = 0; i < 6; i++) {
    const [x, z] = ringPos(i, 6, 0.58, rot);
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.24 + (i % 3) * 0.06, 8, 6), new THREE.MeshStandardMaterial({ color: '#dbe7ee', emissive: '#4a6272', emissiveIntensity: 0.35, transparent: true, opacity: 0.78, roughness: 1, flatShading: true, depthWrite: false }));
    m.position.set(x, 0.18, z); m.userData.phase = i * 1.3 + rot; g.add(m);
  }
  return g;
}
function makePhare() {
  const g = new THREE.Group();
  const rock = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.55, 0.18, 7), mat('#a7a08c')));
  rock.position.y = 0.09; g.add(rock);
  for (let i = 0; i < 4; i++) {
    const s = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.2 - i * 0.02, 0.22 - i * 0.02, 0.2, 10), mat(i % 2 ? '#c8402f' : '#f2ede2')));
    s.position.y = 0.28 + i * 0.2; g.add(s);
  }
  const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.16, 10), new THREE.MeshStandardMaterial({ color: '#ffe7a3', emissive: '#ffcf6b', emissiveIntensity: 2 }));
  lamp.position.y = 1.08; g.add(lamp);
  const roof = shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.2, 10), mat('#2b3d48')));
  roof.position.y = 1.26; g.add(roof);
  const light = new THREE.PointLight('#ffcf6b', 6, 5, 1.6); light.position.y = 1.1; g.add(light);
  const beamGeo = new THREE.ConeGeometry(0.5, 3.4, 16, 1, true); beamGeo.translate(0, -1.7, 0); beamGeo.rotateZ(Math.PI / 2);
  const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: '#ffe0a0', transparent: true, opacity: 0.13, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
  beam.position.y = 1.08; g.add(beam); g.userData.beam = beam;
  return g;
}
function makeScout(color) {
  const g = new THREE.Group();
  const body = shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.085, 0.24, 7), mat(color))); body.position.y = 0.12; g.add(body);
  const head = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), mat('#f0d2b0'))); head.position.y = 0.27; g.add(head);
  const hood = new THREE.Mesh(new THREE.SphereGeometry(0.062, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(color)); hood.position.y = 0.28; hood.rotation.x = -0.3; g.add(hood);
  const lantern = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 6), new THREE.MeshStandardMaterial({ color: '#ffe1a0', emissive: '#ffcf6b', emissiveIntensity: 2.5 })); lantern.position.set(0.08, 0.13, 0.03); g.add(lantern);
  const pack = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.08, 0.05), mat('#6b4a2e'))); pack.position.set(0, 0.17, -0.06); g.add(pack);
  return scaled(g, 1.7);
}
function makeTent(color) {
  const g = new THREE.Group();
  const tent = shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.26, 4), mat(color))); tent.position.y = 0.13; tent.rotation.y = Math.PI / 4; g.add(tent);
  const door = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.11), mat('#1b2a33', { side: THREE.DoubleSide })); door.position.set(0, 0.06, 0.122); door.rotation.x = -0.35; g.add(door);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.22, 4), mat('#3b2a1c')); pole.position.set(0, 0.36, 0); g.add(pole);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.11, 0.06), mat(color, { side: THREE.DoubleSide, emissive: color, emissiveIntensity: 0.25 })); flag.position.set(0.055, 0.43, 0); g.add(flag); g.userData.flag = flag;
  return scaled(g, 1.4);
}
function makeBastion(color) {
  const g = new THREE.Group();
  const base = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.34, 8), mat('#d6cdb8'))); base.position.y = 0.17; g.add(base);
  for (let i = 0; i < 8; i++) { const [x, z] = ringPos(i, 8, 0.16); const m = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.05), mat('#cfc4ad'))); m.position.set(x, 0.37, z); g.add(m); }
  const roof = shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.22, 8), mat(color))); roof.position.y = 0.48; g.add(roof);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.07), mat(color, { side: THREE.DoubleSide, emissive: color, emissiveIntensity: 0.25 })); flag.position.set(0.06, 0.66, 0); g.add(flag); g.userData.flag = flag;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.16, 4), mat('#3b2a1c')); pole.position.set(0, 0.64, 0); g.add(pole);
  return scaled(g, 1.25);
}
function makeRobber() {
  const g = new THREE.Group();
  const mist = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), new THREE.MeshStandardMaterial({ color: '#2a2042', transparent: true, opacity: 0.45, depthWrite: false })); mist.position.y = 0.1; mist.scale.y = 0.4; g.add(mist);
  const body = shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.46, 7), mat('#1d1a2c'))); body.position.y = 0.23; g.add(body);
  const head = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), mat('#1d1a2c'))); head.position.y = 0.48; g.add(head);
  for (const s of [-1, 1]) { const eye = new THREE.Mesh(new THREE.SphereGeometry(0.016, 6, 4), new THREE.MeshBasicMaterial({ color: '#d9a6ff' })); eye.position.set(s * 0.03, 0.49, 0.075); g.add(eye); }
  return scaled(g, 1.3);
}

/* ---------- Construction depuis l'état ---------- */
function vpos(vid, y = TOP + 0.02) { const v = S.vertices[vid]; return V3(v.x, y, v.z); }
function roadMesh(eid, pid, fromVid) {
  const e = S.edges[eid];
  const startV = fromVid != null ? fromVid : e.v[0];
  const endV = e.v[0] === startV ? e.v[1] : e.v[0];
  const a = vpos(startV, TOP + 0.03), b = vpos(endV, TOP + 0.03), len = a.distanceTo(b);
  const geo = new THREE.BoxGeometry(len * 0.8, 0.06, 0.13); geo.translate(len * 0.4, 0, 0);
  const road = shadowed(new THREE.Mesh(geo, mat(S.players[pid].col)));
  const dir = b.clone().sub(a).normalize();
  road.position.copy(a.clone().add(dir.clone().multiplyScalar(len * 0.1)));
  road.rotation.y = Math.atan2(-dir.z, dir.x);
  return road;
}

export function buildView(state) {
  S = state;
  world.clear(); markers.clear(); tweens.length = 0;
  view = { tiles: [], vertexObjs: new Map(), roadObjs: new Map(), robber: null, phare: null, gameId: S.gameId };
  for (const t of S.tiles) {
    const g = new THREE.Group(); g.position.set(t.x, 0, t.z);
    const col = t.terrain === 'phare' ? new THREE.Color('#cbbf9f') : (t.revealed ? new THREE.Color(RES_INFO[t.terrain].col) : FOG_COL.clone());
    const base = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.965, 1.0, 0.3, 6), mat(col)));
    g.add(base);
    const rot = (t.id * 1.7) % (Math.PI * 2);
    const top = new THREE.Group(); top.position.y = TOP; g.add(top);
    let decor = null, fog = null;
    if (t.terrain === 'phare') { view.phare = makePhare(); top.add(view.phare); }
    else {
      decor = makeDecor(t.terrain, rot); top.add(decor);
      if (!t.revealed) { decor.scale.setScalar(0.001); fog = makeFog(rot); top.add(fog); }
    }
    if (t.number) {
      const token = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.05, 24), mat('#f4ead3', { flatShading: false }))); token.position.y = 0.03; top.add(token);
      const label = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), new THREE.MeshBasicMaterial({ map: numberTexture(t.number), transparent: true }));
      label.rotation.x = -Math.PI / 2; label.position.y = 0.058; top.add(label);
    }
    world.add(g);
    view.tiles[t.id] = { group: g, base, decor, fog };
  }
  for (const p of S.ports) {
    const e = S.edges[p.edge], a = S.vertices[e.v[0]], b = S.vertices[e.v[1]], t = S.tiles[e.tiles[0]];
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const dir = new THREE.Vector2(mx - t.x, mz - t.z).normalize();
    const pier = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.5), mat('#8a6440')));
    pier.position.set(mx + dir.x * 0.25, -0.02, mz + dir.y * 0.25); pier.rotation.y = Math.atan2(dir.x, dir.y); world.add(pier);
    for (const v of [a, b]) {
      const plank = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.35), mat('#a07a50')));
      plank.position.set((v.x + mx + dir.x * 0.45) / 2, 0, (v.z + mz + dir.y * 0.45) / 2); plank.lookAt(mx + dir.x * 0.45, 0, mz + dir.y * 0.45); world.add(plank);
    }
    const lab = p.type === '3:1' ? labelSprite('3:1', 'Crique') : labelSprite(RES_INFO[p.type].ic, '2:1');
    lab.position.set(mx + dir.x * 0.78, 0.32, mz + dir.y * 0.78); world.add(lab);
  }
  for (const e of S.edges) if (e.road != null) { const r = roadMesh(e.id, e.road); world.add(r); view.roadObjs.set(e.id, r); }
  for (const v of S.vertices) if (v.building) {
    const o = v.building.type === 'bastion' ? makeBastion(S.players[v.building.owner].col) : makeTent(S.players[v.building.owner].col);
    o.position.copy(vpos(v.id, TOP)); world.add(o); view.vertexObjs.set(v.id, o);
  }
  view.robber = makeRobber(); world.add(view.robber); placeRobberAt(S.robber, false);
  setTide(S.tide?.type);
}
export const viewGameId = () => view?.gameId;
export function setState(state) { S = state; }
export function setTide(type) {
  const col = { abondance: '#1f5a4a', disette: '#3a3a35', haut: '#4a4220', bas: '#2f2a48' }[type];
  seaTarget = new THREE.Color(col || SEA_BASE);
}

/* ---------- Animations ---------- */
const tweens = [];
function tween(dur, update, done, delay = 0) { tweens.push({ t: -delay, dur, update, done }); }
const ease = k => k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
const backOut = k => { const c = 1.9; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); };

function placeRobberAt(tid, animate) {
  const t = S.tiles[tid]; const to = V3(t.x + 0.32, TOP, t.z + 0.18);
  if (!animate) { view.robber.position.copy(to); return; }
  const from = view.robber.position.clone();
  tween(0.9, k => { view.robber.position.lerpVectors(from, to, ease(k)); view.robber.position.y = TOP + Math.sin(k * Math.PI) * 0.6; });
}
function scoutPath(pid, targets) {
  const starts = S.vertices.filter(v => v.building && v.building.owner === pid).map(v => v.id);
  const prev = new Map(starts.map(s => [s, -1])); const q = [...starts];
  while (q.length) {
    const v = q.shift();
    if (targets.includes(v)) { const path = []; let c = v; while (c !== -1) { path.unshift(c); c = prev.get(c); } return path; }
    for (const e of S.vertices[v].edges) {
      if (S.edges[e].road !== pid) continue;
      const o = S.edges[e].v[0] === v ? S.edges[e].v[1] : S.edges[e].v[0];
      if (!prev.has(o)) { prev.set(o, v); q.push(o); }
    }
  }
  return null;
}
function walkScout(pid, points, onStep, onArrive) {
  const scout = makeScout(S.players[pid].col); world.add(scout);
  scout.position.copy(points[0]);
  const segs = []; let L = 0;
  for (let i = 1; i < points.length; i++) { const d = points[i].distanceTo(points[i - 1]); segs.push(d); L += d; }
  const dur = reduceMotion ? 0.2 : Math.min(1.2, Math.max(0.5, L / 2.2));
  scout.scale.setScalar(0.01);
  tween(0.15, k => scout.scale.setScalar(Math.max(0.01, k)));
  tween(dur, k => {
    let d = k * L, i = 0;
    while (i < segs.length - 1 && d > segs[i]) { d -= segs[i]; i++; }
    const f = segs[i] ? Math.min(1, d / segs[i]) : 1;
    const a = points[i], b = points[i + 1] || points[i];
    scout.position.lerpVectors(a, b, f);
    scout.position.y = a.y + Math.abs(Math.sin(k * dur * 18)) * 0.035;
    if (b !== a) scout.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
    scout.rotation.z = Math.sin(k * dur * 18) * 0.08;
    onStep && onStep(i, f, segs.length);
  }, () => {
    onArrive && onArrive();
    tween(0.5, k => { scout.position.y -= 0.004; scout.scale.setScalar(Math.max(0.01, 1 - k)); }, () => world.remove(scout), 0.6);
  }, 0.1);
}
function animateRoad(ev) {
  const e = S.edges[ev.e];
  let path;
  if (ev.setup) path = [ev.from];
  else { const saved = e.road; e.road = null; path = scoutPath(ev.pid, e.v) || [e.v[0]]; e.road = saved; }
  const end = path[path.length - 1];
  const far = e.v[0] === end ? e.v[1] : e.v[0];
  const road = roadMesh(ev.e, ev.pid, end); road.scale.x = 0.001; world.add(road); view.roadObjs.set(ev.e, road);
  walkScout(ev.pid, [...path, far].map(v => vpos(v)), (i, f, n) => { if (i === n - 1) road.scale.x = Math.max(0.001, f); }, () => { road.scale.x = 1; });
}
function animateCamp(ev) {
  let pts;
  if (ev.setup) { const c = S.tiles[S.center]; pts = [V3(c.x + 0.3, TOP + 0.02, c.z + 0.3), vpos(ev.v)]; }
  else {
    const v = S.vertices[ev.v], b = v.building; v.building = null; const path = scoutPath(ev.pid, [ev.v]); v.building = b;
    pts = (path || [ev.v]).map(x => vpos(x)); if (pts.length === 1) pts.unshift(pts[0].clone().add(V3(0.3, 0, 0.3)));
  }
  const tent = makeTent(S.players[ev.pid].col); tent.position.copy(vpos(ev.v, TOP)); tent.scale.setScalar(0.001); world.add(tent);
  view.vertexObjs.set(ev.v, tent);
  walkScout(ev.pid, pts, null, () => tween(0.45, k => tent.scale.setScalar(Math.max(0.001, backOut(k)))));
}
function animateBastion(ev) {
  const old = view.vertexObjs.get(ev.v);
  const tower = makeBastion(S.players[ev.pid].col); tower.position.copy(vpos(ev.v, TOP)); tower.scale.set(1, 0.001, 1); world.add(tower);
  view.vertexObjs.set(ev.v, tower);
  if (old) tween(0.3, k => old.scale.setScalar(Math.max(0.001, 1 - k)), () => world.remove(old));
  tween(0.6, k => tower.scale.set(1, Math.max(0.001, backOut(k)), 1), null, 0.2);
}
function animateReveal(ids) {
  ids.forEach((id, i) => {
    const v = view.tiles[id], t = S.tiles[id];
    const from = v.base.material.color.clone(), to = new THREE.Color(RES_INFO[t.terrain].col);
    const fog = v.fog;
    tween(0.8, k => {
      v.base.material.color.lerpColors(from, to, k);
      if (fog) fog.children.forEach(m => { m.material.opacity = 0.78 * (1 - k); m.position.y = 0.18 + k * 0.5; m.scale.setScalar(1 + k * 0.8); });
      v.decor.scale.setScalar(Math.max(0.001, backOut(Math.min(1, k * 1.3))));
    }, () => { if (fog && fog.parent) fog.parent.remove(fog); v.fog = null; }, 0.35 + i * 0.12);
  });
}
function animateProduction(gains, delay) {
  gains.forEach((g, i) => {
    const t = S.tiles[g.tile];
    for (let j = 0; j < g.n; j++) {
      const s = emojiSprite(RES_INFO[g.res].ic); s.visible = false; world.add(s);
      const from = V3(t.x, TOP + 0.3, t.z), to = vpos(g.vertex, TOP + 0.6);
      tween(0.8, k => { s.visible = true; s.position.lerpVectors(from, to, ease(k)); s.position.y += Math.sin(k * Math.PI) * 0.5; s.material.opacity = k > 0.8 ? (1 - k) * 5 : 1; },
        () => world.remove(s), delay + i * 0.07 + j * 0.12);
    }
  });
}

/* Joue les événements renvoyés par le moteur (l'état S est déjà à jour) */
export function playEvents(state, events) {
  S = state;
  for (const ev of events) {
    if (ev.k === 'camp') animateCamp(ev);
    else if (ev.k === 'road') animateRoad(ev);
    else if (ev.k === 'bastion') animateBastion(ev);
    else if (ev.k === 'reveal') animateReveal(ev.tiles);
    else if (ev.k === 'prod') animateProduction(ev.gains, reduceMotion ? 0 : 0.65);
    else if (ev.k === 'robber') placeRobberAt(ev.tile, true);
  }
  setTide(S.tide?.type);
}

/* ---------- Repères d'interaction ---------- */
const hitMat = new THREE.MeshBasicMaterial({ visible: false });
const glow = new THREE.MeshBasicMaterial({ color: '#ffcf6b', transparent: true, opacity: 0.85, depthWrite: false });
export function showMarkers(kind, ids) {
  markers.clear();
  for (const id of ids) {
    const g = new THREE.Group(); g.userData = { kind, id };
    if (kind === 'vertex') {
      const v = S.vertices[id];
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.08, 0.14, 24), glow); ring.rotation.x = -Math.PI / 2;
      const dot = new THREE.Mesh(new THREE.CircleGeometry(0.05, 16), glow); dot.rotation.x = -Math.PI / 2;
      g.add(ring, dot, new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), hitMat)); g.position.set(v.x, TOP + 0.08, v.z);
    } else if (kind === 'edge') {
      const e = S.edges[id], a = S.vertices[e.v[0]], b = S.vertices[e.v[1]];
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.03, 0.08), glow), new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.3, 0.38), hitMat));
      g.position.set((a.x + b.x) / 2, TOP + 0.07, (a.z + b.z) / 2); g.rotation.y = Math.atan2(-(b.z - a.z), b.x - a.x);
    } else if (kind === 'tile') {
      const t = S.tiles[id];
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.78, 0.9, 6, 1, Math.PI / 2), glow); ring.rotation.x = -Math.PI / 2;
      g.add(ring, new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.5, 6), hitMat)); g.position.set(t.x, TOP + 0.04, t.z);
    }
    markers.add(g);
  }
}
export function clearMarkers() { markers.clear(); }

/* ---------- Caméra et gestes ---------- */
let zoom = 1; const pan = new THREE.Vector2(0, 0);
function layoutCamera() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h;
  const need = camera.aspect < 0.75 ? 9.4 : 11.2;
  const vfov = THREE.MathUtils.degToRad(camera.fov);
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  const dist = Math.max((need / 2) / Math.tan(hfov / 2), (need * 0.95 / 2) / Math.tan(vfov / 2)) * zoom;
  const tilt = THREE.MathUtils.degToRad(57);
  camera.position.set(pan.x, Math.sin(tilt) * dist, pan.y + 0.35 + Math.cos(tilt) * dist);
  camera.lookAt(pan.x, 0, pan.y + 0.35);
  camera.updateProjectionMatrix();
  scene.fog.near = dist * 1.05; scene.fog.far = dist * 2.4;
}
export function resetCamera() { zoom = 1; pan.set(0, 0); layoutCamera(); }
function setupInput(canvas) {
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), pointers = new Map();
  let downAt = null, moved = false, pinch0 = null;
  canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); downAt = { x: e.clientX, y: e.clientY }; moved = false; if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), z: zoom }; } });
  canvas.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinch0) { const [a, b] = [...pointers.values()]; zoom = THREE.MathUtils.clamp(pinch0.z * pinch0.d / Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), 0.5, 1.15); moved = true; layoutCamera(); return; }
    if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 8) moved = true;
    if (moved && pointers.size === 1 && zoom < 0.98) {
      const k = 0.012 * zoom;
      pan.x = THREE.MathUtils.clamp(pan.x - (e.clientX - prev.x) * k, -3, 3);
      pan.y = THREE.MathUtils.clamp(pan.y - (e.clientY - prev.y) * k * 1.2, -3, 3);
      layoutCamera();
    }
  });
  canvas.addEventListener('pointerup', e => {
    pointers.delete(e.pointerId); if (pointers.size < 2) pinch0 = null;
    if (moved || pointers.size !== 0 || !markers.children.length) return;
    ndc.set(e.clientX / window.innerWidth * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    camera.updateMatrixWorld(); markers.updateMatrixWorld(true);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(markers.children, true);
    if (!hits.length) return;
    let o = hits[0].object; while (o && !o.userData.kind) o = o.parent;
    if (o) tapHandler(o.userData.kind, o.userData.id);
  });
  canvas.addEventListener('pointercancel', e => { pointers.delete(e.pointerId); pinch0 = null; });
  canvas.addEventListener('wheel', e => { e.preventDefault(); zoom = THREE.MathUtils.clamp(zoom * (1 + e.deltaY * 0.001), 0.5, 1.15); if (zoom >= 0.98) pan.set(0, 0); layoutCamera(); }, { passive: false });
}

/* ---------- Boucle de rendu ---------- */
const clock = new THREE.Clock();
function loop() {
  const dt = Math.min(clock.getDelta(), 0.05), time = clock.elapsedTime;
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i]; tw.t += dt; if (tw.t < 0) continue;
    const k = Math.min(1, tw.t / tw.dur); tw.update(k);
    if (k >= 1) { tweens.splice(i, 1); tw.done && tw.done(); }
  }
  if (view) {
    if (view.phare) view.phare.userData.beam.rotation.y = time * 0.7;
    for (const t of view.tiles) if (t?.fog) t.fog.children.forEach(m => { m.position.y = 0.18 + Math.sin(time * 0.8 + m.userData.phase) * 0.03; m.rotation.y = time * 0.1 + m.userData.phase; });
    for (const o of view.vertexObjs.values()) if (o.userData.flag) o.userData.flag.rotation.y = Math.sin(time * 3 + o.position.x) * 0.35;
    view.robber.rotation.y = Math.sin(time * 0.6) * 0.4;
  }
  glow.opacity = 0.55 + Math.sin(time * 5) * 0.3;
  sea.material.color.lerp(seaTarget, 0.04);
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

/* Pour les tests : position écran d'un repère */
export function markerScreenPositions() {
  return markers.children.map(g => { const v = g.getWorldPosition(new THREE.Vector3()).project(camera); return { kind: g.userData.kind, id: g.userData.id, x: (v.x + 1) / 2 * window.innerWidth, y: (1 - v.y) / 2 * window.innerHeight }; });
}
