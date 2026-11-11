/* Affichage 3D du plateau (Three.js). Lit l'état, ne le modifie jamais.
   Style cartoon : aplats vifs, ombrage en paliers, contours bleu nuit sur tout ce qui se joue. */
import * as THREE from 'three';
import { RES_INFO, PIPS } from './engine.js';
import { iconImage } from './icons.js';

let S = null;
const INK = '#1d2b4f';
const SKY = '#48cfe2';
const FOG_TILE = new THREE.Color('#b9c6e0');
const SEA_BASE = new THREE.Color('#2ec4d6');
const TOP = 0.15;
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let renderer, scene, camera, sea, sun, world, markers, shallows, foam, view = null, seaTarget = SEA_BASE.clone();
let extent = 4.33; // demi-largeur de l'île, recalculée à chaque plateau
let tapHandler = () => {};

export function initView(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 13, 26);
  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  scene.add(new THREE.HemisphereLight('#ffffff', '#bfe9f2', 1.7));
  sun = new THREE.DirectionalLight('#fff4d6', 2.0);
  sun.position.set(4, 10, 5); sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 30 });
  scene.add(sun);
  sea = new THREE.Mesh(new THREE.CircleGeometry(60, 64), mat(SEA_BASE.clone()));
  sea.rotation.x = -Math.PI / 2; sea.position.y = -0.22; sea.receiveShadow = true; scene.add(sea);
  shallows = new THREE.Mesh(new THREE.CircleGeometry(1, 64), new THREE.MeshBasicMaterial({ color: '#8be9f0', transparent: true, opacity: 0.55 }));
  shallows.rotation.x = -Math.PI / 2; shallows.position.y = -0.2; scene.add(shallows);
  foam = new THREE.Mesh(new THREE.RingGeometry(0.965, 1, 64), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8 }));
  foam.rotation.x = -Math.PI / 2; foam.position.y = -0.19; scene.add(foam);
  world = new THREE.Group(); scene.add(world);
  markers = new THREE.Group(); scene.add(markers);
  setupInput(canvas);
  window.addEventListener('resize', layoutCamera);
  layoutCamera();
  requestAnimationFrame(loop);
}
export function onTap(fn) { tapHandler = fn; }

/* ---------- Matières ---------- */
const gradient = (() => {
  const t = new THREE.DataTexture(new Uint8Array([130, 205, 255]), 3, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true; return t;
})();
function mat(c, o = {}) {
  const { flat, ...rest } = o;
  const m = new THREE.MeshToonMaterial({ color: c, gradientMap: gradient, ...rest });
  if (flat) m.flatShading = true;
  return m;
}
const flatMat = (c, o = {}) => new THREE.MeshBasicMaterial({ color: c, ...o });
const inkBack = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide });
const inkSolid = new THREE.MeshBasicMaterial({ color: INK });
function shadowed(m) { m.castShadow = true; m.receiveShadow = true; return m; }
/* Contour : la même forme, retournée et agrandie d'une épaisseur constante t */
function outlined(mesh, t = 0.028) {
  const g = mesh.geometry; if (!g.boundingBox) g.computeBoundingBox();
  const size = g.boundingBox.getSize(new THREE.Vector3()), c = g.boundingBox.getCenter(new THREE.Vector3());
  const o = new THREE.Mesh(g, inkBack);
  o.scale.set((size.x + 2 * t) / size.x, (size.y + 2 * t) / size.y, (size.z + 2 * t) / size.z);
  o.position.set(c.x * (1 - o.scale.x), c.y * (1 - o.scale.y), c.z * (1 - o.scale.z));
  mesh.add(o); return mesh;
}
const solid = (geo, color, t) => outlined(shadowed(new THREE.Mesh(geo, mat(color))), t);
function ringPos(i, n, rad, rot = 0) { const a = rot + i / n * Math.PI * 2; return [Math.cos(a) * rad, Math.sin(a) * rad]; }
function scaled(g, f) { const outer = new THREE.Group(); g.scale.setScalar(f); outer.add(g); outer.userData = g.userData; return outer; }

