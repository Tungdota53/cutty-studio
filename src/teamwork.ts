import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Config } from './config.js';
import type { Task, Role, TeamworkEvent } from './types.js';
import { ModelClient } from './model.js';
import { ModelRouter } from './router.js';
import { Store } from './db.js';
import { EventLog } from './events.js';
import { Tools } from './tools.js';
import { Agent } from './agent.js';
import { assertDag, updateReady } from './dag.js';
import { Worktrees } from './worktree.js';
import { taskHandoff } from './handoff.js';
import { newConversation } from './conversation.js';
import { z } from 'zod';
import { roleSchema, roleCatalog } from './roles.js';
import { SkillLibrary } from './skills.js';

export function parseTeamPlan(raw: string): Task[] {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Planner không trả JSON');
  const plan = z.object({ tasks: z.array(z.object({
    id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(), title: z.string().min(1).max(300), description: z.string().max(16000).optional(),
    role: roleSchema.default('coder'), dependencies: z.array(z.string()).default([]), expectedFiles: z.array(z.string()).default([]), skills: z.array(z.string().max(120)).max(8).default([])
  })).min(1).max(40) }).parse(JSON.parse(match[0]));
  const tasks: Task[] = plan.tasks.map((task, index) => ({ ...task, id: task.id || `T${index + 1}`, description: task.description || task.title, status: task.dependencies.length ? 'pending' : 'ready', createdAt: new Date().toISOString(), retries: 0 }));
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error('Task ID bị trùng');
  assertDag(tasks);
  return tasks;
}

export class Teamwork {
  tasks: Task[] = [];
  agents = new Map<string, { role: Role; status: string; model: string }>();
  private abort = new AbortController();

  constructor(
    private c: Config,
    private db: Store,
    private client: ModelClient,
    private router: ModelRouter,
    private approve: (x: string) => Promise<boolean>
  ) {}

  stop() {
    this.abort.abort();
  }

  private parsePlan(raw: string): Task[] {
    return parseTeamPlan(raw);
  }

