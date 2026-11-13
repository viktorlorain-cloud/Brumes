/* Affichage 3D du plateau (Three.js). Lit l'état, ne le modifie jamais. */
import * as THREE from 'three';
import { RES, RES_INFO, PIPS } from './engine.js';
import { iconImage } from './icons.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

let S = null;
const FOG_COL = new THREE.Color('#6d8594');
const SEA_BASE = new THREE.Color('#123447');
const TOP = 0.15;
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let renderer, scene, camera, sea, sun, world, markers, shallows, view = null, seaTarget = SEA_BASE.clone();
let extent = 4.33, extentZ = 4; // demi-largeur et demi-hauteur de l'île, recalculées à chaque plateau
let tapHandler = () => {};

export function initView(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.12; // couleurs plus riches, lumières plus douces
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false; // les ombres ne sont recalculées que quand quelque chose bouge sur l'île
  scene = new THREE.Scene();
  scene.background = new THREE.Color('#0e2533');
  scene.fog = new THREE.Fog('#0e2533', 13, 26);
  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  scene.add(new THREE.HemisphereLight('#d6ecff', '#1d2f3a', 1.0));
  sun = new THREE.DirectionalLight('#ffe3bd', 1.7);
  sun.position.set(4, 10, 5); sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 30 });
  scene.add(sun);
  sea = new THREE.Mesh(new THREE.CircleGeometry(40, 64), makeSeaMaterial());
  sea.rotation.x = -Math.PI / 2; sea.position.y = -0.22; scene.add(sea);
  shallows = new THREE.Mesh(new THREE.CircleGeometry(1, 64), new THREE.MeshStandardMaterial({ color: '#2a7186', roughness: 0.7, transparent: true, opacity: 0.75 }));
  shallows.rotation.x = -Math.PI / 2; shallows.position.y = -0.2; shallows.scale.setScalar(5.3); shallows.visible = false; // remplacé par la mer animée
  world = new THREE.Group(); scene.add(world);
  markers = new THREE.Group(); scene.add(markers);
  setupInput(canvas);
  window.addEventListener('resize', layoutCamera);
  window.visualViewport?.addEventListener('resize', layoutCamera); // barres de Safari, clavier, rotation
  window.addEventListener('orientationchange', () => setTimeout(layoutCamera, 250));
  if (window.ResizeObserver) new ResizeObserver(() => layoutCamera()).observe(canvas);
  layoutCamera();
  requestAnimationFrame(loop);
}
export function onTap(fn) { tapHandler = fn; }
let longPressHandler = () => {}, infoHandler = () => {};
export function onInfo(fn) { infoHandler = fn; }
export function onLongPress(fn) { longPressHandler = fn; }
/* Construction sous le doigt (appui long) : camp ou bastion le plus proche, sinon sentier */
function builtAt(x, y) {
  const p = groundAt(x, y, zoom, pan); if (!p || !S) return null;
  let best = null, bd = 0.3;
  for (const v of S.vertices) if (v.building) { const d = Math.hypot(v.x - p.x, v.z - p.z); if (d < bd) { bd = d; best = { kind: 'vertex', id: v.id }; } }
  if (best) return best;
  bd = 0.24;
  for (const e of S.edges) if (e.road != null) {
    const a = S.vertices[e.v[0]], b = S.vertices[e.v[1]], d = Math.hypot((a.x + b.x) / 2 - p.x, (a.z + b.z) / 2 - p.z);
    if (d < bd) { bd = d; best = { kind: 'edge', id: e.id }; }
  }
  return best;
}

/* Matériaux partagés : une couleur = un seul matériau (moins de changements d'état pour la carte graphique).
   Une couleur passée en objet THREE.Color donne un matériau propre, qu'on peut animer. */
const matCache = new Map();
const mat = (c, o = {}) => {
  if (typeof c !== 'string') return new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.85, ...o });
  const key = c + JSON.stringify(o, (k, v) => (v && v.isColor ? v.getHexString() : v));
  let m = matCache.get(key);
  if (!m) { m = new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.85, ...o }); m.userData.shared = true; matCache.set(key, m); }
  return m;
};
/* Fusionne les pièces fixes d'un groupe : une seule géométrie par matériau, donc un seul dessin.
   Les pièces marquées userData.keep (animées, à part) et les maillages instanciés restent tels quels. */
const _inv = new THREE.Matrix4(), _rel = new THREE.Matrix4();
const bakedMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85 }); bakedMat.userData.shared = true;
const _col = new THREE.Color();
/* bake : les pièces opaques de couleurs différentes deviennent une seule géométrie colorée par sommet
   (un dessin pour toute une construction au lieu d'un par couleur) */
function mergeStatic(root, bake = false) {
  root.updateMatrixWorld(true);
  _inv.copy(root.matrixWorld).invert();
  const buckets = new Map(), victims = [];
  root.traverse(o => {
    if (!o.isMesh || o.isInstancedMesh || o.userData.keep || o === root) return;
    let p = o.parent; while (p && p !== root) { if (p.userData.keep) return; p = p.parent; }
    const m0 = o.material;
    const bakeIt = bake && !m0.map && !m0.transparent && m0.side === THREE.FrontSide && m0.color;
    const key = bakeIt ? `bake|${o.castShadow ? 1 : 0}|${o.renderOrder}` : `${m0.uuid}|${o.castShadow ? 1 : 0}|${o.renderOrder}`;
    let geo = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    for (const name of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(name)) geo.deleteAttribute(name);
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    if (bake) {
      _col.copy(m0.color || _col.set('#ffffff'));
      if (m0.emissive) _col.add(m0.emissive.clone().multiplyScalar((m0.emissiveIntensity || 0) * 0.6));
      const n = geo.attributes.position.count, arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { arr[i * 3] = _col.r; arr[i * 3 + 1] = _col.g; arr[i * 3 + 2] = _col.b; }
      geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    }
    if (!geo.attributes.normal) geo.computeVertexNormals();
    geo.applyMatrix4(_rel.multiplyMatrices(_inv, o.matrixWorld));
    if (!buckets.has(key)) buckets.set(key, { mat: bakeIt ? bakedMat : o.material, cast: o.castShadow, order: o.renderOrder, geos: [] });
    buckets.get(key).geos.push(geo); victims.push(o);
  });
  for (const o of victims) { o.parent.remove(o); if (!o.geometry.userData.shared) o.geometry.dispose(); }
  for (const b of buckets.values()) {
    const merged = mergeGeometries(b.geos, false); b.geos.forEach(g => g.dispose());
    if (!merged) continue;
    const m = new THREE.Mesh(merged, b.mat); m.castShadow = b.cast; m.receiveShadow = true; m.renderOrder = b.order; root.add(m);
  }
  return root;
}
/* Libère la mémoire graphique d'un plateau qu'on remplace */
function disposeTree(root) {
  root.traverse(o => {
    if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of ms) { if (m.userData?.shared) continue; if (m.map) m.map.dispose(); m.dispose(); }
  });
}
function shadowed(m) { m.castShadow = true; m.receiveShadow = true; return m; }
function textTexture(draw, w = 128, h = 128) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; return tex;
}
const numberMats = new Map();
function numberMat(n) {
  if (!numberMats.has(n)) { const m = new THREE.MeshBasicMaterial({ map: numberTexture(n), transparent: true, toneMapped: false }); m.userData.shared = true; numberMats.set(n, m); }
  return numberMats.get(n);
}
export function refreshNumbers() { for (const [n, m] of numberMats) { m.map.dispose(); m.map = numberTexture(n); m.needsUpdate = true; } }
function numberTexture(n) {
  return textTexture((g, w, h) => {
    g.fillStyle = (n === 6 || n === 8) ? '#c8372d' : '#25323a';
    g.font = '600 62px Fredoka, Figtree, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(n), w / 2, h / 2 - 8);
    const p = PIPS(n);
    for (let i = 0; i < p; i++) { g.beginPath(); g.arc(w / 2 + (i - (p - 1) / 2) * 11, h / 2 + 30, 4, 0, Math.PI * 2); g.fill(); }
  });
}
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const redraw = () => { const g = c.getContext('2d'); g.clearRect(0, 0, w, h); draw(g, w, h); tex.needsUpdate = true; };
  redraw(); return { tex, redraw };
}
function whenIcon(name, fn) { const img = iconImage(name); if (!img.complete) img.addEventListener('load', fn, { once: true }); return img; }
/* Étiquette de port : pastille sombre, icône de la ressource (ou « 3:1 ») et taux */
function portSprite(type) {
  const img = type === '3:1' ? null : whenIcon(type, () => t.redraw());
  const t = canvasTex(176, 96, (g, w, h) => {
    g.fillStyle = 'rgba(10,22,30,0.88)'; g.beginPath(); g.roundRect(4, 8, w - 8, h - 16, 24); g.fill();
    g.strokeStyle = 'rgba(255,207,107,0.55)'; g.lineWidth = 3; g.stroke();
    g.textBaseline = 'middle'; g.font = '600 36px Fredoka, Figtree, system-ui, sans-serif';
    if (img) { if (img.complete) g.drawImage(img, 18, 18, 60, 60); g.fillStyle = '#ffcf6b'; g.textAlign = 'left'; g.fillText('2:1', 86, h / 2 + 1); }
    else { g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.fillText('3:1', w / 2, h / 2 + 1); }
  });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ toneMapped: false, map: t.tex, depthWrite: false, fog: false }));
  s.scale.set(0.82, 0.45, 1); return s;
}
function iconSprite(name, size = 0.42) {
  const img = whenIcon(name, () => t.redraw());
  const t = canvasTex(128, 128, (g, w, h) => { if (img.complete) g.drawImage(img, 4, 4, w - 8, h - 8); });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ toneMapped: false, map: t.tex, transparent: true, depthWrite: false, depthTest: false }));
  s.scale.set(size, size, 1); s.renderOrder = 5; return s;
}
function ringPos(i, n, rad, rot = 0) { const a = rot + i / n * Math.PI * 2; return [Math.cos(a) * rad, Math.sin(a) * rad]; }
function scaled(g, f) { const outer = new THREE.Group(); g.scale.setScalar(f); outer.add(g); outer.userData = g.userData; return outer; }