/* ---------- Textures dessinées (numéros, étiquettes, icônes) ---------- */
const FONT = 'Fredoka, "Baloo 2", system-ui, sans-serif';
function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const redraw = () => { const g = c.getContext('2d'); g.clearRect(0, 0, w, h); draw(g, w, h); tex.needsUpdate = true; };
  redraw();
  return { tex, redraw };
}
function whenIcon(name, fn) { const img = iconImage(name); if (!img.complete) img.addEventListener('load', fn, { once: true }); return img; }
function numberTexture(n) {
  return canvasTexture(128, 128, (g, w, h) => {
    g.fillStyle = (n === 6 || n === 8) ? '#e5382c' : INK;
    g.font = `700 76px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(n), w / 2, h / 2 - 8);
    const p = PIPS(n);
    for (let i = 0; i < p; i++) { g.beginPath(); g.arc(w / 2 + (i - (p - 1) / 2) * 13, h / 2 + 38, 5, 0, Math.PI * 2); g.fill(); }
  }).tex;
}
/* Étiquette de port : pastille crème à contour, icône de la ressource et taux */
function portSprite(type) {
  const img = type === '3:1' ? null : whenIcon(type, () => t.redraw());
  const t = canvasTexture(192, 128, (g, w, h) => {
    g.fillStyle = INK; g.beginPath(); g.roundRect(4, 14, w - 8, h - 22, 30); g.fill();
    g.fillStyle = '#fff8ec'; g.beginPath(); g.roundRect(11, 14, w - 22, h - 36, 24); g.fill();
    g.fillStyle = INK; g.textBaseline = 'middle'; g.font = `700 46px ${FONT}`;
    if (img) { if (img.complete) g.drawImage(img, 18, 24, 68, 68); g.textAlign = 'left'; g.fillText('2:1', 92, 60); }
    else { g.textAlign = 'center'; g.fillText('3:1', w / 2, 60); }
  });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t.tex, depthWrite: false, fog: false }));
  s.scale.set(1.08, 0.72, 1); return s;
}
function iconSprite(name, size = 0.5) {
  const img = whenIcon(name, () => t.redraw());
  const t = canvasTexture(128, 128, (g, w, h) => { if (img.complete) g.drawImage(img, 0, 0, w, h); });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t.tex, transparent: true, depthWrite: false, depthTest: false }));
  s.scale.set(size, size, 1); s.renderOrder = 5; return s;
}

/* ---------- Décors des terrains (sans contour : ils restent derrière les pièces) ---------- */
function makeDecor(terrain, rot) {
  const g = new THREE.Group();
  const add = (geo, color, x, y, z, o) => { const m = shadowed(new THREE.Mesh(geo, mat(color, o))); m.position.set(x, y, z); g.add(m); return m; };
  if (terrain === 'bois') {
    for (let i = 0; i < 6; i++) {
      const [x, z] = ringPos(i, 6, 0.6 + (i % 2) * 0.07, rot), s = 0.85 + ((i * 37) % 5) / 14;
      add(new THREE.CylinderGeometry(0.035, 0.045, 0.12, 6), '#8a5a33', x, 0.06, z);
      add(new THREE.ConeGeometry(0.17 * s, 0.24 * s, 7), i % 2 ? '#2f9e4f' : '#3fb65c', x, 0.12 + 0.12 * s, z, { flat: true });
      add(new THREE.ConeGeometry(0.12 * s, 0.2 * s, 7), i % 2 ? '#3fb65c' : '#58c96f', x, 0.12 + 0.27 * s, z, { flat: true });
    }
  } else if (terrain === 'pierre') {
    for (let i = 0; i < 4; i++) {
      const [x, z] = ringPos(i, 4, 0.58, rot);
      add(new THREE.BoxGeometry(0.26, 0.14, 0.18), i % 2 ? '#d9532f' : '#f0764a', x, 0.07, z).rotation.y = i * 0.7;
      add(new THREE.BoxGeometry(0.15, 0.1, 0.12), '#ffa27a', x + 0.04, 0.19, z).rotation.y = i * 0.7 + 0.4;
    }
  } else if (terrain === 'lin') {
    for (let i = 0; i < 8; i++) {
      const [x, z] = ringPos(i, 8, 0.52 + (i % 3) * 0.09, rot);
      add(new THREE.ConeGeometry(0.07, 0.18, 6), '#5fae3c', x, 0.09, z, { flat: true });
      add(new THREE.SphereGeometry(0.06, 8, 6), i % 3 ? '#7b95ff' : '#a9b8ff', x, 0.21, z);
    }
  } else if (terrain === 'grain') {
    for (let i = 0; i < 3; i++) {
      const m = add(new THREE.BoxGeometry(1.0 - i * 0.22, 0.03, 0.07), '#e2a61f', 0, 0.017, 0);
      const a = rot + 0.4; m.position.set(Math.cos(a + Math.PI / 2) * (0.5 + i * 0.13), 0.017, Math.sin(a + Math.PI / 2) * (0.5 + i * 0.13)); m.rotation.y = -a;
    }
    for (let i = 0; i < 5; i++) {
      const [x, z] = ringPos(i, 5, 0.6, rot + Math.PI * 0.9);
      add(new THREE.CylinderGeometry(0.03, 0.075, 0.24, 7), '#ffd95c', x, 0.12, z, { flat: true });
      add(new THREE.SphereGeometry(0.055, 8, 6), '#f5b82e', x, 0.26, z);
    }
  } else if (terrain === 'cristal') {
    [[0.56, rot], [0.6, rot + 2.2], [0.52, rot + 4.1]].forEach(([rad, a], i) => {
      const x = Math.cos(a) * rad, z = Math.sin(a) * rad, h = 0.4 + i * 0.08;
      add(new THREE.ConeGeometry(0.28, h, 6), '#8793b8', x, h / 2, z, { flat: true });
      add(new THREE.ConeGeometry(0.115, h * 0.42, 6), '#ffffff', x, h * 0.8, z, { flat: true });
    });
    for (let i = 0; i < 3; i++) {
      const [x, z] = ringPos(i, 3, 0.62, rot + 1.1);
      const c = add(new THREE.OctahedronGeometry(0.1), '#4fd6e8', x, 0.14, z, { flat: true, emissive: '#1aa6c4', emissiveIntensity: 0.6 }); c.scale.y = 1.5;
    }
  }
  return g;
}
/* Brume : des nuages blancs bien ronds posés sur la tuile cachée */
function makeFog(rot) {
  const g = new THREE.Group();
  for (let i = 0; i < 6; i++) {
    const [x, z] = ringPos(i, 6, 0.56, rot);
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.25 + (i % 3) * 0.05, 10, 8), mat('#ffffff', { transparent: true, opacity: 0.96, emissive: '#c8d6f0', emissiveIntensity: 0.35 }));
    m.position.set(x, 0.16, z); m.scale.y = 0.72; m.userData.phase = i * 1.3 + rot; g.add(m);
  }
  return g;
}
function makePhare() {
  const g = new THREE.Group();
  const rock = solid(new THREE.CylinderGeometry(0.44, 0.56, 0.16, 8), '#f6e2a8'); rock.position.y = 0.08; g.add(rock);
  for (let i = 0; i < 4; i++) {
    const s = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.2 - i * 0.02, 0.22 - i * 0.02, 0.2, 14), mat(i % 2 ? '#ff5a4e' : '#fff8ec')));
    s.position.y = 0.26 + i * 0.2; g.add(s);
  }
  const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.175, 0.26, 0.82, 14), inkBack); hull.position.y = 0.56; g.add(hull);
  const lamp = outlined(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.16, 14), flatMat('#ffe27a'))); lamp.position.y = 1.04; g.add(lamp);
  const roof = solid(new THREE.ConeGeometry(0.23, 0.22, 14), '#3a4d7a'); roof.position.y = 1.23; g.add(roof);
  const beamGeo = new THREE.ConeGeometry(0.55, 3.2, 20, 1, true); beamGeo.translate(0, -1.6, 0); beamGeo.rotateZ(Math.PI / 2);
  const beam = new THREE.Mesh(beamGeo, flatMat('#fff3a8', { transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide }));
  beam.position.y = 1.04; g.add(beam); g.userData.beam = beam;
  return scaled(g, 1.1);
}

/* ---------- Pièces des joueurs : grosses, colorées, à contour ---------- */
function basePlate(color, r) {
  const g = new THREE.Group();
  const edge = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.035, r + 0.035, 0.03, 28), inkSolid); edge.position.y = 0.015; g.add(edge);
  const plate = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.05, 28), flatMat(color)); plate.position.y = 0.027; plate.receiveShadow = false; g.add(plate);
  return g;
}
function gableRoof(w, h, d, color) {
  const shape = new THREE.Shape(); shape.moveTo(-w / 2, 0); shape.lineTo(w / 2, 0); shape.lineTo(0, h); shape.lineTo(-w / 2, 0);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false }); geo.translate(0, 0, -d / 2);
  return outlined(shadowed(new THREE.Mesh(geo, mat(color, { flat: true }))));
}
function makeFlag(color, h) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, h, 5), inkSolid); pole.position.y = h / 2; g.add(pole);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.14), flatMat(INK, { side: THREE.DoubleSide })); back.position.set(0.09, h - 0.06, 0);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 0.09), flatMat(color, { side: THREE.DoubleSide })); flag.position.set(-0.005, 0, 0.004);
  const flag2 = flag.clone(); flag2.position.z = -0.004; back.add(flag, flag2);
  const pivot = new THREE.Group(); pivot.add(back); g.add(pivot); g.userData.flag = pivot;
  return g;
}
/* Camp : une maison trapue, toit à la couleur du joueur */
function makeTent(color) {
  const g = new THREE.Group();
  g.add(basePlate(color, 0.25));
  const body = solid(new THREE.BoxGeometry(0.3, 0.2, 0.26), '#fff3df'); body.position.y = 0.15; g.add(body);
  const roof = gableRoof(0.4, 0.2, 0.33, color); roof.position.y = 0.25; g.add(roof);
  const door = new THREE.Mesh(new THREE.PlaneGeometry(0.085, 0.13), flatMat('#7a4b2b')); door.position.set(0, 0.115, 0.1315); g.add(door);
  const win = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.07), flatMat('#ffd23f')); win.position.set(0.1515, 0.16, 0); win.rotation.y = Math.PI / 2; g.add(win);
  const chimney = solid(new THREE.BoxGeometry(0.07, 0.14, 0.07), '#fff3df', 0.02); chimney.position.set(0.1, 0.4, -0.07); g.add(chimney);
  g.userData.flag = null;
  return scaled(g, 1.35);
}
/* Bastion : une tour crénelée avec une aile, bannière au sommet */
function makeBastion(color) {
  const g = new THREE.Group();
  g.add(basePlate(color, 0.3));
  const tower = solid(new THREE.CylinderGeometry(0.17, 0.2, 0.44, 12), '#efe3c8'); tower.position.set(-0.04, 0.27, 0); g.add(tower);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.188, 0.196, 0.07, 12), flatMat(color)); band.position.set(-0.04, 0.2, 0); g.add(band);
  for (let i = 0; i < 6; i++) { const [x, z] = ringPos(i, 6, 0.14); const m = solid(new THREE.BoxGeometry(0.07, 0.07, 0.07), '#efe3c8', 0.016); m.position.set(x - 0.04, 0.52, z); g.add(m); }
  const roof = solid(new THREE.ConeGeometry(0.13, 0.26, 12), color); roof.position.set(-0.04, 0.66, 0); g.add(roof);
  const wing = solid(new THREE.BoxGeometry(0.2, 0.16, 0.2), '#fff3df'); wing.position.set(0.17, 0.13, 0.05); g.add(wing);
  const wroof = gableRoof(0.27, 0.13, 0.25, color); wroof.position.set(0.17, 0.21, 0.05); g.add(wroof);
  const door = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.1), flatMat('#7a4b2b')); door.position.set(0.17, 0.1, 0.1515); g.add(door);
  const flag = makeFlag(color, 0.26); flag.position.set(-0.04, 0.78, 0); g.add(flag); g.userData.flag = flag.userData.flag;
  return scaled(g, 1.35);
}
/* Éclaireur : petit bonhomme à capuche, de la couleur du joueur */
function makeScout(color) {
  const g = new THREE.Group();
  const body = solid(new THREE.CylinderGeometry(0.06, 0.1, 0.2, 10), color, 0.02); body.position.y = 0.1; g.add(body);
  const head = solid(new THREE.SphereGeometry(0.085, 14, 10), '#ffe0bd', 0.02); head.position.y = 0.27; g.add(head);
  const hood = new THREE.Mesh(new THREE.SphereGeometry(0.092, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), mat(color)); hood.position.y = 0.275; hood.rotation.x = -0.45; g.add(hood);
  for (const s of [-1, 1]) { const eye = new THREE.Mesh(new THREE.SphereGeometry(0.014, 6, 4), inkSolid); eye.position.set(s * 0.032, 0.27, 0.078); g.add(eye); }
  const lantern = outlined(new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), flatMat('#ffd23f')), 0.014); lantern.position.set(0.11, 0.12, 0.04); g.add(lantern);
  return scaled(g, 1.9);
}
/* Le Rôdeur : un fantôme violet aux grands yeux */
function makeRobber() {
  const g = new THREE.Group();
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.2, 20), flatMat(INK, { transparent: true, opacity: 0.25, depthWrite: false })); shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.01; g.add(shadow);
  const body = solid(new THREE.CylinderGeometry(0.15, 0.19, 0.3, 14), '#7a4fd0'); body.position.y = 0.19; g.add(body);
  const head = solid(new THREE.SphereGeometry(0.15, 16, 12), '#7a4fd0'); head.position.y = 0.36; g.add(head);
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.042, 10, 8), flatMat('#ffffff')); eye.position.set(s * 0.06, 0.38, 0.125); eye.scale.z = 0.5; g.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), inkSolid); pupil.position.set(s * 0.06, 0.375, 0.146); g.add(pupil);
  }
  return scaled(g, 1.35);
}

/* ---------- Construction depuis l'état ---------- */
function vpos(vid, y = TOP + 0.02) { const v = S.vertices[vid]; return V3(v.x, y, v.z); }
function roadMesh(eid, pid, fromVid) {
  const e = S.edges[eid];
  const startV = fromVid != null ? fromVid : e.v[0];
  const endV = e.v[0] === startV ? e.v[1] : e.v[0];
  const a = vpos(startV, TOP + 0.02), b = vpos(endV, TOP + 0.02), len = a.distanceTo(b);
  const L = len * 0.7, W = 0.19, H = 0.1, T = 0.035;
  const geo = new THREE.BoxGeometry(L, H, W); geo.translate(L / 2, 0, 0);
  const road = shadowed(new THREE.Mesh(geo, mat(S.players[pid].col)));
  const hull = new THREE.BoxGeometry(L + 2 * T, H + T, W + 2 * T); hull.translate(L / 2, -T / 2 + 0.005, 0);
  road.add(new THREE.Mesh(hull, inkBack));
  const dir = b.clone().sub(a).normalize();
  road.position.copy(a.clone().add(dir.clone().multiplyScalar(len * 0.15)));
  road.rotation.y = Math.atan2(-dir.z, dir.x);
  return road;
}

export function buildView(state) {
  S = state;
  extent = Math.max(...S.tiles.map(t => Math.abs(t.x))) + 0.87;
  shallows.scale.setScalar(extent + 1.1); foam.scale.setScalar(extent + 1.1);
  layoutCamera();
  world.clear(); markers.clear(); tweens.length = 0;
  view = { tiles: [], vertexObjs: new Map(), roadObjs: new Map(), robber: null, phare: null, gameId: S.gameId };
  const rimGeo = new THREE.CylinderGeometry(1.0, 1.0, 0.34, 6), topGeo = new THREE.CylinderGeometry(0.925, 0.925, 0.3, 6);
  const tokenRim = new THREE.CylinderGeometry(0.36, 0.36, 0.04, 28), tokenTop = new THREE.CylinderGeometry(0.31, 0.31, 0.07, 28);
  const tokenMat = flatMat('#fffdf6');
  for (const t of S.tiles) {
    const g = new THREE.Group(); g.position.set(t.x, 0, t.z);
    const rim = new THREE.Mesh(rimGeo, inkSolid); rim.position.y = -0.035; g.add(rim);
    const col = t.terrain === 'phare' ? new THREE.Color('#fbe9b4') : (t.revealed ? new THREE.Color(RES_INFO[t.terrain].col) : FOG_TILE.clone());
    const base = new THREE.Mesh(topGeo, mat(col, { flat: true })); base.receiveShadow = true; g.add(base);
    const rot = (t.id * 1.7) % (Math.PI * 2);
    const top = new THREE.Group(); top.position.y = TOP; g.add(top);
    let decor = null, fog = null;
    if (t.terrain === 'phare') { view.phare = makePhare(); top.add(view.phare); }
    else {
      decor = makeDecor(t.terrain, rot); top.add(decor);
      if (!t.revealed) { decor.scale.setScalar(0.001); fog = makeFog(rot); top.add(fog); }
    }
    if (t.number) {
      const r = new THREE.Mesh(tokenRim, inkSolid); r.position.y = 0.02; top.add(r);
      const d = new THREE.Mesh(tokenTop, tokenMat); d.position.y = 0.04; top.add(d);
      const label = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.6), new THREE.MeshBasicMaterial({ map: numberTexture(t.number), transparent: true }));
      label.rotation.x = -Math.PI / 2; label.position.y = 0.078; top.add(label);
    }
    world.add(g);
    view.tiles[t.id] = { group: g, base, decor, fog };
  }
  for (const p of S.ports) {
    const e = S.edges[p.edge], a = S.vertices[e.v[0]], b = S.vertices[e.v[1]], t = S.tiles[e.tiles[0]];
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const dir = new THREE.Vector2(mx - t.x, mz - t.z).normalize();
    const pier = solid(new THREE.BoxGeometry(0.16, 0.06, 0.5), '#c9823f', 0.025);
    pier.position.set(mx + dir.x * 0.27, -0.03, mz + dir.y * 0.27); pier.rotation.y = Math.atan2(dir.x, dir.y); world.add(pier);
    for (const v of [a, b]) {
      const plank = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.04, 0.38), mat('#e0a060')));
      plank.position.set((v.x + mx + dir.x * 0.48) / 2, -0.01, (v.z + mz + dir.y * 0.48) / 2); plank.lookAt(mx + dir.x * 0.48, -0.01, mz + dir.y * 0.48); world.add(plank);
    }
    const lab = portSprite(p.type);
    lab.position.set(mx + dir.x * 0.95, 0.34, mz + dir.y * 0.95); world.add(lab);
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
  const col = { abondance: '#2fd6a8', disette: '#62b1cc', haut: '#3fb0ff', bas: '#6f95f5' }[type];
  seaTarget = new THREE.Color(col || SEA_BASE);
}

/* ---------- Animations ---------- */
const tweens = [];
function tween(dur, update, done, delay = 0) { tweens.push({ t: -delay, dur, update, done }); }
const ease = k => k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
const backOut = k => { const c = 2.4; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); };

function placeRobberAt(tid, animate) {
  const t = S.tiles[tid]; const to = t.terrain === 'phare' ? V3(t.x - 0.64, TOP, t.z + 0.05) : V3(t.x, TOP, t.z - 0.5);
  if (!animate) { view.robber.position.copy(to); return; }
  const from = view.robber.position.clone();
  tween(0.9, k => { view.robber.position.lerpVectors(from, to, ease(k)); view.robber.position.y = TOP + Math.sin(k * Math.PI) * 0.8; });
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
  tween(0.18, k => scout.scale.setScalar(Math.max(0.01, backOut(k))));
  tween(dur, k => {
    let d = k * L, i = 0;
    while (i < segs.length - 1 && d > segs[i]) { d -= segs[i]; i++; }
    const f = segs[i] ? Math.min(1, d / segs[i]) : 1;
    const a = points[i], b = points[i + 1] || points[i];
    scout.position.lerpVectors(a, b, f);
    scout.position.y = a.y + Math.abs(Math.sin(k * dur * 16)) * 0.07;
    if (b !== a) scout.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
    scout.rotation.z = Math.sin(k * dur * 16) * 0.1;
    onStep && onStep(i, f, segs.length);
  }, () => {
    onArrive && onArrive();
    tween(0.35, k => scout.scale.setScalar(Math.max(0.01, 1 - k)), () => world.remove(scout), 0.6);
  }, 0.1);
}
function pop(obj, delay = 0, done) {
  obj.scale.setScalar(0.001);
  tween(0.5, k => obj.scale.setScalar(Math.max(0.001, backOut(k))), done, delay);
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
  if (ev.setup) { const c = S.tiles[S.center]; pts = [V3(c.x + 0.3, TOP + 0.02, c.z + 0.45), vpos(ev.v)]; }
  else {
    const v = S.vertices[ev.v], b = v.building; v.building = null; const path = scoutPath(ev.pid, [ev.v]); v.building = b;
    pts = (path || [ev.v]).map(x => vpos(x)); if (pts.length === 1) pts.unshift(pts[0].clone().add(V3(0.3, 0, 0.3)));
  }
  const house = makeTent(S.players[ev.pid].col); house.position.copy(vpos(ev.v, TOP)); house.scale.setScalar(0.001); world.add(house);
  view.vertexObjs.set(ev.v, house);
  walkScout(ev.pid, pts, null, () => pop(house));
}
function animateBastion(ev) {
  const old = view.vertexObjs.get(ev.v);
  const tower = makeBastion(S.players[ev.pid].col); tower.position.copy(vpos(ev.v, TOP)); world.add(tower);
  view.vertexObjs.set(ev.v, tower);
  if (old) tween(0.25, k => old.scale.setScalar(Math.max(0.001, 1 - k)), () => world.remove(old));
  pop(tower, 0.2);
}
function animateReveal(ids) {
  ids.forEach((id, i) => {
    const v = view.tiles[id], t = S.tiles[id];
    const from = v.base.material.color.clone(), to = new THREE.Color(RES_INFO[t.terrain].col);
    const fog = v.fog;
    tween(0.8, k => {
      v.base.material.color.lerpColors(from, to, k);
      if (fog) fog.children.forEach(m => { m.material.opacity = 0.96 * (1 - k); m.position.y = 0.16 + k * 0.6; m.scale.setScalar(1 + k * 0.6); });
      v.decor.scale.setScalar(Math.max(0.001, backOut(Math.min(1, k * 1.3))));
    }, () => { if (fog && fog.parent) fog.parent.remove(fog); v.fog = null; }, 0.35 + i * 0.12);
  });
}
function animateProduction(gains, delay) {
  gains.forEach((g, i) => {
    const t = S.tiles[g.tile];
    for (let j = 0; j < g.n; j++) {
      const s = iconSprite(g.res); s.visible = false; world.add(s);
      const from = V3(t.x, TOP + 0.4, t.z), to = vpos(g.vertex, TOP + 0.8);
      tween(0.85, k => {
        s.visible = true; s.position.lerpVectors(from, to, ease(k)); s.position.y += Math.sin(k * Math.PI) * 0.6;
        const sc = 0.5 * (k < 0.2 ? backOut(k * 5) : 1); s.scale.set(sc, sc, 1); s.material.opacity = k > 0.85 ? (1 - k) / 0.15 : 1;
      }, () => world.remove(s), delay + i * 0.07 + j * 0.12);
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

/* ---------- Repères d'interaction : pastilles jaunes à contour, qui pulsent ---------- */
const hitMat = new THREE.MeshBasicMaterial({ visible: false });
const glow = new THREE.MeshBasicMaterial({ color: '#ffd23f' });
const glowInk = new THREE.MeshBasicMaterial({ color: INK });
const flatDisc = (geo, m, y) => { const d = new THREE.Mesh(geo, m); d.rotation.x = -Math.PI / 2; d.position.y = y; return d; };
export function showMarkers(kind, ids) {
  markers.clear();
  for (const id of ids) {
    const g = new THREE.Group(), pulse = new THREE.Group(); g.userData = { kind, id, pulse }; g.add(pulse);
    if (kind === 'vertex') {
      const v = S.vertices[id];
      pulse.add(flatDisc(new THREE.CircleGeometry(0.2, 24), glowInk, 0), flatDisc(new THREE.CircleGeometry(0.15, 24), glow, 0.004), flatDisc(new THREE.CircleGeometry(0.05, 12), glowInk, 0.008));
      g.add(new THREE.Mesh(new THREE.SphereGeometry(0.32, 8, 6), hitMat)); g.position.set(v.x, TOP + 0.09, v.z);
    } else if (kind === 'edge') {
      const e = S.edges[id], a = S.vertices[e.v[0]], b = S.vertices[e.v[1]];
      pulse.add(new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.02, 0.2), glowInk));
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.03, 0.12), glow); bar.position.y = 0.004; pulse.add(bar);
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.3, 0.42), hitMat));
      g.position.set((a.x + b.x) / 2, TOP + 0.08, (a.z + b.z) / 2); g.rotation.y = Math.atan2(-(b.z - a.z), b.x - a.x);
    } else if (kind === 'tile') {
      const t = S.tiles[id];
      pulse.add(flatDisc(new THREE.RingGeometry(0.66, 0.9, 6, 1, Math.PI / 2), glowInk, 0), flatDisc(new THREE.RingGeometry(0.71, 0.85, 6, 1, Math.PI / 2), glow, 0.004));
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.5, 6), hitMat)); g.position.set(t.x, TOP + 0.1, t.z);
    }
    markers.add(g);
  }
}
export function clearMarkers() { markers.clear(); }

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
  const dist = Math.max((need / 2) / Math.tan(hfov / 2), (need * 0.95 / 2) / Math.tan(vfov / 2)) * z;
  const tilt = THREE.MathUtils.degToRad(63);
  cam.position.set(p.x, Math.sin(tilt) * dist, p.y + 0.35 + Math.cos(tilt) * dist);
  cam.lookAt(p.x, 0, p.y + 0.35);
  cam.updateProjectionMatrix(); cam.updateMatrixWorld();
  return dist;
}
function layoutCamera() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; probeCam.aspect = camera.aspect;
  const dist = placeCamera(camera, zoom, pan);
  scene.fog.near = dist * 1.05 / zoom; scene.fog.far = dist * 2.4 / zoom;
}
/* Point du sol (y = 0) sous une position d'écran, pour une caméra donnée */
const _ray = new THREE.Raycaster(), _ndc = new THREE.Vector2(), _hit = new THREE.Vector3();
function groundAt(x, y, z = zoomT, p = panT) {
  placeCamera(probeCam, z, p);
  _ndc.set(x / window.innerWidth * 2 - 1, -(y / window.innerHeight) * 2 + 1);
  _ray.setFromCamera(_ndc, probeCam);
  return _ray.ray.intersectPlane(ground, _hit) ? _hit.clone() : null;
}
function clampPan(v) {
  const lim = 0.25 + extent * (1 - Math.min(1, zoomT)) * 1.35;
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
  if (Math.abs(dz) < 1e-4 && dp < 1e-7) return;
  zoom += dz * k; pan.lerp(panT, k);
  const dist = placeCamera(camera, zoom, pan);
  scene.fog.near = dist * 1.05 / zoom; scene.fog.far = dist * 2.4 / zoom;
}
function setupInput(canvas) {
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), pointers = new Map();
  let downAt = null, moved = false, pinch = null, lastMove = 0, lastTap = { t: 0, x: 0, y: 0 };
  const mid = () => { const [a, b] = [...pointers.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }; };
  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    vel.set(0, 0); dragging = true;
    if (pointers.size === 1) { downAt = { x: e.clientX, y: e.clientY, t: performance.now() }; moved = false; }
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
    if (!end(e) || moved) return;
    // Toucher simple : un emplacement lumineux d'abord
    if (markers.children.length) {
      ndc.set(e.clientX / window.innerWidth * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      camera.updateMatrixWorld(); markers.updateMatrixWorld(true);
      ray.setFromCamera(ndc, camera);
      const hits = ray.intersectObjects(markers.children, true);
      if (hits.length) { let o = hits[0].object; while (o && !o.userData.kind) o = o.parent; if (o) { tapHandler(o.userData.kind, o.userData.id); lastTap.t = 0; return; } }
    }
    // Double-tap ailleurs : zoom avant ou retour à la vue d'ensemble
    const now = performance.now();
    if (now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
      if (zoomT > 0.8) zoomAround(e.clientX, e.clientY, 0.55); else { zoomT = 1; panT.set(0, 0); }
      lastTap.t = 0;
    } else lastTap = { t: now, x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointercancel', e => { end(e); });
  canvas.addEventListener('wheel', e => { e.preventDefault(); zoomAround(e.clientX, e.clientY, zoomT * Math.exp(e.deltaY * 0.0015)); }, { passive: false });
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
function loop() {
  const raw = clock.getDelta(), dt = Math.min(raw, 0.05), time = clock.elapsedTime;
  updateCamera(dt);
  if (!document.hidden) adaptQuality(raw);
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i]; tw.t += dt; if (tw.t < 0) continue;
    const k = Math.min(1, tw.t / tw.dur); tw.update(k);
    if (k >= 1) { tweens.splice(i, 1); tw.done && tw.done(); }
  }
  if (view) {
    if (view.phare) view.phare.userData.beam.rotation.y = time * 0.7;
    for (const t of view.tiles) if (t?.fog) t.fog.children.forEach(m => { m.position.y = 0.16 + Math.sin(time * 0.9 + m.userData.phase) * 0.035; });
    for (const o of view.vertexObjs.values()) if (o.userData.flag) o.userData.flag.rotation.y = Math.sin(time * 3 + o.position.x) * 0.35;
    view.robber.rotation.y = Math.sin(time * 0.6) * 0.4; view.robber.children[0].position.y = 0.04 + Math.abs(Math.sin(time * 2)) * 0.05;
  }
  const pulse = 1 + Math.sin(time * 6) * 0.12;
  for (const g of markers.children) g.userData.pulse.scale.set(pulse, 1, pulse);
  foam.material.opacity = 0.6 + Math.sin(time * 1.3) * 0.2; foam.scale.setScalar(extent + 1.1 + Math.sin(time * 1.3) * 0.06);
  sea.material.color.lerp(seaTarget, 0.04);
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

/* Pour les tests : position écran d'un repère */
export function markerScreenPositions() {
  return markers.children.map(g => { const v = g.getWorldPosition(new THREE.Vector3()).project(camera); return { kind: g.userData.kind, id: g.userData.id, x: (v.x + 1) / 2 * window.innerWidth, y: (1 - v.y) / 2 * window.innerHeight }; });
}
export const debugScene = () => ({ scene, renderer, camera, sea, shallows, foam, world, sun });
