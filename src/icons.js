/* Jeu d'icônes de Brumes : une seule source pour l'interface (SVG) et le plateau 3D (textures).
   Style : formes rondes, aplats francs, contour bleu nuit de 3 px sur une grille de 48. */
const O = '#1d2b4f';
const g = inner => `<g stroke="${O}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round">${inner}</g>`;

export const ICONS = {
  bois: g(`<rect x="5" y="14" width="34" height="20" rx="10" fill="#c9823f"/><path d="M11 21h13M9 28h10" fill="none"/>
    <ellipse cx="35" cy="24" rx="8" ry="10" fill="#f3c98f"/><ellipse cx="35" cy="24" rx="3.5" ry="4.5" fill="none" stroke-width="2.5"/>`),
  pierre: g(`<rect x="4" y="26" width="19" height="13" rx="3" fill="#e8643f"/><rect x="25" y="26" width="19" height="13" rx="3" fill="#e8643f"/>
    <rect x="13" y="11" width="21" height="13" rx="3" fill="#f58b5e"/>`),
  lin: g(`<path d="M24 27v16" fill="none"/><path d="M24 38c-6 0-10-3-11-8 6 0 10 3 11 8z" fill="#6cc04a"/>
    <circle cx="24" cy="10.5" r="6" fill="#7b95ff"/><circle cx="31" cy="15.8" r="6" fill="#7b95ff"/><circle cx="28.3" cy="23.7" r="6" fill="#7b95ff"/>
    <circle cx="19.7" cy="23.7" r="6" fill="#7b95ff"/><circle cx="17" cy="15.8" r="6" fill="#7b95ff"/><circle cx="24" cy="18" r="4.5" fill="#ffd23f"/>`),
  grain: g(`<path d="M24 45V12" fill="none"/>
    <ellipse cx="18.5" cy="18" rx="4" ry="7" transform="rotate(-28 18.5 18)" fill="#f5c33b"/><ellipse cx="29.5" cy="18" rx="4" ry="7" transform="rotate(28 29.5 18)" fill="#f5c33b"/>
    <ellipse cx="18.5" cy="28" rx="4" ry="7" transform="rotate(-28 18.5 28)" fill="#f5c33b"/><ellipse cx="29.5" cy="28" rx="4" ry="7" transform="rotate(28 29.5 28)" fill="#f5c33b"/>
    <ellipse cx="24" cy="9" rx="4" ry="6.5" fill="#ffd95c"/>`),
  cristal: g(`<path d="M14 9h20l9 11-19 21L5 20z" fill="#4fd6e8"/><path d="M5 20h38M18 9l-4 11 10 21 10-21-4-11" fill="none" stroke-width="2.5"/>
    <path d="M14 13l-3 5" fill="none" stroke="#fff" stroke-width="2.5"/>`),
  fortune: g(`<path d="M24 4l5.8 12 13.2 1.9-9.6 9.3 2.3 13.1L24 34l-11.7 6.3 2.3-13.1L5 17.9 18.2 16z" fill="#ffd23f"/>`),
  des: g(`<rect x="6" y="6" width="36" height="36" rx="9" fill="#fff"/><circle cx="15.5" cy="15.5" r="3.5" fill="${O}"/><circle cx="24" cy="24" r="3.5" fill="${O}"/><circle cx="32.5" cy="32.5" r="3.5" fill="${O}"/>`),
  sentier: g(`<path d="M15 6h12v19l11 5c3 1.4 5 4 5 7v4H9V11c0-3 3-5 6-5z" fill="#c9823f"/><path d="M9 34h34M27 14h-5M27 20h-5" fill="none"/>`),
  camp: g(`<rect x="11" y="22" width="26" height="19" rx="2" fill="#fff3df"/><rect x="20.5" y="29" width="7" height="12" fill="#7a4b2b"/>
    <path d="M5 25L24 8l19 17z" fill="#ff5a4e"/>`),
  bastion: g(`<path d="M12 42V14h5v5h4.5v-5h5v5H31v-5h5v28z" fill="#efe3c8"/><rect x="20" y="31" width="8" height="11" rx="4" fill="#7a4b2b"/>
    <path d="M24 14V3l10 3.5L24 10" fill="#ff5a4e"/>`),
  banque: g(`<path d="M24 7v31M10 13h28" fill="none"/><path d="M4 26h14a7 6 0 0 1-14 0z" fill="#7fd3f5"/><path d="M30 26h14a7 6 0 0 1-14 0z" fill="#7fd3f5"/>
    <path d="M10 13L4 26M10 13l8 13M38 13l-8 13M38 13l6 13" fill="none" stroke-width="2"/><rect x="14" y="38" width="20" height="6" rx="3" fill="#ffd23f"/>`),
  fin: g(`<circle cx="24" cy="24" r="19" fill="#5cc85a"/><path d="M19 14l11 10-11 10" fill="none" stroke="#fff" stroke-width="5"/>`),
  carte: g(`<rect x="10" y="8" width="24" height="32" rx="4" fill="#b8c4ff" transform="rotate(-10 22 24)"/><rect x="15" y="9" width="24" height="32" rx="4" fill="#fff"/><circle cx="27" cy="25" r="5" fill="#ffd23f"/>`),
  menu: g(`<circle cx="12" cy="24" r="4" fill="${O}"/><circle cx="24" cy="24" r="4" fill="${O}"/><circle cx="36" cy="24" r="4" fill="${O}"/>`),
  sablier: g(`<path d="M12 5h24M12 43h24" fill="none"/><path d="M15 5c0 10 9 13 9 19s-9 9-9 19h18c0-10-9-13-9-19s9-9 9-19z" fill="#fff8ec"/><path d="M19 39c2-4 8-4 10 0z" fill="#ffd23f" stroke-width="2"/>`),
  partager: g(`<circle cx="35" cy="11" r="6" fill="#7b95ff"/><circle cx="13" cy="24" r="6" fill="#7b95ff"/><circle cx="35" cy="37" r="6" fill="#7b95ff"/><path d="M18 21l12-7M18 27l12 7" fill="none"/>`),
  phare: g(`<path d="M17 43l3-27h8l3 27z" fill="#fff8ec"/><path d="M18.6 31h10.8l.9 7H17.7z" fill="#ff5a4e"/><path d="M19.6 22h8.8l.6 5h-10z" fill="#ff5a4e"/>
    <rect x="18" y="10" width="12" height="6" rx="1" fill="#ffd23f"/><path d="M16 10l8-6 8 6z" fill="#3a4d7a"/><path d="M9 43h30" fill="none"/>`),
  voleur: g(`<path d="M10 42c0-18 4-32 14-32s14 14 14 32l-5-4-4 4-5-4-5 4-4-4z" fill="#6b46b8"/><ellipse cx="19" cy="23" rx="3" ry="4" fill="#fff"/><ellipse cx="29" cy="23" rx="3" ry="4" fill="#fff"/>`),
};

/* Planche SVG à insérer une fois dans la page : <svg><use href="#i-bois"/></svg> */
export function spriteSheet() {
  return `<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true">${
    Object.entries(ICONS).map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 48 48">${v}</symbol>`).join('')}</svg>`;
}
export const icon = (name, cls = 'ico') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

/* Image chargée de l'icône, pour la dessiner dans une texture du plateau 3D */
const imgCache = new Map();
export function iconImage(name) {
  if (!imgCache.has(name)) {
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="192" height="192">${ICONS[name]}</svg>`);
    imgCache.set(name, img);
  }
  return imgCache.get(name);
}
