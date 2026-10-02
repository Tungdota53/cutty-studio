import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const sources = { anthropic: { repository: 'anthropics/skills', commit: '8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4', prefix: 'skills' }, openai: { repository: 'openai/skills', commit: '49f948faa9258a0c61caceaf225e179651397431', prefix: 'skills/.curated' } };
for (const [owner, source] of Object.entries(sources)) {
  for (const name of fs.readdirSync(`src/vendor-skills/${owner}`)) {
    const root = `src/vendor-skills/${owner}/${name}`, files = {};
    function walk(dir) {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, item.name);
        if (item.isSymbolicLink()) throw new Error('Unexpected vendor symlink');
        if (item.isDirectory()) walk(file);
        else if (item.name !== '.provenance.json') files[path.relative(root, file).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      }
    }
    walk(root);
    const license = fs.readFileSync(path.join(root, 'LICENSE.txt'), 'utf8');
    if (!license.includes('Apache License') || !license.includes('Version 2.0')) throw new Error(`Review license: ${name}`);
    fs.writeFileSync(path.join(root, '.provenance.json'), JSON.stringify({ ...source, path: `${source.prefix}/${name}`, license: 'Apache-2.0', url: `https://github.com/${source.repository}/tree/${source.commit}/${source.prefix}/${name}`, files }, null, 2));
  }
}