  async run(
    goal: string,
    onEvent: (event: TeamworkEvent | string) => void = console.log
  ) {
    const emit = (event: TeamworkEvent) => {
      if (onEvent) {
        try {
          onEvent(event);
        } catch {
          // Prevent listener exceptions from breaking teamwork orchestration
        }
      }
    };

    const id = `session-${crypto.randomBytes(4).toString('hex')}`;
    const root = path.join(this.c.workspace, '.vibe');
    fs.mkdirSync(root, { recursive: true });
    const log = new EventLog(root, id);
    this.db.session(id, 'running', this.c.model, goal);

    emit({
      type: 'session_start',
      message: `Teamwork: ${id} started for goal: ${goal}`,
      timestamp: new Date().toISOString(),
    });

    const library = new SkillLibrary(this.c.workspace);
    const baseTools = new Tools(this.c.workspace, this.approve, 'planner', library);
    const plannerId = 'agent-plan-01';
    const planner = new Agent(plannerId, 'planner', this.c.workspace, this.client, this.router, baseTools, log);

    this.agents.set(plannerId, { role: 'planner', status: 'running', model: this.c.model });
    this.db.agent(id, { id: plannerId, role: 'planner', status: 'running', model: this.c.model });

    emit({
      type: 'planner_start',
      agentId: plannerId,
      role: 'planner',
      status: 'running',
      message: 'Planner đang phân tích repository và lên kế hoạch...',
      timestamp: new Date().toISOString(),
    });

    let planRaw: string;
    try {
      planRaw = await planner.run(
        `Inspect repository and plan this goal: ${goal}. Return ONLY JSON {"summary":"...","tasks":[{"id":"T1","title":"...","description":"...","role":"coder","dependencies":[],"expectedFiles":[],"skills":[]}]} Allowed roles: ${JSON.stringify(roleCatalog)}. Include implementation tasks, a tester task depending on coders, then reviewer depending on tester. Skill catalog (select exact IDs, do not invent): ${JSON.stringify(library.list().map(({ id, name, description }) => ({ id, name, description })))}`,
        this.abort.signal, undefined, [], { onSkills: skills => emit({ type: 'agent_status', agentId: plannerId, role: 'planner', status: 'running', skills: skills.map(skill => skill.id), message: 'Planner đã nạp skill lập kế hoạch.' }) }
      );
      this.tasks = this.parsePlan(planRaw);
      assertDag(this.tasks);

      this.agents.set(plannerId, { role: 'planner', status: 'idle', model: this.c.model });
      this.db.agent(id, { id: plannerId, role: 'planner', status: 'idle', model: this.c.model });

      emit({
        type: 'planner_done',
        agentId: plannerId,
        role: 'planner',
        status: 'idle',
        message: `Kế hoạch gồm ${this.tasks.length} tasks đã sẵn sàng`,
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      const isAborted = this.abort.signal.aborted;
      const status = isAborted ? 'cancelled' : 'failed';
      this.agents.set(plannerId, { role: 'planner', status, model: this.c.model });
      this.db.agent(id, { id: plannerId, role: 'planner', status, model: this.c.model });

      emit({
        type: 'task_failed',
        agentId: plannerId,
        role: 'planner',
        status,
        message: `Planner error: ${e}`,
        timestamp: new Date().toISOString(),
      });
      throw e;
    }

    this.tasks.forEach(t => this.db.task(id, t));
    fs.mkdirSync(path.join(root, 'sessions', id), { recursive: true });
    fs.writeFileSync(path.join(root, 'sessions', id, 'plan.md'), planRaw);

    const worktrees = new Worktrees(this.c.workspace, root);

    while (this.tasks.some(t => !['completed', 'failed', 'blocked', 'cancelled'].includes(t.status))) {
      updateReady(this.tasks);
      const ready = this.tasks.filter(t => t.status === 'ready').slice(0, this.c.maxAgents);
      if (!ready.length) {
        if (!this.tasks.some(t => !['completed', 'failed', 'blocked', 'cancelled'].includes(t.status))) {
          break;
        }
        const deadlockError = new Error('Scheduler deadlock: không có task ready');
        this.tasks.filter(t => t.status === 'pending').forEach(t => {
          t.status = 'blocked';
          this.db.task(id, t);
        });
        throw deadlockError;
      }

      await Promise.all(
        ready.map(async (t, index) => {
          t.status = 'running';
          t.startedAt = new Date().toISOString();
          const aid = `agent-${t.role}-${String(this.tasks.indexOf(t) + 1).padStart(2, '0')}`;
          t.assignedAgentId = aid;
          let scope = this.c.workspace;
          let selectedModel = this.c.model;

          try {
            if (t.role === 'coder' && this.c.useWorktrees) {
              const dirty = await worktrees.status();
              if (dirty) {
                throw new Error('Workspace dirty; từ chối tạo/merge worktree để bảo vệ thay đổi user');
              }
              const wt = await worktrees.create(id, aid);
              scope = wt.dir;
              t.worktreePath = scope;
            }

            const d = this.router.route({
              role: t.role,
              taskType: 'coding',
              complexity: 5,
              contextTokens: 1000,
              requiresTools: true,
              requiresLongContext: false,
            });
            selectedModel = d.selectedModel;

            this.agents.set(aid, { role: t.role, status: 'running', model: selectedModel });
            this.db.agent(id, {
              id: aid,
              role: t.role,
              status: 'running',
              model: selectedModel,
              currentTaskId: t.id,
              worktreePath: t.worktreePath,
            });

            emit({
              type: 'task_start',
              agentId: aid,
              role: t.role,
              status: 'running',
              taskId: t.id,
              message: `Task ${t.id} [${t.role}]: ${t.title}`,
              timestamp: new Date().toISOString(),
            });

            emit({
              type: 'agent_status',
              agentId: aid,
              role: t.role,
              status: 'running',
              taskId: t.id,
              message: `Thực hiện ${t.title}`,
              timestamp: new Date().toISOString(),
            });

            const agent = new Agent(aid, t.role, scope, this.client, this.router, new Tools(scope, this.approve, t.role, library), log);
            const memoryKey = `${id}:${t.id}`;
            const state = newConversation(taskHandoff(goal, t, this.tasks, Math.floor((this.c.contextWindow || 32768) / 5)));
            t.resultSummary = await agent.run(t.description, this.abort.signal, undefined, [], {
              state,
              skills: t.skills,
              skillWorkspace: this.c.workspace,
              onSkills: skills => {
                t.loadedSkills = skills.map(skill => skill.id);
                this.db.task(id, t);
                emit({ type: 'agent_status', agentId: aid, role: t.role, taskId: t.id, status: 'running', model: selectedModel, skills: t.loadedSkills, message: `${roleCatalog[t.role].label}: đã nạp ${skills.length} skill.` });
              },
              checkpoint: memory => this.db.saveConversation(memoryKey, memory),
              onItem: item => this.db.archiveItem(memoryKey, item)
            });
            t.status = 'completed';
            t.completedAt = new Date().toISOString();

            this.agents.set(aid, { role: t.role, status: 'idle', model: selectedModel });
            this.db.agent(id, {
              id: aid,
              role: t.role,
              status: 'idle',
              model: selectedModel,
              currentTaskId: undefined,
            });

            emit({
              type: 'task_complete',
              agentId: aid,
              role: t.role,
              status: 'completed',
              taskId: t.id,
              message: `Task ${t.id} hoàn tất: ${t.title}`,
              timestamp: new Date().toISOString(),
            });
          } catch (e) {
            const isAborted = this.abort.signal.aborted;
            const status = isAborted ? 'cancelled' : 'failed';
            t.status = status;
            t.error = String(e);

            this.agents.set(aid, {
              role: t.role,
              status,
              model: selectedModel,
            });
            this.db.agent(id, {
              id: aid,
              role: t.role,
              status,
              model: selectedModel,
              currentTaskId: undefined,
            });

            emit({
              type: 'task_failed',
              agentId: aid,
              role: t.role,
              status,
              taskId: t.id,
              message: String(e),
              timestamp: new Date().toISOString(),
            });
          } finally {
            this.db.task(id, t);
          }
        })
      );
    }

    const failed = this.tasks.filter(t => t.status !== 'completed');
    const status = failed.length ? 'failed' : 'completed';
    this.db.session(id, status, this.c.model, goal);

    return {
      id,
      status,
      tasks: this.tasks,
      agents: [...this.agents.entries()],
      verified: !failed.length,
      failures: failed.map(x => x.error),
    };
  }
}
