import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const sources = {
  anthropic: { repository: 'anthropics/skills', commit: '8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4', prefix: 'skills', license: 'Apache-2.0' },
  openai: { repository: 'openai/skills', commit: '49f948faa9258a0c61caceaf225e179651397431', prefix: 'skills/.curated', license: 'Apache-2.0' },
  superpowers: { repository: 'obra/superpowers', commit: '8ca22dba9a94f28898bbce59f2537ff4d87c747d', prefix: 'skills', license: 'MIT' },
  uiux: { repository: 'nextlevelbuilder/ui-ux-pro-max-skill', commit: '09170eec67eefd46a7ae85de61b40c194020f997', prefix: '.claude/skills', license: 'MIT' },
  trailofbits: { repository: 'trailofbits/skills', commit: '82fe8226252622fa807643bdca1710901198553a', prefix: 'plugins', license: 'CC-BY-SA-4.0' }
};
const plugin = name => ['codeql', 'semgrep', 'sarif-parsing'].includes(name) ? 'static-analysis' : ['coverage-analysis', 'harness-writing'].includes(name) ? 'testing-handbook-skills' : name;
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
    const markers = { 'Apache-2.0': 'Apache License', MIT: 'MIT License', 'CC-BY-SA-4.0': 'Attribution-ShareAlike' };
    if (!license.includes(markers[source.license])) throw new Error(`Review license: ${name}`);
    const sourcePath = owner === 'trailofbits' ? `plugins/${plugin(name)}/skills/${name}` : `${source.prefix}/${name}`;
    fs.writeFileSync(path.join(root, '.provenance.json'), JSON.stringify({ ...source, path: sourcePath, url: `https://github.com/${source.repository}/tree/${source.commit}/${sourcePath}`, files }, null, 2));
  }
}
