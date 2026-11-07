// Construit le site dans dist/ : un seul fichier JS + les fichiers statiques
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
await build({ entryPoints: ['src/main.js'], bundle: true, format: 'esm', minify: true, target: 'es2020', outfile: 'dist/app.js', legalComments: 'none' });
cpSync('index.html', 'dist/index.html');
cpSync('public', 'dist', { recursive: true });
const version = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
writeFileSync('dist/sw.js', readFileSync('public/sw.js', 'utf8').replace('__BUILD__', version));
console.log(`Build ${version} prêt dans dist/`);
