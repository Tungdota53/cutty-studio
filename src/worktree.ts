import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';

export interface WorkspaceGit { worktrees: boolean; reason: 'ready' | 'not-repository' | 'no-commit' | 'git-unavailable' }
export class Worktrees {
  constructor(private workspace: string, private root: string) {}
  async inspect(): Promise<WorkspaceGit> {
    try {
      const repo = await execa('git', ['rev-parse', '--is-inside-work-tree'], { cwd: this.workspace, reject: false });
      if (repo.exitCode !== 0 || repo.stdout.trim() !== 'true') {
        if (/not a git repository/i.test(repo.stderr) || repo.stdout.trim() === 'false') return { worktrees: false, reason: 'not-repository' };
        throw new Error(`Không kiểm tra được Git: ${repo.stderr.trim()}`);
      }
      const head = await execa('git', ['rev-parse', '--verify', 'HEAD'], { cwd: this.workspace, reject: false });
      if (head.exitCode !== 0) return { worktrees: false, reason: 'no-commit' };
      return { worktrees: true, reason: 'ready' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { worktrees: false, reason: 'git-unavailable' };
      throw error;
    }
  }
  async create(session: string, agent: string) {
    const dir = path.join(this.root, 'worktrees', session, agent), branch = `vibe/${session}/${agent}`;
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await execa('git', ['worktree', 'add', '-b', branch, dir], { cwd: this.workspace });
    return { dir, branch };
  }
  async diff(dir: string) { return (await execa('git', ['diff', '--no-ext-diff'], { cwd: dir })).stdout; }
  async status() {
    // Runtime logs, SQLite and worktrees are app-owned state, not user source changes.
    return (await execa('git', ['status', '--porcelain', '--', '.', ':(exclude).vibe', ':(exclude).vibe/**'], { cwd: this.workspace })).stdout;
  }
}
