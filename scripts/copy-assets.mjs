import fs from 'node:fs';
fs.mkdirSync('dist/studio/public', { recursive: true });
for (const name of fs.readdirSync('src/studio/public')) fs.copyFileSync(`src/studio/public/${name}`, `dist/studio/public/${name}`);
fs.cpSync('src/skills', 'dist/skills', { recursive: true });