/* ---------- Décors ----------
   Chaque terrain se reconnaît d'un coup d'œil : forêt de sapins et tas de bûches, carrière de blocs taillés,
   champs de lin en fleurs bleues, champs de blé et moulin, montagnes à cristaux. Une pastille avec l'icône
   de la ressource est posée contre le jeton numéroté (elle reste cachée tant que la tuile est dans la brume). */
function at(obj, x, y, z, ry = 0) { obj.position.set(x, y, z); obj.rotation.y = ry; return obj; }
function slot(rad, a) { return [Math.cos(a) * rad, Math.sin(a) * rad]; }
function pine(s, col) {
  const g = new THREE.Group();
  g.add(at(shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.025 * s, 0.035 * s, 0.12 * s, 5), mat('#6b4a2e'))), 0, 0.06 * s, 0));
  g.add(at(shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.15 * s, 0.26 * s, 7), mat(col))), 0, 0.2 * s, 0));
  g.add(at(shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.11 * s, 0.22 * s, 7), mat(col))), 0, 0.32 * s, 0));
  return g;
}
/* Champ : terre labourée et rangs de tiges (instanciées pour rester léger) surmontées d'un épi ou d'une fleur */
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _sc = new THREE.Vector3();
function field(w, d, rows, cols, soil, stalkCol, head, headCol, h) {
  const g = new THREE.Group();
  g.add(at(shadowed(new THREE.Mesh(new THREE.BoxGeometry(w, 0.025, d), mat(soil))), 0, 0.012, 0));
  // Tiges et épis : une géométrie unique par champ (puis fusionnée avec tout le décor de l'île)
  const stalkBase = new THREE.CylinderGeometry(0.008, 0.012, h, 4).toNonIndexed(), headBase = head.index ? head.toNonIndexed() : head;
  const sGeos = [], hGeos = [];
  const stalks = { setMatrixAt: (i, m) => sGeos.push(stalkBase.clone().applyMatrix4(m)) };
  const heads = { setMatrixAt: (i, m) => hGeos.push(headBase.clone().applyMatrix4(m)) };
  let i = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++, i++) {
    const x = -w / 2 + (c + 0.5) * w / cols + (((r * 7 + c * 13) % 5) - 2) * 0.004, z = -d / 2 + (r + 0.5) * d / rows;
    const tilt = (((r * 5 + c * 3) % 7) - 3) * 0.05, hh = h * (0.85 + ((r + c) % 3) * 0.08);
    _e.set(tilt, 0, tilt * 0.6); _q.setFromEuler(_e); _sc.set(1, hh / h, 1);
    stalks.setMatrixAt(i, _m4.compose(_v.set(x, 0.025 + hh / 2, z), _q, _sc));
    _sc.set(1, 1, 1); heads.setMatrixAt(i, _m4.compose(_v.set(x + tilt * hh * 0.6, 0.025 + hh, z - tilt * hh * 0.4), _q, _sc));
  }
  const sm = shadowed(new THREE.Mesh(mergeGeometries(sGeos, false), mat(stalkCol)));
  const hm = shadowed(new THREE.Mesh(mergeGeometries(hGeos, false), mat(headCol, headCol.startsWith('#6') ? { emissive: '#1f3d7a', emissiveIntensity: 0.5 } : {})));
  [...sGeos, ...hGeos, stalkBase, headBase, head].forEach(x => x.dispose());
  g.add(sm, hm);
  return g;
}
const BADGE_Z = -0.42;
const badgeMats = new Map();
function resBadge(res) {
  const g = new THREE.Group();
  g.add(at(shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.04, 24), mat(RES_INFO[res].col, { flatShading: false }))), 0, 0.06, 0));
  g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.145, 0.145, 0.045, 24), mat('#f6eedc', { flatShading: false })), 0, 0.064, 0));
  const img = whenIcon(res, () => t.redraw());
  const t = canvasTex(128, 128, (c, w, h) => { if (img.complete) c.drawImage(img, 8, 8, w - 16, h - 16); });
  const ic = new THREE.Mesh(new THREE.PlaneGeometry(0.25, 0.25), new THREE.MeshBasicMaterial({ map: t.tex, transparent: true, toneMapped: false }));
  ic.rotation.x = -Math.PI / 2; ic.position.y = 0.088; g.add(ic);
  // Toujours visible : la pastille se dessine par-dessus le décor de sa tuile (matériaux partagés par ressource)
  g.children.forEach((m, i) => {
    const key = `${res}:${i}`;
    if (!badgeMats.has(key)) { const c = m.material.clone(); c.depthTest = false; c.userData.shared = true; badgeMats.set(key, c); }
    if (i === 2) m.material.map?.dispose();
    m.material = badgeMats.get(key); m.renderOrder = 6 + i; m.castShadow = false;
  });
  g.position.set(0, 0, BADGE_Z);
  return g;
}
function makeDecor(terrain, rot) {
  const g = new THREE.Group();
  if (terrain === 'bois') {
    // Forêt de sapins sur deux rangs, avec un tas de bûches
    for (let i = 0; i < 9; i++) {
      const a = rot + i / 9 * Math.PI * 2; if (Math.abs(Math.sin(a) + 1) < 0.18) continue;
      const [x, z] = slot(0.6 + (i % 2) * 0.12, a);
      g.add(at(pine(0.85 + ((i * 37) % 5) / 10, i % 3 ? '#2f6b3b' : '#3d8a4a'), x, 0, z));
    }
    const logs = new THREE.Group();
    [[-0.06, 0.04], [0.06, 0.04], [0, 0.11]].forEach(([x, y]) => logs.add(at(shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.26, 8), mat('#8a5a34'))), x, y, 0)));
    logs.children.forEach(l => { l.rotation.z = Math.PI / 2; });
    const [lx, lz] = slot(0.42, rot + 2.6); g.add(at(logs, lx, 0, lz, rot));
  } else if (terrain === 'pierre') {
    // Carrière : piles de blocs taillés, gros rochers et une paroi entaillée
    const block = (c) => shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.08, 0.1), mat(c)));
    for (let k = 0; k < 3; k++) {
      const [x, z] = slot(0.58, rot + k * 2.1);
      const pile = new THREE.Group();
      [[-0.075, 0.04, 0], [0.075, 0.04, 0], [0, 0.12, 0], [-0.075, 0.04, 0.11], [0.075, 0.04, 0.11]].forEach(([bx, by, bz], j) => pile.add(at(block(j % 2 ? '#d9cbb4' : '#c9b89c'), bx, by, bz)));
      g.add(at(pile, x, 0, z, rot + k));
    }
    for (let k = 0; k < 3; k++) {
      const [x, z] = slot(0.62, rot + 1.05 + k * 2.1);
      const r = shadowed(new THREE.Mesh(new THREE.DodecahedronGeometry(0.12 + (k % 2) * 0.04), mat('#8e8578')));
      g.add(at(r, x, 0.08, z, k)); r.scale.y = 0.75;
    }
  } else if (terrain === 'lin') {
    // Champs de lin : rangs de tiges vertes à fleurs bleues, et une botte liée
    for (let k = 0; k < 2; k++) {
      const a = rot + k * Math.PI, [x, z] = slot(0.55, a);
      const p = field(0.44, 0.3, 5, 9, '#6e5a3a', '#6f9a44', new THREE.SphereGeometry(0.02, 6, 4), '#6f9cff', 0.14);
      g.add(at(p, x, 0, z, -a + Math.PI / 2));
    }
    const [bx, bz] = slot(0.6, rot + Math.PI / 2);
    const bundle = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.26, 8), mat('#c9b07a')));
    g.add(at(bundle, bx, 0.13, bz));
    const tie = at(new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.012, 4, 10), mat('#7a5a30')), bx, 0.14, bz);
    tie.rotation.x = Math.PI / 2; g.add(tie);
  } else if (terrain === 'grain') {
    // Champs de blé dorés en rangs, meule de foin et petit moulin
    for (let k = 0; k < 2; k++) {
      const a = rot + k * 2.3, [x, z] = slot(0.56, a);
      const ear = new THREE.CapsuleGeometry(0.012, 0.035, 2, 4);
      g.add(at(field(0.44, 0.32, 6, 10, '#8a6a34', '#d9a83a', ear, k ? '#f6cf55' : '#ecc04a', 0.15), x, 0, z, -a + Math.PI / 2));
    }
    const [hx, hz] = slot(0.6, rot + 4.4);
    g.add(at(shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.22, 8), mat('#e8c25c'))), hx, 0.11, hz));
    const mill = new THREE.Group();
    mill.add(at(shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.3, 8), mat('#efe6d2'))), 0, 0.15, 0));
    mill.add(at(shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.12, 8), mat('#a2462e'))), 0, 0.36, 0));
    const blades = new THREE.Group(); blades.position.set(0, 0.28, 0.1);
    for (let i = 0; i < 4; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.2, 0.008), mat('#7a5a3a')); b.position.y = 0.1; const arm = new THREE.Group(); arm.rotation.z = i * Math.PI / 2 + 0.4; arm.add(b); blades.add(arm); }
    mill.add(blades);
    const [mx, mz] = slot(0.42, rot + 5.4); g.add(at(mill, mx, 0, mz, rot));
  } else if (terrain === 'cristal') {
    // Montagnes enneigées et grappes de cristaux lumineux
    [[0.58, rot], [0.62, rot + 2.2], [0.55, rot + 4.1]].forEach(([rad, a], i) => {
      const [x, z] = slot(rad, a), h = 0.42 + i * 0.09;
      g.add(at(shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.27, h, 5), mat('#6f7a8f'))), x, h / 2, z));
      g.add(at(new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.2, 5), mat('#eef3f8')), x, h - 0.08, z));
    });
    const cmat = mat('#7ff0ff', { emissive: '#1aa6c4', emissiveIntensity: 0.9, roughness: 0.2 });
    for (let k = 0; k < 3; k++) {
      const [x, z] = slot(0.6, rot + 1.1 + k * 2.1);
      for (let j = 0; j < 3; j++) {
        const c = shadowed(new THREE.Mesh(new THREE.OctahedronGeometry(0.06 + (j === 0) * 0.03), cmat));
        c.position.set(x + (j - 1) * 0.06, 0.1 + (j === 0) * 0.04, z + (j % 2) * 0.04); c.scale.y = 1.8; c.rotation.z = (j - 1) * 0.35; g.add(c);
      }
    }
  }
  // On écarte du décor l'emplacement de la pastille, pour qu'aucun élément ne la cache
  for (const c of g.children) {
    const dx = c.position.x, dz = c.position.z - BADGE_Z, d = Math.hypot(dx, dz);
    if (d < 0.34) { const k = 0.34 / Math.max(d, 0.01); c.position.x = dx * k || 0.34; c.position.z = BADGE_Z + dz * k; }
  }
  mergeStatic(g); // le décor fixe en quelques dessins seulement
  if (RES.includes(terrain)) g.add(resBadge(terrain));
  return g;
}
/* Brume : six nuages fusionnés en un seul maillage par tuile, qui flotte doucement */
function makeFog(rot) {
  const g = new THREE.Group(), parts = [];
  for (let i = 0; i < 6; i++) {
    const [x, z] = ringPos(i, 6, 0.58, rot);
    const sg = new THREE.SphereGeometry(0.24 + (i % 3) * 0.06, 8, 6).toNonIndexed(); sg.translate(x, 0.18, z); parts.push(sg);
  }
  const geo = mergeGeometries(parts, false); parts.forEach(p => p.dispose());
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#dbe7ee', emissive: '#4a6272', emissiveIntensity: 0.35, transparent: true, opacity: 0.78, roughness: 1, flatShading: true, depthWrite: false }));
  m.userData.phase = rot; g.add(m);
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
  beam.position.y = 1.08; beam.userData.keep = true; g.add(beam); g.userData.beam = beam;
  const halo = glowSprite('rgba(255,214,140,0.9)', 1.6); halo.position.y = 1.1; g.add(halo); g.userData.halo = halo;
  mergeStatic(g);
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
/* Contour sombre (coque inversée) : détache les bâtiments du terrain, même de loin */
const outlineMat = new THREE.MeshBasicMaterial({ color: '#0b1820', side: THREE.BackSide });
function outlined(mesh, k = 1.12) {
  const o = new THREE.Mesh(mesh.geometry, outlineMat); o.scale.setScalar(k); mesh.add(o); return mesh;
}
function gableRoof(w, h, d, color) {
  const shape = new THREE.Shape(); shape.moveTo(-w / 2, 0); shape.lineTo(w / 2, 0); shape.lineTo(0, h); shape.lineTo(-w / 2, 0);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false }); geo.translate(0, 0, -d / 2);
  return outlined(shadowed(new THREE.Mesh(geo, mat(color, { emissive: color, emissiveIntensity: 0.18 }))), 1.1);
}
function basePlate(color, r) {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.035, 24), mat(color, { emissive: color, emissiveIntensity: 0.35, flatShading: false }));
  ring.position.y = 0.018; g.add(ring);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(r, 0.012, 6, 32), new THREE.MeshBasicMaterial({ color: '#fff4dc' }));
  rim.rotation.x = Math.PI / 2; rim.position.y = 0.036; g.add(rim);
  return g;
}
function makeFlag(color, h) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, h, 4), mat('#3b2a1c')); pole.position.y = h / 2; g.add(pole);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.07), mat(color, { side: THREE.DoubleSide, emissive: color, emissiveIntensity: 0.35 }));
  flag.position.set(0.06, h - 0.04, 0); flag.userData.keep = true; g.add(flag); g.userData.flag = flag;
  return g;
}
/* Camp : une petite maison à toit en pente, aux couleurs du joueur */
function makeTent(color) {
  const g = new THREE.Group();
  g.add(basePlate(color, 0.2));
  const body = outlined(shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.15, 0.17), mat('#efe3c8'))), 1.1);
  body.position.y = 0.11; g.add(body);
  const roof = gableRoof(0.26, 0.15, 0.21, color); roof.position.y = 0.185; g.add(roof);
  const door = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.08), mat('#4a3322')); door.position.set(0, 0.075, 0.086); g.add(door);
  const win = new THREE.Mesh(new THREE.PlaneGeometry(0.04, 0.04), new THREE.MeshBasicMaterial({ color: '#ffd98a' })); win.position.set(0.1005, 0.12, 0); win.rotation.y = Math.PI / 2; g.add(win);
  const flag = makeFlag(color, 0.42); flag.position.set(-0.07, 0.03, -0.05); g.add(flag); g.userData.flag = flag.userData.flag;
  mergeStatic(g, true);
  return scaled(g, 1.55);
}
/* Bastion : une tour de pierre plus haute, toit et bannière aux couleurs du joueur */
function makeBastion(color) {
  const g = new THREE.Group();
  g.add(basePlate(color, 0.25));
  const base = outlined(shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.18, 0.38, 10), mat('#d9d0bc'))), 1.08);
  base.position.y = 0.21; g.add(base);
  for (let i = 0; i < 8; i++) { const [x, z] = ringPos(i, 8, 0.15); const m = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.05), mat('#cfc4ad'))); m.position.set(x, 0.43, z); g.add(m); }
  const roof = outlined(shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.26, 10), mat(color, { emissive: color, emissiveIntensity: 0.18 }))), 1.1);
  roof.position.y = 0.55; g.add(roof);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.162, 0.17, 0.05, 10), mat(color, { emissive: color, emissiveIntensity: 0.3 })); band.position.y = 0.2; g.add(band);
  const wing = outlined(shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.14, 0.14), mat('#e6dcc6'))), 1.1); wing.position.set(0.15, 0.09, 0.05); g.add(wing);
  const wroof = gableRoof(0.19, 0.09, 0.16, color); wroof.position.set(0.15, 0.16, 0.05); g.add(wroof);
  const flag = makeFlag(color, 0.3); flag.position.y = 0.66; g.add(flag); g.userData.flag = flag.userData.flag;
  mergeStatic(g, true);
  return scaled(g, 1.5);
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
  const geo = new THREE.BoxGeometry(len * 0.74, 0.07, 0.15); geo.translate(len * 0.37, 0, 0);
  const col = S.players[pid].col;
  const road = shadowed(new THREE.Mesh(geo, mat(col, { emissive: col, emissiveIntensity: 0.25 })));
  const edge = new THREE.Mesh(geo, outlineMat); edge.scale.set(1.02, 1.25, 1.35); road.add(edge);
  const dir = b.clone().sub(a).normalize();
  road.position.copy(a.clone().add(dir.clone().multiplyScalar(len * 0.13)));
  road.rotation.y = Math.atan2(-dir.z, dir.x);
  return road;
}

