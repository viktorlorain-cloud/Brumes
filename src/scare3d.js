/* Le Rôdeur en 3D qui fonce sur l'écran : une capuche en lambeaux, un visage noir, des yeux braise,
   une gueule qui s'ouvre, éclairé par en dessous. Rendu dans son propre canvas, au-dessus de tout,
   seulement pendant les ~2 secondes de l'apparition. */
import * as THREE from 'three';

let R = null; // { renderer, scene, camera, rig, parts }
function build(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.2;
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2('#000000', 0.08);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 60);
  camera.position.set(0, 0, 0);

  const rig = new THREE.Group(); scene.add(rig);
  // Capuche : une coque de sphère ouverte vers nous, allongée et pointue, bords déchiquetés
  const hoodGeo = new THREE.SphereGeometry(1, 48, 32, Math.PI * 0.18, Math.PI * 1.64, 0, Math.PI * 0.78);
  const pos = hoodGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (y > 0.3) { x *= 1 - (y - 0.3) * 0.55; z *= 1 - (y - 0.3) * 0.4; y += (y - 0.3) * 0.7; } // pointe
    const n = Math.sin(x * 9 + y * 5) * 0.03 + Math.sin(z * 13) * 0.02; // tissu froissé
    pos.setXYZ(i, x * (1 + n), y * 1.15, z * (1 + n));
  }
  hoodGeo.rotateY(Math.PI / 2); hoodGeo.computeVertexNormals();
  const cloth = new THREE.MeshStandardMaterial({ color: '#2b1638', roughness: 0.9, metalness: 0, side: THREE.DoubleSide, flatShading: false });
  const hood = new THREE.Mesh(hoodGeo, cloth); rig.add(hood);
  // Épaules et cape en lambeaux
  const capeGeo = new THREE.CylinderGeometry(0.95, 2.1, 2.4, 40, 6, true);
  const cp = capeGeo.attributes.position;
  for (let i = 0; i < cp.count; i++) { const y = cp.getY(i); if (y < -1.1) cp.setY(i, y - Math.abs(Math.sin(i * 1.7)) * 0.5); cp.setX(i, cp.getX(i) * (1 + Math.sin(i * 0.9) * 0.04)); }
  capeGeo.computeVertexNormals();
  const cape = new THREE.Mesh(capeGeo, cloth); cape.position.y = -1.75; rig.add(cape);
  // Le vide du visage
  const voidMat = new THREE.MeshBasicMaterial({ color: '#030104' });
  const face = new THREE.Mesh(new THREE.SphereGeometry(0.78, 32, 24), voidMat); face.position.set(0, -0.05, -0.12); face.scale.set(1, 1.15, 0.7); rig.add(face);
  // Yeux braise : globe brûlant, pupille fendue, halo
  const eyes = new THREE.Group(); rig.add(eyes);
  const eyeMat = new THREE.MeshStandardMaterial({ color: '#ffb347', emissive: '#ff5a14', emissiveIntensity: 4, roughness: 0.3 });
  const slitMat = new THREE.MeshBasicMaterial({ color: '#120000' });
  const haloTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); const r = g.createRadialGradient(32, 32, 0, 32, 32, 32); r.addColorStop(0, 'rgba(255,200,120,1)'); r.addColorStop(0.3, 'rgba(255,80,20,0.7)'); r.addColorStop(1, 'rgba(255,0,0,0)'); g.fillStyle = r; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
  for (const sx of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.1, 24, 16), eyeMat); e.scale.set(1.5, 0.55, 0.6); e.position.set(sx * 0.25, 0.1, 0.5); e.rotation.z = sx * -0.45; eyes.add(e);
    const slit = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.1, 0.02), slitMat); slit.position.set(sx * 0.25, 0.1, 0.56); slit.rotation.z = sx * -0.45; eyes.add(slit);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })); halo.scale.set(0.75, 0.42, 1); halo.position.set(sx * 0.25, 0.1, 0.57); eyes.add(halo);
  }
  // Gueule : deux rangées de crocs, la mâchoire du bas s'ouvre
  const toothMat = new THREE.MeshStandardMaterial({ color: '#f4ead8', roughness: 0.35, emissive: '#d8c9b0', emissiveIntensity: 0.35 });
  const upper = new THREE.Group(), lower = new THREE.Group(); upper.position.set(0, -0.3, 0.55); lower.position.set(0, -0.36, 0.53); rig.add(upper, lower);
  for (let i = 0; i < 13; i++) {
    const x = (i - 6) * 0.05, curve = -Math.abs(x) * 0.6, len = 0.1 + (i % 3 === 0 ? 0.06 : 0) + (Math.abs(i - 6) === 4 ? 0.09 : 0);
    const t = new THREE.Mesh(new THREE.ConeGeometry(0.022, len, 6), toothMat); t.rotation.x = Math.PI; t.position.set(x, -len / 2 + 0.02, curve); upper.add(t);
    const b = new THREE.Mesh(new THREE.ConeGeometry(0.02, len * 0.8, 6), toothMat); b.position.set(x + 0.02, len * 0.4 - 0.02, curve); lower.add(b);
  }
  const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.25, 20, 12), new THREE.MeshBasicMaterial({ color: '#3a0306' })); mouth.scale.set(1.35, 0.42, 0.3); mouth.position.set(0, -0.36, 0.47); rig.add(mouth);
  // Lumières : braise dans la capuche, rouge par en dessous, contre-jour froid
  const eyeLight = new THREE.PointLight('#ff5a1a', 6, 3, 2); eyeLight.position.set(0, 0.05, 0.3); rig.add(eyeLight);
  const under = new THREE.PointLight('#ff1c1c', 30, 9, 2); under.position.set(0, -2.2, 1.6); scene.add(under);
  const rim = new THREE.DirectionalLight('#6f8cff', 1.6); rim.position.set(-2, 3, -4); scene.add(rim);
  scene.add(new THREE.AmbientLight('#2a1030', 0.6));
  R = { renderer, scene, camera, rig, eyes, lower, eyeMat, eyeLight, under, canvas };
}

