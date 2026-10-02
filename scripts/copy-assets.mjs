import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
execFileSync(process.execPath, ['--check', 'src/studio/public/app.js']);
fs.mkdirSync('dist/studio/public', { recursive: true });
for (const name of fs.readdirSync('src/studio/public')) fs.copyFileSync(`src/studio/public/${name}`, `dist/studio/public/${name}`);
fs.cpSync('src/skills', 'dist/skills', { recursive: true });
fs.cpSync('src/vendor-skills', 'dist/vendor-skills', { recursive: true });
