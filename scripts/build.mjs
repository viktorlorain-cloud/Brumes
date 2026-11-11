// Construit le site dans dist/ : un seul fichier JS + les fichiers statiques.
// BRUMES_CHANNEL=preview construit l'aperçu de test (salons, sauvegardes et adresse séparés).
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const channel = process.env.BRUMES_CHANNEL === 'preview' ? 'preview' : 'prod';
const now = new Date();
const version = now.toISOString().replace(/\D/g, '').slice(0, 14);
const git = cmd => { try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const info = { channel, version, date: now.toISOString(), sha: git('git rev-parse --short HEAD') };

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
await build({
  entryPoints: ['src/main.js'], bundle: true, format: 'esm', minify: true, target: 'es2020', outfile: 'dist/app.js', legalComments: 'none',
  define: { __BRUMES_BUILD__: JSON.stringify(info) },
});
let html = readFileSync('index.html', 'utf8');
if (channel === 'preview') html = html.replace('<title>Brumes</title>', '<title>Brumes · aperçu</title>');
writeFileSync('dist/index.html', html);
cpSync('public', 'dist', { recursive: true });
writeFileSync('dist/sw.js', readFileSync('public/sw.js', 'utf8').replace('__BUILD__', version));
writeFileSync('dist/version.json', JSON.stringify(info, null, 2));

// Journal des nouveautés, tiré de l'historique du code
const SEP = '\u001e', FS = '\u001f';
const log = git(`git log -n 40 --pretty=format:%cI${FS}%h${FS}%s${FS}%b${SEP}`)
  .split(SEP).map(x => x.trim()).filter(Boolean).map(x => { const [date, sha, subject, body = ''] = x.split(FS); return { date, sha, subject, body }; });
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = d => new Date(d).toLocaleString('fr-FR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
const items = log.map(c => {
  const lines = c.body.split('\n').filter(l => l.trim() && !/^(Co-Authored-By|Claude-Session):/i.test(l));
  const bullets = lines.filter(l => /^\s*-\s/.test(l)), text = lines.filter(l => !/^\s*-\s/.test(l) && !/^\s{2,}\S/.test(l)).join(' ');
  const cont = []; for (const l of lines) { if (/^\s*-\s/.test(l)) cont.push(l.replace(/^\s*-\s/, '')); else if (/^\s{2,}\S/.test(l) && cont.length) cont[cont.length - 1] += ' ' + l.trim(); }
  return `<li><time>${fmt(c.date)}</time><h2>${esc(c.subject)}</h2>${text ? `<p>${esc(text)}</p>` : ''}${cont.length ? `<ul>${cont.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}</li>`;
}).join('');
writeFileSync('dist/nouveautes.html', `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nouveautés de Brumes</title><link rel="icon" href="./icons/icon-192.png">
<style>:root{color-scheme:dark;--ink:#eef4f7;--soft:#9fb6c3;--lamp:#ffcf6b;--line:rgba(186,214,230,.16)}
body{margin:0;background:#0e2533;color:var(--ink);font:15px/1.5 Figtree,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:620px;margin:0 auto;padding:28px 18px 40px}h1{font:800 34px/1.1 Georgia,serif;margin:0 0 6px}
.lead{color:var(--soft);margin:0 0 22px}.lead a,.back{color:var(--lamp)}ol{list-style:none;margin:0;padding:0;display:grid;gap:14px}
ol>li{background:#10232f;border:1px solid var(--line);border-radius:14px;padding:14px 16px}time{font-size:12px;color:var(--lamp);letter-spacing:.04em}
h2{font-size:17px;margin:4px 0 6px;text-wrap:balance}p{margin:0 0 6px;color:var(--soft)}ul{margin:0;padding-left:18px;color:var(--soft);display:grid;gap:3px}</style></head>
<body><main><h1>Nouveautés</h1><p class="lead">${channel === 'preview' ? 'Aperçu de test' : 'Version publique'} · construite le ${fmt(info.date)}${info.sha ? ` (${info.sha})` : ''} · <a href="./">ouvrir le jeu</a></p><ol>${items}</ol></main></body></html>`);
console.log(`Build ${channel} ${version} prêt dans dist/`);