let raf = 0;
function setup(canvas) {
  if (!R || R.canvas !== canvas) build(canvas);
  const { renderer, camera } = R;
  const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.fov = w / h < 0.8 ? 58 : 45; camera.updateProjectionMatrix();
}
const ease = k => 1 - Math.pow(1 - k, 4);
/* Une image de l'apparition à l'instant t (en secondes) */
function draw(t, dur, rnd = Math.random) {
  const { renderer, scene, camera, rig, eyes, lower, eyeMat, eyeLight, under } = R;
  const k = Math.min(1, t / dur);
  // 0 → 0,28 s : il jaillit du fond ; puis il se penche, gueule ouverte, en tremblant
  const rush = ease(Math.min(1, t / 0.28));
  const z = -14 + rush * 10.2 + Math.max(0, t - 0.28) * 0.45; // finit à environ 3 m : toute la capuche emplit l'écran
  const shake = t > 0.25 ? (rnd() - 0.5) * 0.06 * (1 - k) : 0;
  rig.position.set(shake, -0.15 + shake * 0.5, z);
  rig.rotation.set(-0.12 + Math.sin(t * 3) * 0.04, Math.sin(t * 2.3) * 0.12, Math.sin(t * 1.7) * 0.1 + (t > 0.3 ? 0.12 : 0));
  lower.rotation.x = t > 0.22 ? Math.min(0.55, (t - 0.22) * 3) : 0;
  lower.position.y = -0.38 - lower.rotation.x * 0.25;
  const flick = rnd() < 0.12 ? 0.2 : 1;
  eyeMat.emissiveIntensity = (3 + Math.sin(t * 40) * 1.2) * flick; eyeLight.intensity = 6 * flick;
  eyes.scale.setScalar(1 + (t > 0.3 && t < 0.42 ? 0.25 : 0));
  under.intensity = 30 + Math.sin(t * 25) * 8;
  renderer.render(scene, camera);
}
export function scareFrame(canvas, t) { setup(canvas); draw(t, 1.75, () => 0.5); }
export function scare3D(canvas, dur = 1.75) {
  try { setup(canvas); } catch { return false; }
  const t0 = performance.now();
  cancelAnimationFrame(raf);
  const frame = () => {
    const t = (performance.now() - t0) / 1000;
    draw(t, dur);
    if (t < dur) raf = requestAnimationFrame(frame); else R.renderer.clear();
  };
  frame();
  return true;
}
