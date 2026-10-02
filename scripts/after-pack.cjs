const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// electron-builder's resource walk skips nested node_modules. Explicitly copy
// these staged, Node-ABI dependencies after its normal resource copy finishes.
module.exports = async context => {
  const source = path.join(context.packager.projectDir, 'build', 'runtime', 'node_modules');
  const target = path.join(context.appOutDir, 'resources', 'runtime', 'node_modules');
  const required = ['better-sqlite3/package.json', 'better-sqlite3/lib/index.js', 'better-sqlite3/build/Release/better_sqlite3.node', 'bindings/bindings.js', 'file-uri-to-path/index.js'];
  for (const file of required) {
    if (!fs.existsSync(path.join(source, file))) throw new Error(`Missing staged runtime dependency: ${file}`);
  }
  const manifest = {};
  function copyAndVerify(from, to, relative = '') {
    if (fs.statSync(from).isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      for (const name of fs.readdirSync(from)) copyAndVerify(path.join(from, name), path.join(to, name), relative ? `${relative}/${name}` : name);
      return;
    }
    fs.copyFileSync(from, to);
    const hash = content => crypto.createHash('sha256').update(content).digest('hex');
    const expected = hash(fs.readFileSync(from));
    if (hash(fs.readFileSync(to)) !== expected) throw new Error(`Runtime copy mismatch: ${relative}`);
    manifest[relative] = expected;
  }
  copyAndVerify(source, target);
  fs.writeFileSync(path.join(target, '..', 'dependencies-manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`  Runtime dependencies verified: ${Object.keys(manifest).length} files`);
};
