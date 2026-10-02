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
import { roleSchema, roleCatalog, assignedAgent } from './roles.js';
import { SkillLibrary } from './skills.js';
import { dependencyFingerprints, qualityGate, recordEvidence, reviewVerdict, staleEvidence, structuredHandoff, writeAgentArtifact, type TaskEvidence } from './team-artifacts.js';
import { executionBatch, handoffContract, phaseAgents, phaseSchema, taskPhase, validateProtocol } from './team-protocol.js';
import { scheduleRepair } from './team-repair.js';

export function parseTeamPlan(raw: string): Task[] {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Planner không trả JSON');
  const plan = z.object({ tasks: z.array(z.object({
    id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(), title: z.string().min(1).max(300), description: z.string().max(16000).optional(),
    role: roleSchema.default('coder'), phase: phaseSchema.optional(), acceptanceCriteria: z.array(z.string().max(1000)).max(30).default([]), verificationCommands: z.array(z.string().max(2000)).max(12).default([]), agentId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(), dependencies: z.array(z.string()).default([]), expectedFiles: z.array(z.string()).max(200).default([]), skills: z.array(z.string().max(120)).max(8).default([])
  })).min(1).max(40) }).parse(JSON.parse(match[0]));
  const tasks: Task[] = plan.tasks.map((task, index) => ({ ...task, id: task.id || `T${index + 1}`, description: task.description || task.title, status: task.dependencies.length ? 'pending' : 'ready', createdAt: new Date().toISOString(), retries: 0 }));
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error('Task ID bị trùng');
  assertDag(tasks);
  validateProtocol(tasks);
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
    const sessionRoot = path.join(root, 'sessions', id);
    fs.mkdirSync(sessionRoot, { recursive: true });
    fs.writeFileSync(path.join(sessionRoot, 'ORIGINAL_REQUEST.md'), `# Original request\n\n${goal}\n`);
    const evidence = new Map<string, TaskEvidence>();
    let repairRounds = 0;
    this.db.session(id, 'running', this.c.model, goal);
    const worktrees = new Worktrees(this.c.workspace, root);
    let implementationWorkspace: Promise<{ dir: string; branch: string }> | undefined;
    let git;
    try { git = await worktrees.inspect(); }
    catch (error) { this.db.session(id, 'failed', this.c.model); throw error; }
    const isolated = this.c.useWorktrees && git.worktrees;
    const workspaceMode = isolated ? 'git-worktree' : 'shared-folder';

    emit({
      type: 'session_start',
      sessionId: id,
      goal,
      workspaceMode,
      workspaceReason: git.reason,
      message: `Teamwork: ${id} started for goal: ${goal}`,
      timestamp: new Date().toISOString(),
    });
    if (!isolated) emit({ type: 'agent_status', workspaceMode, message: 'Teamwork làm trong thư mục dự án. Worker chỉ chạy song song khi khai báo các tệp riêng; kiểm tra/gate chạy lần lượt.' });

    const library = new SkillLibrary(this.c.workspace);
    const baseTools = new Tools(this.c.workspace, this.approve, 'planner', library);
    const plannerId = 'agent-plan-01';
    const namedPlanner = this.c.namedAgents?.find(agent => agent.enabled && agent.role === 'planner');
    const plannerModel = this.router.route({ role: 'planner', agentId: namedPlanner?.id, taskType: 'planning', complexity: 5, contextTokens: 1000, requiresTools: true, requiresLongContext: false }).selectedModel;
    const planner = new Agent(plannerId, 'planner', this.c.workspace, this.client, this.router, baseTools, log);

    this.agents.set(plannerId, { role: 'planner', status: 'running', model: plannerModel });
    this.db.agent(id, { id: plannerId, role: 'planner', status: 'running', model: plannerModel });

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
        `Workspace mode: ${workspaceMode}; Git state: ${git.reason}. In shared-folder mode use project files directly; do not require Git commands. Inspect workspace and plan this goal: ${goal}. Return ONLY JSON {"summary":"...","tasks":[{"id":"T1","title":"...","description":"...","role":"coder","dependencies":[],"expectedFiles":[],"skills":[]}]} Available named agents (use agentId with matching role, prefer these when enabled): ${JSON.stringify(this.c.namedAgents?.filter(agent => agent.enabled) || [])}. Allowed roles: ${JSON.stringify(roleCatalog)}. For code changes first survey/specify as needed, assign non-overlapping exact expectedFiles to each implementation or test-writer task, then executed tester checks, independent reviewer, and challenger/auditor for security-sensitive or substantial changes. Use specialized named agents with matching roles; do not assign test writing to a tester (it cannot write). Every implementation must have dependent testing and review. All implementation tasks share one session worktree. Parallel workers must declare disjoint exact expectedFiles. Return phase, acceptanceCriteria and verificationCommands for each task. Allowed phases: survey, specification, test_design, implementation, verification, review, challenge, audit, acceptance. For substantial project changes include specification, test writing, implementation, execution checks, all relevant independent reviewers, challenger, forensic auditor and a final fresh victory-auditor. Auditor must depend on reviews/challenges and implementations; acceptance must follow audit. Keep greetings and small tasks proportional. Every gate task reports JSON verdict PASS/FAIL/UNVERIFIED with findings and five handoff components. Explicit verificationCommands must actually execute through tools. For greetings/questions use a general task to answer directly; do not invent a website or code requirement. Skill catalog (select exact IDs, do not invent): ${JSON.stringify(library.list().map(({ id, name, description }) => ({ id, name, description })))}`,
        this.abort.signal, undefined, [], {
          namedAgentId: namedPlanner?.id, agentConfig: this.c, skillTask: goal,
          checkpoint: memory => { this.db.saveConversation(`${id}:planner`, memory); writeAgentArtifact(sessionRoot, plannerId, 'BRIEFING.md', `# Planner briefing\n\nGoal: ${goal}\nModel: ${plannerModel}\nRole: planner (read-only)\nCheckpoint: ${id}:planner\nCompactions: ${memory.compactions}\n${memory.summary}\n`); },
          onItem: item => { this.db.archiveItem(`${id}:planner`, item); writeAgentArtifact(sessionRoot, plannerId, 'progress.md', `RUNNING\nLast update: ${new Date().toISOString()}\nStep: ${item.role}\n`); },
          onSkills: skills => emit({ type: 'agent_status', agentId: plannerId, role: 'planner', status: 'running', skills: skills.map(skill => skill.id), message: 'Planner đã nạp skill lập kế hoạch.' })
        }
      );
      this.tasks = this.parsePlan(planRaw);
      for (const task of this.tasks) assignedAgent(this.c, task.agentId, task.role);
      assertDag(this.tasks);
      writeAgentArtifact(sessionRoot, plannerId, 'handoff.md', planRaw);
      writeAgentArtifact(sessionRoot, plannerId, 'progress.md', 'COMPLETED\n');

      this.agents.set(plannerId, { role: 'planner', status: 'idle', model: plannerModel });
      this.db.agent(id, { id: plannerId, role: 'planner', status: 'idle', model: plannerModel });

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
      this.db.session(id, status, this.c.model, goal);
      fs.writeFileSync(path.join(sessionRoot, 'GATE_STATUS.md'), `# Acceptance: FAIL\n\nPlanning ${status}: ${String(e)}\n`);
      writeAgentArtifact(sessionRoot, plannerId, 'progress.md', `${status.toUpperCase()}\n${String(e)}\n`);
      this.agents.set(plannerId, { role: 'planner', status, model: plannerModel });
      this.db.agent(id, { id: plannerId, role: 'planner', status, model: plannerModel });

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
    const snapshot = () => emit({ type: 'task_snapshot', sessionId: id, tasks: this.tasks.map(task => ({ ...task, phase: taskPhase(task) })), timestamp: new Date().toISOString() });
    snapshot();
    fs.mkdirSync(path.join(root, 'sessions', id), { recursive: true });
    fs.writeFileSync(path.join(root, 'sessions', id, 'plan.md'), planRaw);
    fs.writeFileSync(path.join(sessionRoot, 'PROJECT.md'), `# Teamwork\n\nGoal: ${goal}\n\nWorkspace mode: ${workspaceMode}\n\nWorkflow: survey → specification → implementation/test writing → executed tests → independent review → adversarial checks/audit when warranted. Handoff summaries are claims; acceptance requires recorded tool evidence.\n`);

    while (this.tasks.some(t => !['completed', 'failed', 'blocked', 'cancelled'].includes(t.status))) {
      updateReady(this.tasks);
      this.tasks.filter(t => t.status === 'blocked').forEach(t => {
        t.error ||= `Bị chặn bởi tác vụ: ${t.dependencies.filter(dep => ['failed', 'blocked', 'cancelled'].includes(this.tasks.find(task => task.id === dep)!.status)).join(', ')}`;
        this.db.task(id, t);
      });
      const ready = executionBatch(this.tasks, this.c.maxAgents);
      snapshot();
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
          const candidates = this.c.namedAgents?.filter(agent => agent.enabled && agent.role === t.role) || [];
          const specialized = candidates.filter(agent => phaseAgents[taskPhase(t)]?.includes(agent.id));
          const eligible = specialized.length ? specialized : candidates;
          const assigned = assignedAgent(this.c, t.agentId || eligible[index % Math.max(eligible.length, 1)]?.id, t.role);
          t.agentId = assigned?.id;
          const aid = `agent-${t.role}-${String(this.tasks.indexOf(t) + 1).padStart(2, '0')}${t.retries ? '-r' + t.retries : ''}`;
          t.assignedAgentId = aid;
          let scope = this.c.workspace;
          let selectedModel = this.c.model;
          let attemptReport: ReturnType<typeof structuredHandoff> | undefined;
          let heartbeat: NodeJS.Timeout | undefined;

          try {
            if (t.role === 'coder' && isolated) {
              implementationWorkspace ||= (async () => {
                const dirty = await worktrees.status();
                if (dirty) throw new Error('Workspace dirty; từ chối tạo/merge worktree để bảo vệ thay đổi user');
                return worktrees.create(id, 'implementation');
              })();
              const wt = await implementationWorkspace;
              scope = wt.dir;
              t.worktreePath = scope;
            }

            const d = this.router.route({
              role: t.role,
              agentId: assigned?.id,
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
              title: t.title,
              dependencies: t.dependencies,
              agentName: assigned?.name,
              configuredAgentId: assigned?.id,
              model: selectedModel,
              agentId: aid,
              role: t.role,
              status: 'running',
              taskId: t.id,
              phase: taskPhase(t),
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

            // Inspect the implementation workspace of a single dependency chain, including worktrees.
            if (t.role !== 'coder') {
              const paths = new Set<string>();
              const visit = (task: Task, seen = new Set<string>()) => {
                if (seen.has(task.id)) return; seen.add(task.id);
                if (task.worktreePath) paths.add(task.worktreePath);
                for (const dep of task.dependencies) { const parent = this.tasks.find(item => item.id === dep); if (parent) visit(parent, seen); }
              };
              visit(t);
              if (paths.size === 1) { scope = [...paths][0]; t.worktreePath = scope; }
              if (paths.size > 1) throw new Error('Các dependency nằm trong nhiều worktree chưa tích hợp; không thể kiểm tra một bản mã thống nhất.');
            }
            const dispatch = `# ${t.title}\n\nTask: ${t.id}\nAgent: ${assigned?.name || aid}\nRole: ${t.role}\nPhase: ${taskPhase(t)}\nModel: ${selectedModel}\nWorkspace: ${scope}\nDependencies: ${t.dependencies.join(', ') || 'none'}\nAssigned write files: ${(t.expectedFiles || []).join(', ') || 'not specified; stay within task scope'}\nAcceptance criteria: ${(t.acceptanceCriteria || []).join('; ')}\nRequired verification commands (run only through normal tool permissions): ${(t.verificationCommands || []).join('; ')}\n\n${t.description}\n\n${handoffContract(t)}\n`;
            writeAgentArtifact(sessionRoot, aid, 'BRIEFING.md', `# Briefing\n\n${goal}\n\n${roleCatalog[t.role].responsibility}\n${assigned?.instructions || ''}\n`);
            writeAgentArtifact(sessionRoot, aid, 'DISPATCH.md', dispatch);
            writeAgentArtifact(sessionRoot, aid, 'progress.md', 'RUNNING\n');
            let step = 'Starting agent';
            const progress = () => writeAgentArtifact(sessionRoot, aid, 'progress.md', `# Progress\n\nStatus: RUNNING\nPhase: ${taskPhase(t)}\nTask: ${t.id}\nAttempt: ${t.retries || 0}\nLast heartbeat: ${new Date().toISOString()}\nCurrent step: ${step}\n`);
            heartbeat = setInterval(() => { try { progress(); } catch { /* The next durable checkpoint reports write failures. */ } }, 10000);
            const taskEvidence: TaskEvidence = { inspected: false, successfulChecks: 0, failedChecks: 0, toolErrors: 0 };
            if (['verification', 'review', 'challenge', 'audit', 'acceptance'].includes(taskPhase(t))) taskEvidence.files = dependencyFingerprints(t, this.tasks, scope);
            evidence.set(t.id, taskEvidence);
            const calls = new Map<string, string>();
            const agent = new Agent(aid, t.role, scope, this.client, this.router, new Tools(scope, this.approve, t.role, library, t.role === 'coder' ? t.expectedFiles : undefined, t.role === 'general'), log);
            const memoryKey = `${id}:${t.id}:attempt-${t.retries || 0}`;
            const state = newConversation(taskHandoff(goal, t, this.tasks, Math.floor((this.c.contextWindow || 32768) / 5), taskPhase(t) === 'audit'));
            state.messages.push({ role: 'user', content: dispatch });
            t.resultSummary = await agent.run(t.description, this.abort.signal, undefined, [], {
              state,
              readOnlyTask: t.role === 'general',
              skills: t.skills,
              namedAgentId: assigned?.id,
              agentConfig: this.c,
              skillWorkspace: this.c.workspace,
              onSkills: skills => {
                t.loadedSkills = skills.map(skill => skill.id);
                this.db.task(id, t);
                emit({ type: 'agent_status', agentId: aid, role: t.role, taskId: t.id, status: 'running', model: selectedModel, skills: t.loadedSkills, message: `${roleCatalog[t.role].label}: đã nạp ${skills.length} skill.` });
              },
              checkpoint: memory => {
                this.db.saveConversation(memoryKey, memory);
                writeAgentArtifact(sessionRoot, aid, 'BRIEFING.md', `# Persistent briefing\n\nGoal: ${goal}\nTask: ${t.id}\nPhase: ${taskPhase(t)}\nRole: ${t.role}\nModel: ${selectedModel}\nWorkspace: ${scope}\nOwned files: ${(t.expectedFiles || []).join(', ')}\nConversation checkpoint: ${memoryKey}\nUsage: ${JSON.stringify(memory.usage)}\nCompactions: ${memory.compactions}\n\nCurrent factual context (unverified until checked):\n${memory.summary || 'See archived conversation and DISPATCH.md.'}\n`);
              },
              onItem: item => {
                this.db.archiveItem(memoryKey, item); recordEvidence(taskEvidence, item, calls);
                step = item.tool_calls?.map(call => call.function.name).join(', ') || (item.role === 'tool' ? `Finished ${calls.get(item.tool_call_id || '') || 'tool'}` : item.role);
                emit({ type: 'agent_status', agentId: aid, taskId: t.id, status: 'running', step, timestamp: new Date().toISOString() });
                progress();
              }
            });
            if (staleEvidence(taskEvidence)) throw new Error(`Integrity veto ${t.id}: validator changed assigned source files during verification`);
            if (['verification', 'review', 'challenge', 'audit', 'acceptance'].includes(taskPhase(t)) && (taskEvidence.failedChecks > 0 || reviewVerdict(t) === 'FAIL')) throw new Error(`Validation veto ${t.id}: ${t.resultSummary || 'executed check failed'}`);
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
            const failedProof = evidence.get(t.id);
            attemptReport = structuredHandoff(t, failedProof);
            writeAgentArtifact(sessionRoot, aid, 'handoff.json', JSON.stringify(attemptReport, null, 2));
            const repair = !isAborted && ((failedProof?.failedChecks || 0) > 0 || reviewVerdict(t) === 'FAIL')
              ? scheduleRepair(this.tasks, t, String(e) + '\nExecuted checks: ' + JSON.stringify(failedProof?.checks || []), repairRounds + 1) : undefined;
            if (repair) {
              repairRounds++;
              for (const task of this.tasks) { if (task.status === 'pending') evidence.delete(task.id); this.db.task(id, task); }
              emit({ type: 'agent_status', taskId: t.id, status: 'pending', message: `Gate yêu cầu sửa: ${repair.id}. Tạo agent/context mới và chạy lại các kiểm tra phụ thuộc.` });
            }

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
            if (heartbeat) clearInterval(heartbeat);
            this.db.task(id, t);
            snapshot();
            if (!fs.existsSync(path.join(sessionRoot, 'agents', aid, 'handoff.json'))) writeAgentArtifact(sessionRoot, aid, 'handoff.json', JSON.stringify(structuredHandoff(t, evidence.get(t.id)), null, 2));
            const report = attemptReport || structuredHandoff(t, evidence.get(t.id));
            writeAgentArtifact(sessionRoot, aid, 'progress.md', `${String(report.status).toUpperCase()}\n\n${t.error || ''}\n`);
            writeAgentArtifact(sessionRoot, aid, 'handoff.md', `# Handoff ${t.id}\n\nStatus: ${report.status}\nWorkspace: ${scope}\nSkills: ${(t.loadedSkills || []).join(', ')}\nTool evidence: ${JSON.stringify(report.toolEvidence || {})}\n\n## 1. Observation\n${report.observation}\n\n## 2. Logic Chain\n${report.logicChain}\n\n## 3. Caveats\n${JSON.stringify(report.caveats)}\n\n## 4. Conclusion\n${report.conclusion}\n\n## 5. Verification Method\n${JSON.stringify(report.verificationMethod, null, 2)}\n\nInvalidation conditions: ${JSON.stringify(report.invalidationConditions)}\n`);
          }
        })
      );
    }

    const failed = this.tasks.filter(t => t.status !== 'completed');
    const status = failed.length ? 'failed' : 'completed';
    this.db.session(id, status, this.c.model, goal);
    for (const proof of evidence.values()) proof.stale = staleEvidence(proof);
    const gate = qualityGate(this.tasks, evidence);
    const rows = this.tasks.map(task => `| ${task.id} | ${taskPhase(task)} | ${task.status} | ${reviewVerdict(task)} | ${evidence.get(task.id)?.successfulChecks || 0} | ${evidence.get(task.id)?.stale ? 'STALE' : 'current'} |`).join('\n');
    fs.writeFileSync(path.join(sessionRoot, 'GATE_STATUS.md'), `# Acceptance: ${gate.verdict}\n\n${gate.reasons.map(reason => '- ' + reason).join('\n')}\n\n| Task | Phase | Execution | Report verdict | Successful checks | Source evidence |\n|---|---|---|---|---|---|\n${rows}\n\nRepair rounds: ${repairRounds}/2\nTask completion alone does not establish correctness. Successful commands are recorded execution evidence; their assertions still require review.\n`);
    fs.writeFileSync(path.join(sessionRoot, 'gate.json'), JSON.stringify({ ...gate, repairRounds, tasks: this.tasks.map(task => ({ id: task.id, phase: taskPhase(task), status: task.status, evidence: evidence.get(task.id) || null })) }, null, 2));
    const requirements = this.tasks.flatMap(task => (task.acceptanceCriteria || []).map(criterion => ({ taskId: task.id, criterion, requiredCommands: task.verificationCommands || [], checks: evidence.get(task.id)?.checks || [], stale: evidence.get(task.id)?.stale || false })));
    fs.writeFileSync(path.join(sessionRoot, 'requirements.json'), JSON.stringify({ goal, criteria: requirements, note: 'Natural-language criteria are declared contracts. Recorded execution evidence does not automatically prove every criterion; independent review/audit must evaluate them.' }, null, 2));
    emit({ type: 'session_end', sessionId: id, status, gate, timestamp: new Date().toISOString() });

    return {
      id,
      workspaceMode,
      status,
      tasks: this.tasks,
      agents: [...this.agents.entries()],
      verified: gate.verdict === 'PASS',
      gate,
      failures: failed.map(x => x.error),
    };
  }
}