export function buildView(state) {
  S = state;
  extent = Math.max(...S.tiles.map(t => Math.abs(t.x))) + 0.87;
  extentZ = Math.max(...S.tiles.map(t => Math.abs(t.z))) + 1;
  shallows.scale.set(extent + 1, extentZ + 1, 1); // disque couché : son axe y suit la profondeur de l'île
  layoutCamera();
  disposeTree(world); world.clear(); markers.clear(); tweens.length = 0;
  shadowsDirty = 3;
  view = { portSpots: [], tiles: [], vertexObjs: new Map(), roadObjs: new Map(), robber: null, phare: null, gameId: S.gameId };
  const statics = []; // tout ce qui ne bouge plus : fusionné en quelques dessins à la fin
  const sandGeo = new THREE.CylinderGeometry(1.1, 1.16, 0.12, 6);
  for (const t of S.tiles) {
    const g = new THREE.Group(); g.position.set(t.x, 0, t.z);
    // Tuile visible : matériau partagé (fusionnable) ; tuile dans la brume : matériau propre, animé à la révélation
    const col = t.terrain === 'phare' ? '#cbbf9f' : (t.revealed ? RES_INFO[t.terrain].col : FOG_COL.clone());
    const base = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.965, 1.0, 0.3, 6), mat(col)));
    g.add(base);
    const rot = (t.id * 1.7) % (Math.PI * 2);
    const top = new THREE.Group(); top.position.y = TOP; g.add(top);
    let decor = null, fog = null;
    if (t.terrain === 'phare') { view.phare = makePhare(); top.add(view.phare); }
    else {
      decor = makeDecor(t.terrain, rot); top.add(decor);
      if (!t.revealed) { decor.scale.setScalar(0.001); decor.visible = false; fog = makeFog(rot); top.add(fog); }
    }
    if (t.number) {
      const token = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.05, 24), mat('#f4ead3', { flatShading: false }))); token.position.y = 0.03; top.add(token);
      const label = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), numberMat(t.number));
      label.rotation.x = -Math.PI / 2; label.position.y = 0.058; top.add(label);
      statics.push(token, label);
    }
    // Plage de sable sous chaque tuile : elle dessine le rivage et les joints entre les tuiles
    const sand = new THREE.Mesh(sandGeo, mat('#d9c18c')); sand.position.set(t.x, -0.14, t.z); sand.receiveShadow = true; world.add(sand); statics.push(sand);
    world.add(g);
    if (t.revealed || t.terrain === 'phare') statics.push(base);
    if (t.revealed && decor) statics.push(decor);
    view.tiles[t.id] = { group: g, base, decor, fog };
  }
  for (const p of S.ports) {
    const e = S.edges[p.edge], a = S.vertices[e.v[0]], b = S.vertices[e.v[1]], t = S.tiles[e.tiles[0]];
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const dir = new THREE.Vector2(mx - t.x, mz - t.z).normalize();
    const pier = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.5), mat('#8a6440')));
    pier.position.set(mx + dir.x * 0.25, -0.02, mz + dir.y * 0.25); pier.rotation.y = Math.atan2(dir.x, dir.y); world.add(pier); statics.push(pier);
    for (const v of [a, b]) {
      const plank = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.35), mat('#a07a50')));
      plank.position.set((v.x + mx + dir.x * 0.45) / 2, 0, (v.z + mz + dir.y * 0.45) / 2); plank.lookAt(mx + dir.x * 0.45, 0, mz + dir.y * 0.45); world.add(plank); statics.push(plank);
    }
    const lab = portSprite(p.type);
    lab.position.set(mx + dir.x * 0.78, 0.32, mz + dir.y * 0.78); world.add(lab);
    view.portSpots.push({ x: mx + dir.x * 0.55, z: mz + dir.y * 0.55, type: p.type });
  }
  // Fusion globale du décor fixe : tuiles visibles, jetons, numéros, pastilles, pontons
  const merged = new THREE.Group(); world.add(merged); world.updateMatrixWorld(true);
  for (const o of statics) merged.attach(o);
  mergeStatic(merged);
  for (const e of S.edges) if (e.road != null) { const r = roadMesh(e.id, e.road); world.add(r); view.roadObjs.set(e.id, r); }
  for (const v of S.vertices) if (v.building) {
    const o = v.building.type === 'bastion' ? makeBastion(S.players[v.building.owner].col) : makeTent(S.players[v.building.owner].col);
    o.position.copy(vpos(v.id, TOP)); world.add(o); view.vertexObjs.set(v.id, o);
  }
  view.robber = makeRobber(); world.add(view.robber); placeRobberAt(S.robber, false);
  buildSdf();
  view.motes = makeMotes(); world.add(view.motes);
  gulls.length = 0;
  for (let i = 0; i < 3; i++) { const gl = makeGull(); gl.userData = { a: i * 2.1, r: 1.6 + i * 0.9, h: 2.1 + i * 0.35, sp: 0.25 + i * 0.06 }; world.add(gl); gulls.push(gl); }
  placeBoats();
  setTide(S.tide?.type); renderSnow();
}
/* Tempête de neige : voile blanc sur les tuiles touchées et congères sur les chemins bloqués */
const snowMat = new THREE.MeshStandardMaterial({ color: '#f4f8ff', roughness: 1, transparent: true, opacity: 0.55, flatShading: true });
const drift = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, flatShading: true });
function renderSnow() {
  const key = S.snow ? S.snow.edges.join(',') : '';
  if (view.snowKey === key) return;
  if (view.snow) { world.remove(view.snow); view.snow = null; }
  view.snowKey = key;
  if (!S.snow) return;
  const g = new THREE.Group();
  for (const tid of S.snow.tiles) {
    const t = S.tiles[tid];
    const veil = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.04, 6), snowMat);
    veil.position.set(t.x, TOP + 0.06, t.z); g.add(veil);
  }
  for (const eid of S.snow.edges) {
    const e = S.edges[eid], a = S.vertices[e.v[0]], b = S.vertices[e.v[1]];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const bank = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, len * 0.7, 3, 6), drift);
    bank.rotation.z = Math.PI / 2; bank.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
    bank.position.set((a.x + b.x) / 2, TOP + 0.08, (a.z + b.z) / 2); bank.castShadow = true; g.add(bank);
  }
  view.snow = g; world.add(g);
}
export const viewGameId = () => view?.gameId;
export function setState(state) { S = state; }
export function setTide(type) {
  const col = { abondance: '#1f5a4a', disette: '#3a3a35', haut: '#4a4220', bas: '#2f2a48', tempete: '#3c5566' }[type];
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
    const fog = v.fog; v.lifting = true; if (v.decor) v.decor.visible = true;
    tween(0.8, k => {
      v.base.material.color.lerpColors(from, to, k);
      if (fog) fog.children.forEach(m => { m.material.opacity = 0.78 * (1 - k); m.position.y = k * 0.5; m.scale.setScalar(1 + k * 0.5); });
      v.decor.scale.setScalar(Math.max(0.001, backOut(Math.min(1, k * 1.3))));
    }, () => { if (fog && fog.parent) fog.parent.remove(fog); v.fog = null; }, 0.35 + i * 0.12);
  });
}
function animateProduction(gains, delay) {
  gains.forEach((g, i) => {
    const t = S.tiles[g.tile];
    for (let j = 0; j < g.n; j++) {
      const s = iconSprite(g.res); s.visible = false; world.add(s);
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
  setTide(S.tide?.type); renderSnow();
}

/* ---------- Repères d'interaction ---------- */
const hitMat = new THREE.MeshBasicMaterial({ visible: false });
const glow = new THREE.MeshBasicMaterial({ color: '#fff3c4', transparent: true, opacity: 0.95, toneMapped: false, depthTest: false }); // les emplacements restent bien vifs
const glowEdge = new THREE.MeshBasicMaterial({ color: '#10202b', transparent: true, opacity: 0.7, toneMapped: false, depthTest: false });
/* Emplacements lumineux : une zone de toucher invisible par emplacement, et un seul dessin
   (maillage instancié) par forme, quel que soit leur nombre. */
/* Chaque emplacement a un contour sombre dessous et une forme claire dessus : il ressort sur toutes les
   couleurs de terrain, et il se dessine par-dessus le décor pour ne jamais être caché. */
const markerGeo = {
  ring: new THREE.RingGeometry(0.09, 0.17, 28).rotateX(-Math.PI / 2),
  dot: new THREE.CircleGeometry(0.065, 20).rotateX(-Math.PI / 2),
  bar: new THREE.BoxGeometry(0.6, 0.04, 0.12),
  hex: new THREE.RingGeometry(0.76, 0.9, 6, 1, Math.PI / 2).rotateX(-Math.PI / 2),
  ringO: new THREE.RingGeometry(0.06, 0.21, 28).rotateX(-Math.PI / 2),
  barO: new THREE.BoxGeometry(0.68, 0.03, 0.2),
  hexO: new THREE.RingGeometry(0.72, 0.94, 6, 1, Math.PI / 2).rotateX(-Math.PI / 2),
  hitV: new THREE.SphereGeometry(0.3, 8, 6), hitE: new THREE.BoxGeometry(0.75, 0.3, 0.38), hitT: new THREE.CylinderGeometry(0.85, 0.85, 0.5, 6),
};
Object.values(markerGeo).forEach(g => { g.userData.shared = true; });
export function showMarkers(kind, ids, append = false) {
  if (!append) clearMarkers();
  for (const id of ids) {
    const g = new THREE.Group(); g.userData = { kind, id };
    if (kind === 'vertex') {
      const v = S.vertices[id];
      g.add(new THREE.Mesh(markerGeo.hitV, hitMat)); g.position.set(v.x, TOP + 0.08, v.z); g.userData.vis = ['ring', 'dot'];
    } else if (kind === 'edge') {
      const e = S.edges[id], a = S.vertices[e.v[0]], b = S.vertices[e.v[1]];
      g.add(new THREE.Mesh(markerGeo.hitE, hitMat));
      g.position.set((a.x + b.x) / 2, TOP + 0.07, (a.z + b.z) / 2); g.rotation.y = Math.atan2(-(b.z - a.z), b.x - a.x); g.userData.vis = ['bar'];
    } else if (kind === 'tile') {
      const t = S.tiles[id];
      g.add(new THREE.Mesh(markerGeo.hitT, hitMat)); g.position.set(t.x, TOP + 0.04, t.z); g.userData.vis = ['hex'];
    }
    markers.add(g);
  }
  // Dessins instanciés, refaits à partir de tous les emplacements affichés
  for (const o of markers.children.filter(o => o.isInstancedMesh)) { markers.remove(o); o.dispose(); }
  const groups = markers.children.filter(o => o.userData.vis);
  const outlineOf = { ring: 'ringO', bar: 'barO', hex: 'hexO' };
  for (const shape of ['ring', 'dot', 'bar', 'hex']) {
    const list = groups.filter(o => o.userData.vis.includes(shape)); if (!list.length) continue;
    for (const [geo, material, order] of [[outlineOf[shape], glowEdge, 20], [shape, glow, 21]]) {
      if (!geo) continue;
      const inst = new THREE.InstancedMesh(markerGeo[geo], material, list.length);
      list.forEach((o, i) => { o.updateMatrix(); inst.setMatrixAt(i, o.matrix); });
      inst.raycast = () => {}; inst.frustumCulled = false; inst.renderOrder = order; markers.add(inst);
    }
  }
}
export function clearMarkers() { for (const o of markers.children) if (o.isInstancedMesh) o.dispose(); markers.clear(); }

/* ---------- Caméra et gestes ----------
   La caméra suit des valeurs cibles avec amortissement : le zoom et le
   déplacement glissent au lieu de sauter. Le pincement zoome autour du point
   situé sous les doigts, le glissé garde de l'élan, le double-tap zoome. */
const ZMIN = 0.42, ZMAX = 1.15;
let zoom = 1, zoomT = 1;
const pan = new THREE.Vector2(0, 0), panT = new THREE.Vector2(0, 0), vel = new THREE.Vector2(0, 0);
let dragging = false;
const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const probeCam = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
function placeCamera(cam, z, p) {
  const need = 2 * extent + (cam.aspect < 0.75 ? 0.75 : 2.5);
  const vfov = THREE.MathUtils.degToRad(cam.fov);
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * cam.aspect);
  const needZ = (2 * extentZ + 0.4) / (cam.aspect < 0.75 ? 0.74 : 0.9); // place pour les fiches en haut et la barre en bas
  const dist = Math.max((need / 2) / Math.tan(hfov / 2), (Math.max(need * 0.95, needZ) / 2) / Math.tan(vfov / 2)) * z;
  const tilt = THREE.MathUtils.degToRad(63);
  cam.position.set(p.x, Math.sin(tilt) * dist, p.y + 0.35 + Math.cos(tilt) * dist);
  cam.lookAt(p.x, 0, p.y + 0.35);
  cam.updateProjectionMatrix(); cam.updateMatrixWorld();
  return dist;
}
/* Taille et position réelles du plateau à l'écran. Sur iPhone, window.innerWidth/innerHeight bougent avec
   les barres de Safari et le zoom de page : on se fie toujours au rectangle du canvas, sinon les touchers
   tombent à côté des emplacements. */
let viewRect = { left: 0, top: 0, width: 1, height: 1 };
function measure() { const r = renderer.domElement.getBoundingClientRect(); if (r.width > 0 && r.height > 0) viewRect = r; return viewRect; }
const toNdc = (x, y, out) => { const r = viewRect; return out.set((x - r.left) / r.width * 2 - 1, -((y - r.top) / r.height) * 2 + 1); };
export function relayout() { if (renderer) layoutCamera(); }
function layoutCamera() {
  const r = measure(), w = Math.round(r.width), h = Math.round(r.height);
  renderer.setSize(w, h, false); camera.aspect = w / h; probeCam.aspect = camera.aspect;
  const dist = placeCamera(camera, zoom, pan);
  scene.fog.near = dist * 1.05 / zoom; scene.fog.far = dist * 2.4 / zoom;
}
/* Point du sol (y = 0) sous une position d'écran, pour une caméra donnée */
const _ray = new THREE.Raycaster(), _ndc = new THREE.Vector2(), _hit = new THREE.Vector3();
function groundAt(x, y, z = zoomT, p = panT) {
  placeCamera(probeCam, z, p);
  toNdc(x, y, _ndc);
  _ray.setFromCamera(_ndc, probeCam);
  return _ray.ray.intersectPlane(ground, _hit) ? _hit.clone() : null;
}
function clampPan(v) {
  const lim = 0.25 + Math.max(extent, extentZ) * (1 - Math.min(1, zoomT)) * 1.35;
  v.x = THREE.MathUtils.clamp(v.x, -lim, lim); v.y = THREE.MathUtils.clamp(v.y, -lim, lim);
}
/* Zoome vers zoomNew en gardant fixe le point du plateau situé sous (x, y) */
function zoomAround(x, y, zoomNew) {
  const before = groundAt(x, y);
  zoomT = THREE.MathUtils.clamp(zoomNew, ZMIN, ZMAX);
  const after = groundAt(x, y);
  if (before && after) { panT.x += before.x - after.x; panT.y += before.z - after.z; }
  if (zoomT >= 0.99) panT.multiplyScalar(0.5);
  clampPan(panT);
}
export function resetCamera() { zoom = zoomT = 1; pan.set(0, 0); panT.set(0, 0); vel.set(0, 0); layoutCamera(); }
function updateCamera(dt) {
  if (!dragging && vel.lengthSq() > 1e-6) {
    panT.addScaledVector(vel, dt); clampPan(panT);
    vel.multiplyScalar(Math.exp(-dt * 6));
  }
  const k = 1 - Math.exp(-dt * 14);
  const dz = zoomT - zoom, dp = pan.distanceToSquared(panT);
  if (Math.abs(dz) < 1e-4 && dp < 1e-7) return false;
  zoom += dz * k; pan.lerp(panT, k);
  const dist = placeCamera(camera, zoom, pan);
  scene.fog.near = dist * 1.05 / zoom; scene.fog.far = dist * 2.4 / zoom;
  return true;
}
function setupInput(canvas) {
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), pointers = new Map();
  let downAt = null, moved = false, pinch = null, lastMove = 0, lastTap = { t: 0, x: 0, y: 0 }, longTimer = 0, longFired = false;
  const mid = () => { const [a, b] = [...pointers.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }; };
  canvas.addEventListener('pointerdown', e => {
    measure();
    canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    vel.set(0, 0); dragging = true;
    if (pointers.size === 1) {
      downAt = { x: e.clientX, y: e.clientY, t: performance.now() }; moved = false; longFired = false;
      clearTimeout(longTimer);
      longTimer = setTimeout(() => {
        if (moved || pointers.size !== 1) return;
        const hit = builtAt(downAt.x, downAt.y);
        if (hit) { longFired = true; longPressHandler(hit.kind, hit.id, downAt.x, downAt.y); }
      }, 450);
    }
    if (pointers.size > 1) clearTimeout(longTimer);
    if (pointers.size === 2) { const m = mid(); pinch = { d: m.d, z: zoomT, x: m.x, y: m.y }; moved = true; }
  });
  canvas.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinch) {
      const m = mid();
      // Glissé à deux doigts + pincement, autour du point sous les doigts
      const a = groundAt(pinch.x, pinch.y), b = groundAt(m.x, m.y);
      if (a && b) { panT.x += a.x - b.x; panT.y += a.z - b.z; }
      zoomAround(m.x, m.y, pinch.z * pinch.d / Math.max(1, m.d));
      pinch.x = m.x; pinch.y = m.y;
      return;
    }
    if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 8) moved = true;
    if (moved && pointers.size === 1) {
      const a = groundAt(prev.x, prev.y), b = groundAt(e.clientX, e.clientY);
      if (!a || !b) return;
      const dx = a.x - b.x, dz = a.z - b.z;
      panT.x += dx; panT.y += dz; clampPan(panT);
      const now = performance.now(), dt = Math.max(8, now - lastMove) / 1000; lastMove = now;
      vel.set(dx / dt, dz / dt).multiplyScalar(0.8);
    }
  });
  const end = e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 1) { const [p] = pointers.values(); downAt = { x: p.x, y: p.y, t: performance.now() }; }
    if (pointers.size === 0) { dragging = false; if (performance.now() - lastMove > 80) vel.set(0, 0); }
    return pointers.size === 0;
  };
  canvas.addEventListener('pointerup', e => {
    clearTimeout(longTimer);
    if (!end(e) || moved || longFired) return;
    // Toucher simple : un emplacement lumineux d'abord
    if (markers.children.length) {
      measure(); toNdc(e.clientX, e.clientY, ndc);
      camera.updateMatrixWorld(); markers.updateMatrixWorld(true);
      ray.setFromCamera(ndc, camera);
      const hits = ray.intersectObjects(markers.children, true);
      if (hits.length) { let o = hits[0].object; while (o && !o.userData.kind) o = o.parent; if (o) { tapHandler(o.userData.kind, o.userData.id); lastTap.t = 0; return; } }
    }
    // Toucher un port ou le Phare : petite explication
    const gp = groundAt(e.clientX, e.clientY, zoom, pan);
    if (gp && S && view) {
      let best = null, bd = 0.42;
      for (const p of view.portSpots) { const d = Math.hypot(p.x - gp.x, p.z - gp.z); if (d < bd) { bd = d; best = p; } }
      const c = S.tiles[S.center];
      const piece = builtAt(e.clientX, e.clientY);
      if (piece) { longPressHandler(piece.kind, piece.id, e.clientX, e.clientY); lastTap.t = 0; return; }
      if (best) infoHandler('port', best.type, e.clientX, e.clientY);
      else if (c && Math.hypot(c.x - gp.x, c.z - gp.z) < 0.5) infoHandler('phare', null, e.clientX, e.clientY);
      else if (seaTap(gp)) { lastTap.t = 0; return; }
    }
    // Double-tap ailleurs : zoom avant ou retour à la vue d'ensemble
    const now = performance.now();
    if (now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
      if (zoomT > 0.8) zoomAround(e.clientX, e.clientY, 0.55); else { zoomT = 1; panT.set(0, 0); }
      lastTap.t = 0;
    } else lastTap = { t: now, x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointercancel', e => { clearTimeout(longTimer); end(e); });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', e => { e.preventDefault(); zoomAround(e.clientX, e.clientY, zoomT * Math.exp(e.deltaY * 0.0015)); }, { passive: false });
}


/* ---------- Mer ----------
   Un seul dessin pour toute la mer : couleur des fonds selon la distance à la côte (carte des distances
   calculée une fois par île), vaguelettes animées, reflets du soleil, écume qui ourle la côte. */
const seaUniforms = {
  uTime: { value: 0 }, uDeep: { value: SEA_BASE.clone() }, uShallow: { value: new THREE.Color('#237891') },
  uSdf: { value: null }, uHalf: { value: 12 }, uSun: { value: new THREE.Vector3(4, 10, 5).normalize() },
};
function makeSeaMaterial() {
  const m = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]), fog: true,
    vertexShader: `
      varying vec3 vWorld;
      #include <fog_pars_vertex>
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0); vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp; gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform float uTime; uniform vec3 uDeep; uniform vec3 uShallow; uniform sampler2D uSdf; uniform float uHalf; uniform vec3 uSun;
      varying vec3 vWorld;
      #include <fog_pars_fragment>
      float waves(vec2 p, float t) {
        return sin(p.x * 1.9 + t * 0.9 + sin(p.y * 1.2 + t * 0.35) * 1.4) * sin(p.y * 1.6 - t * 0.7)
             + 0.45 * sin((p.x + p.y) * 3.3 + t * 1.5) + 0.25 * sin((p.x - p.y * 0.6) * 6.1 - t * 2.1);
      }
      void main() {
        vec2 p = vWorld.xz; float t = uTime;
        vec2 uv = p / (2.0 * uHalf) + 0.5;
        float dl = texture2D(uSdf, uv).r * 4.0; // distance à la côte, en unités du plateau
        float shallow = 1.0 - smoothstep(0.05, 1.9, dl);
        vec3 col = mix(uDeep, uShallow, shallow * 0.9);
        // relief des vagues : normale approchée pour la lumière et les reflets
        float e = 0.08, w = waves(p, t);
        vec3 n = normalize(vec3(waves(p - vec2(e, 0.0), t) - waves(p + vec2(e, 0.0), t), 9.0, waves(p - vec2(0.0, e), t) - waves(p + vec2(0.0, e), t)));
        vec3 v = normalize(cameraPosition - vWorld);
        float spec = pow(max(dot(reflect(-uSun, n), v), 0.0), 160.0);
        float fres = pow(1.0 - max(v.y, 0.0), 3.0);
        col += vec3(0.75, 0.9, 1.0) * smoothstep(1.0, 1.6, w) * 0.05 * (0.4 + shallow);
        col += vec3(1.0, 0.92, 0.75) * spec * 0.35;
        col = mix(col, col * 1.15 + 0.02, fres * 0.15);
        // écume : un liseré contre la côte et des vagues qui s'éloignent
        float foamEdge = smoothstep(0.2, 0.03, dl) * (0.55 + 0.45 * sin(dl * 34.0 - t * 2.6 + w * 1.5));
        float ring = smoothstep(0.04, 0.0, abs(fract(dl * 1.6 - t * 0.22) - 0.5) - 0.46) * smoothstep(0.9, 0.15, dl) * 0.3;
        col = mix(col, vec3(0.9, 0.96, 1.0), clamp(foamEdge * 0.55 + ring * 0.7 * (0.5 + 0.5 * sin(p.x * 3.0 + p.y * 2.0)), 0.0, 1.0));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  Object.assign(m.uniforms, seaUniforms);
  return m;
}
/* Carte des distances à la côte (une texture 128 x 128 calculée à la construction de l'île) */
function buildSdf() {
  const N = 128, half = Math.max(extent, extentZ) + 5, data = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = (i + 0.5) / N * 2 * half - half, z = (j + 0.5) / N * 2 * half - half;
    let d = 99;
    for (const t of S.tiles) { const dd = Math.hypot(x - t.x, z - t.z) - 0.93; if (dd < d) d = dd; }
    const v = Math.round(Math.min(1, Math.max(0, d) / 4) * 255), k = (j * N + i) * 4;
    data[k] = data[k + 1] = data[k + 2] = v; data[k + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat); tex.magFilter = tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
  seaUniforms.uSdf.value?.dispose(); seaUniforms.uSdf.value = tex; seaUniforms.uHalf.value = half;
}
/* Lueur du phare, poussière lumineuse et mouettes */
function glowSprite(color, size) {
  const t = canvasTex(64, 64, (g, w, h) => { const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2); r.addColorStop(0, color); r.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = r; g.fillRect(0, 0, w, h); });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ toneMapped: false, map: t.tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  s.scale.set(size, size, 1); return s;
}
function makeMotes() {
  const n = 46, pos = new Float32Array(n * 3), R = Math.max(extent, extentZ);
  for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * R; pos.set([Math.cos(a) * r * (extent / R), 0.4 + Math.random() * 1.4, Math.sin(a) * r * (extentZ / R)], i * 3); }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const t = canvasTex(32, 32, (g, w, h) => { const r = g.createRadialGradient(16, 16, 0, 16, 16, 16); r.addColorStop(0, 'rgba(255,230,170,1)'); r.addColorStop(1, 'rgba(255,230,170,0)'); g.fillStyle = r; g.fillRect(0, 0, w, h); });
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.09, map: t.tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.8 }));
  pts.userData.base = pos.slice(); return pts;
}
function makeGull() {
  const g = new THREE.Group(), m = mat('#f4f6f8', { side: THREE.DoubleSide });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.07, 2, 6), m); body.rotation.z = Math.PI / 2; g.add(body);
  for (const sgn of [-1, 1]) {
    const shape = new THREE.Shape(); shape.moveTo(0, 0); shape.lineTo(-0.03, 0.15 * sgn); shape.lineTo(0.035, 0.02 * sgn);
    const wing = new THREE.Mesh(new THREE.ShapeGeometry(shape), m); wing.rotation.x = -Math.PI / 2; const pivot = new THREE.Group(); pivot.add(wing); pivot.userData.sgn = sgn; g.add(pivot);
  }
  g.scale.setScalar(1.6); return g;
}
const gulls = [];

/* ---------- Vie marine : bateaux de pêche, dauphins, poissons ----------
   Deux bateaux font le tour de l'île, des dauphins sautent de temps en temps.
   Toucher la mer fait sauter un dauphin ; toucher un bateau, il tangue et un poisson s'échappe. */
const SEA_Y = -0.2;
function makeBoat(col) {
  const g = new THREE.Group();
  const hull = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.1, 0.18), mat('#8a5a34')));
  hull.position.y = 0.04; g.add(hull);
  const bow = shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.16, 4), mat('#8a5a34')));
  bow.rotation.z = -Math.PI / 2; bow.rotation.x = Math.PI / 4; bow.position.set(0.3, 0.04, 0); bow.scale.set(1, 1, 0.75); g.add(bow);
  const rim = new THREE.Mesh(new THREE.BoxGeometry(0.47, 0.025, 0.19), mat(col)); rim.position.y = 0.1; g.add(rim);
  const cabin = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.1, 0.12), mat('#f2ede2'))); cabin.position.set(-0.1, 0.16, 0); g.add(cabin);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.025, 0.14), mat(col)); roof.position.set(-0.1, 0.22, 0); g.add(roof);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.36, 4), mat('#3b2a1c')); mast.position.set(0.07, 0.28, 0); g.add(mast);
  const sailShape = new THREE.Shape(); sailShape.moveTo(0, 0); sailShape.lineTo(0, 0.28); sailShape.lineTo(0.16, 0); sailShape.lineTo(0, 0);
  const sail = new THREE.Mesh(new THREE.ShapeGeometry(sailShape), mat('#fff8ec', { side: THREE.DoubleSide })); sail.position.set(0.08, 0.13, 0); g.add(sail);
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.3, 3), mat('#3b2a1c')); rod.position.set(-0.22, 0.17, 0.05); rod.rotation.z = 0.9; g.add(rod);
  mergeStatic(g, true); g.traverse(o => { o.castShadow = false; }); // en mouvement : pas d'ombre figée
  g.scale.setScalar(1.4);
  return g;
}
function makeDolphin() {
  const g = new THREE.Group();
  const body = shadowed(new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.26, 4, 8), mat('#5f8fb0', { flatShading: false })));
  body.rotation.z = Math.PI / 2; g.add(body);
  const belly = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.2, 4, 8), mat('#dfeaf2', { flatShading: false }));
  belly.rotation.z = Math.PI / 2; belly.position.y = -0.025; g.add(belly);
  const fin = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.09, 4), mat('#5f8fb0')); fin.position.set(-0.01, 0.07, 0); fin.rotation.z = -0.4; g.add(fin);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.06, 4), mat('#5f8fb0')); tail.position.set(-0.21, 0, 0); tail.rotation.z = Math.PI / 2; tail.scale.set(1, 1, 0.3); g.add(tail);
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.03, 0.06, 6), mat('#5f8fb0')); nose.rotation.z = -Math.PI / 2; nose.position.set(0.2, -0.01, 0); g.add(nose);
  mergeStatic(g); g.traverse(o => { o.castShadow = false; });
  g.scale.setScalar(1.7);
  return g;
}
function makeFish() {
  const g = new THREE.Group();
  const b = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), mat('#ff9a3c')); b.scale.set(1.6, 1, 0.6); g.add(b);
  const t = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.05, 4), mat('#ff9a3c')); t.rotation.z = Math.PI / 2; t.position.x = -0.07; g.add(t);
  return g;
}
const splashMat = new THREE.MeshBasicMaterial({ color: '#e8f6ff', transparent: true, opacity: 0.8, depthWrite: false });
function splash(x, z, size = 1) {
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.09, 20), splashMat.clone());
  ring.rotation.x = -Math.PI / 2; ring.position.set(x, SEA_Y + 0.03, z); world.add(ring);
  const drops = [];
  for (let i = 0; i < 6; i++) { const d = new THREE.Mesh(new THREE.SphereGeometry(0.018, 5, 4), splashMat); d.position.set(x, SEA_Y + 0.05, z); d.userData.v = [(Math.random() - 0.5) * 0.8, 1 + Math.random(), (Math.random() - 0.5) * 0.8]; world.add(d); drops.push(d); }
  tween(0.8, k => {
    ring.scale.setScalar((1 + k * 4) * size); ring.material.opacity = 0.8 * (1 - k);
    for (const d of drops) { const [vx, vy, vz] = d.userData.v, t = k * 0.6; d.position.set(x + vx * t * size, SEA_Y + 0.05 + (vy * t - 2.6 * t * t) * size, z + vz * t * size); }
  }, () => { world.remove(ring); ring.material.dispose(); drops.forEach(d => world.remove(d)); });
}
/* Saut en arc : départ et arrivée dans l'eau, le corps suit la courbe */
function leap(obj, x, z, dir, len = 1.4, h = 0.75, dur = 1.25) {
  const dx = Math.cos(dir), dz = Math.sin(dir);
  obj.rotation.set(0, -dir, 0); world.add(obj);
  splash(x, z, 0.8);
  tween(dur, k => {
    const px = x + dx * len * k, pz = z + dz * len * k, py = SEA_Y - 0.05 + Math.sin(k * Math.PI) * h;
    obj.position.set(px, py, pz);
    obj.rotation.z = Math.cos(k * Math.PI) * 0.9; // nez vers le haut puis vers le bas
  }, () => { world.remove(obj); splash(x + dx * len, z + dz * len, 0.9); });
}
export function dolphinAt(x, z, dir = Math.random() * Math.PI * 2, pair = Math.random() < 0.5) {
  leap(makeDolphin(), x - Math.cos(dir) * 0.55, z - Math.sin(dir) * 0.55, dir);
  if (pair) setTimeout(() => leap(makeDolphin(), x - Math.cos(dir) * 0.35 + 0.18, z - Math.sin(dir) * 0.35 + 0.18, dir, 1, 0.45, 1.05), 260);
}
const boats = [];
function placeBoats() {
  boats.length = 0;
  ['#c8402f', '#2f7fb8'].forEach((col, i) => {
    const b = makeBoat(col); b.userData = { a: i * Math.PI + 0.6, speed: 0.045 + i * 0.012, hop: 0 };
    world.add(b); boats.push(b);
  });
}
function seaRadius() { return { rx: extent + 0.9, rz: extentZ + 0.7 }; }
function updateSeaLife(dt, time) {
  const { rx, rz } = seaRadius();
  for (const b of boats) {
    const u = b.userData; u.a += u.speed * dt;
    const x = Math.cos(u.a) * rx, z = Math.sin(u.a) * rz;
    b.position.set(x, SEA_Y + 0.01 + Math.sin(time * 1.6 + u.a * 7) * 0.012 + Math.sin(u.hop * Math.PI) * 0.18, z);
    b.rotation.y = -Math.atan2(Math.cos(u.a) * rz, -Math.sin(u.a) * rx);
    b.rotation.x = Math.sin(time * 1.3 + u.a) * 0.06 + Math.sin(u.hop * Math.PI * 3) * 0.25 * (u.hop > 0 ? 1 : 0);
    if (u.hop > 0) u.hop = Math.max(0, u.hop - dt / 0.9);
  }
  // Un dauphin de temps en temps, quelque part autour de l'île
  nextDolphin -= dt;
  if (nextDolphin <= 0 && !document.hidden) {
    nextDolphin = 7 + Math.random() * 8;
    const a = Math.random() * Math.PI * 2, k = 1.05 + Math.random() * 0.35;
    dolphinAt(Math.cos(a) * (rx + 0.3) * k, Math.sin(a) * (rz + 0.3) * k);
  }
}
let nextDolphin = 4;
/* Toucher la mer : bateau touché → il tangue et un poisson saute ; sinon un dauphin */
/* Les animations déclenchées par un joueur sont envoyées aux autres : tout le monde voit le même dauphin */
let fxHandler = () => {};
export function onSeaFx(fn) { fxHandler = fn; }
export function playSeaFx(fx) {
  if (!S || !view) return;
  if (fx.k === 'boat') {
    const b = boats[fx.i]; if (!b) return;
    b.userData.hop = 1; splash(b.position.x, b.position.z, 1.2);
    leap(makeFish(), b.position.x + Math.cos(fx.dir) * 0.2, b.position.z + Math.sin(fx.dir) * 0.2, fx.dir, 0.5, 0.4, 0.8);
  } else if (fx.k === 'dolphin') dolphinAt(fx.x, fx.z, fx.dir, fx.pair);
}
function seaTap(p) {
  if (!S) return false;
  if (S.tiles.some(t => Math.hypot(t.x - p.x, t.z - p.z) < 0.95)) return false;
  let fx = null;
  boats.forEach((b, i) => { if (!fx && Math.hypot(b.position.x - p.x, b.position.z - p.z) < 0.45) fx = { k: 'boat', i, dir: Math.random() * Math.PI * 2 }; });
  if (!fx) fx = { k: 'dolphin', x: +p.x.toFixed(2), z: +p.z.toFixed(2), dir: +(Math.random() * Math.PI * 2).toFixed(2), pair: Math.random() < 0.5 };
  playSeaFx(fx); fxHandler(fx);
  return true;
}

/* Qualité adaptative : si le téléphone peine, on baisse la résolution, puis les ombres */
let frames = 0, frameTime = 0, quality = 0;
function adaptQuality(dt) {
  frames++; frameTime += dt;
  if (frameTime < 2.5) return;
  const avg = frameTime / frames; frames = 0; frameTime = 0;
  if (avg > 0.03 && quality < 3) {
    quality++;
    if (quality === 1) renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    else if (quality === 2) { renderer.setPixelRatio(1); }
    else { renderer.shadowMap.enabled = false; scene.traverse(o => { if (o.material) o.material.needsUpdate = true; }); }
    layoutCamera();
  }
}

/* ---------- Boucle de rendu ---------- */
const clock = new THREE.Clock();
let shadowsDirty = 3, idleFrame = 0, lastInput = 0;
window.addEventListener('pointerdown', () => { lastInput = performance.now(); }, { capture: true, passive: true });
function loop() {
  const raw = clock.getDelta(), dt = Math.min(raw, 0.05), time = clock.elapsedTime;
  const moving = updateCamera(dt);
  if (!document.hidden) adaptQuality(raw);
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i]; tw.t += dt; if (tw.t < 0) continue;
    const k = Math.min(1, tw.t / tw.dur); tw.update(k);
    if (k >= 1) { tweens.splice(i, 1); tw.done && tw.done(); }
  }
  if (view) {
    if (view.phare) view.phare.userData.beam.rotation.y = time * 0.7;
    for (const t of view.tiles) if (t?.fog && !t.lifting) { const m = t.fog.children[0]; m.position.y = Math.sin(time * 0.8 + m.userData.phase) * 0.03; m.rotation.y = Math.sin(time * 0.1 + m.userData.phase) * 0.15; }
    for (const o of view.vertexObjs.values()) if (o.userData.flag) o.userData.flag.rotation.y = Math.sin(time * 3 + o.position.x) * 0.35;
    view.robber.rotation.y = Math.sin(time * 0.6) * 0.4;
    updateSeaLife(dt, time);
    // Poussière lumineuse qui flotte, mouettes qui tournent, halo du phare qui respire
    if (view.motes) { const a = view.motes.geometry.attributes.position, b = view.motes.userData.base; for (let i = 0; i < a.count; i++) a.array[i * 3 + 1] = b[i * 3 + 1] + Math.sin(time * 0.6 + i * 1.7) * 0.12; a.needsUpdate = true; view.motes.material.opacity = 0.55 + Math.sin(time * 0.8) * 0.25; }
    for (const gl of gulls) { const u = gl.userData; u.a += u.sp * dt; gl.position.set(Math.cos(u.a) * u.r * 1.6, u.h + Math.sin(time * 0.7 + u.r) * 0.1, Math.sin(u.a) * u.r); gl.rotation.y = -u.a - Math.PI; gl.children.forEach(c => { if (c.userData.sgn) c.rotation.x = Math.sin(time * 7 + u.r) * 0.5 * c.userData.sgn; }); }
    if (view.phare?.userData.halo) view.phare.userData.halo.material.opacity = 0.75 + Math.sin(time * 2.2) * 0.2;
  }
  const pulse = 0.5 + Math.sin(time * 5) * 0.5;
  glow.opacity = 0.75 + pulse * 0.25; glow.color.setRGB(1, 0.86 + pulse * 0.14, 0.45 + pulse * 0.5); // passe du doré au blanc
  if (tweens.length) shadowsDirty = 2;
  if (shadowsDirty > 0) { renderer.shadowMap.needsUpdate = true; shadowsDirty--; }
  seaUniforms.uDeep.value.lerp(seaTarget, 0.04); seaUniforms.uTime.value = time;
  // Au repos (rien ne bouge sous le doigt, pas d'animation de jeu), une image sur deux suffit :
  // le téléphone chauffe moins et garde toute sa puissance pour les moments où l'on joue.
  const busy = moving || dragging || tweens.length > 0 || shadowsDirty > 0 || performance.now() - lastInput < 1500;
  if (busy || (++idleFrame & 1)) renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

/* Pour les tests : position écran d'un repère */
export function markerScreenPositions() {
  return markers.children.filter(g => g.userData.kind).map(g => { const v = g.getWorldPosition(new THREE.Vector3()).project(camera); return { kind: g.userData.kind, id: g.userData.id, x: viewRect.left + (v.x + 1) / 2 * viewRect.width, y: viewRect.top + (1 - v.y) / 2 * viewRect.height }; });
}

export const debugScene = () => ({ scene, renderer, camera, sea, world, sun });
