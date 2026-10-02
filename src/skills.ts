import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { roleProfile } from './roles.js';
import type { Role } from './types.js';
import type { Config } from './config.js';
import { safePath, isSensitivePath } from './security.js';

export interface Skill { id: string; name: string; description: string; source: string; file: string }
// Bundled builds place the same assets next to desktop-host.mjs.
const bundled = path.join(path.dirname(fileURLToPath(import.meta.url)), 'skills');
export class SkillLibrary {
  constructor(private workspace: string, private userRoot = path.join(os.homedir(), '.codex', 'skills'), private builtins = bundled) {}
  list(): Skill[] {
    const result: Skill[] = [];
    for (const [source, root] of [['project', path.join(this.workspace, '.agents', 'skills')], ['workspace', path.join(this.workspace, '.vibe', 'skills')], ['user', this.userRoot], ['builtin', this.builtins]]) {
      if (['project', 'workspace'].includes(source)) {
        try { safePath(this.workspace, path.relative(this.workspace, root)); } catch { continue; }
      }
      const walk = (dir: string, depth: number) => {
        if (depth > 3 || result.length >= 300) return;
        try {
          for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!item.isDirectory() || item.isSymbolicLink()) continue;
            const folder = path.join(dir, item.name), file = path.join(folder, 'SKILL.md');
            if (fs.existsSync(file)) {
              try {
                safePath(root, path.relative(root, file));
                if (fs.statSync(file).size > 64000) continue;
                const content = fs.readFileSync(file, 'utf8');
                const metadata = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
                const field = (name: string) => metadata?.[1].match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1].trim().replace(/^['"]|['"]$/g, '');
                result.push({ id: `${source}:${path.relative(root, folder).split(path.sep).join('/')}`, name: field('name') || item.name, description: (field('description') || '').slice(0, 1200), source, file });
              } catch { /* Skip invalid or escaped skill paths. */ }
            } else walk(folder, depth + 1);
          }
        } catch { /* Optional directories may be absent. */ }
      };
      walk(root, 0);
    }
    return result;
  }
  resolve(id: string) {
    const list = this.list();
    const exact = list.find(skill => skill.id === id);
    if (exact) return exact;
    const named = list.filter(skill => skill.name === id);
    if (named.length !== 1) throw new Error(named.length ? `Skill trùng tên; dùng ID đầy đủ: ${id}` : `Không tìm thấy skill: ${id}`);
    return named[0];
  }
  load(id: string) {
    const skill = this.resolve(id);
    if (fs.statSync(skill.file).size > 64000) throw new Error('Skill vượt giới hạn 64 KB');
    const instructions = fs.readFileSync(skill.file, 'utf8');
    if (instructions.length > 16000) throw new Error(`Skill ${skill.id} quá dài để nạp; chia thành tài nguyên tham chiếu.`);
    return { ...skill, instructions };
  }
  resource(id: string, resource: string) {
    const skill = this.resolve(id);
    if (isSensitivePath(resource)) throw new Error('Tài nguyên chứa thông tin nhạy cảm bị chặn');
    const file = safePath(path.dirname(skill.file), resource);
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > 32000) throw new Error('Tài nguyên phải là tệp văn bản tối đa 32 KB');
    return fs.readFileSync(file, 'utf8');
  }
  search(query: string) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.list().map(skill => ({ ...skill, score: terms.reduce((score, term) => score + (skill.name.toLowerCase().includes(term) ? 3 : skill.description.toLowerCase().includes(term) ? 1 : 0), 0) })).filter(skill => !terms.length || skill.score > 0).sort((a, b) => b.score - a.score).slice(0, 20);
  }
  select(role: Role, task: string, config?: Partial<Config>, explicit: string[] = []) {
    const profile = roleProfile(role, config);
    const selected = [...new Set([...profile.skills, ...explicit])].map(id => this.load(id));
    // Automatic discovery is limited to project skills; user/system skills require explicit selection.
    if (profile.autoSkills) for (const skill of this.search(task).filter(skill => ['project', 'workspace'].includes(skill.source) && skill.score >= 3)) {
      if (selected.length >= 4) break;
      if (!selected.some(item => item.id === skill.id)) selected.push(this.load(skill.id));
    }
    if (selected.reduce((n, skill) => n + skill.instructions.length, 0) > 24000) throw new Error('Tổng skill vượt ngân sách 24.000 ký tự; chọn ít skill hơn.');
    return selected;
  }
}
