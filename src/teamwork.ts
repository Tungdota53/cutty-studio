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
import { roleSchema, roleCatalog, assignedAgent, canUseTool } from './roles.js';
import { SkillLibrary } from './skills.js';
import { dependencyFingerprints, qualityGate, recordEvidence, reviewVerdict, staleEvidence, structuredHandoff, writeAgentArtifact, type TaskEvidence } from './team-artifacts.js';
import { executionBatch, handoffContract, phaseAgents, phaseSchema, taskPhase, validateProtocol, waitingReason } from './team-protocol.js';
import { scheduleRepairs } from './team-repair.js';
import { Pipeline } from './pipeline.js';
import { planObject, validatedPlan } from './plan-recovery.js';
import { durableJson } from './checkpoints.js';
import { RunJournal } from './run-journal.js';
import { BudgetTracker } from './budgets.js';

export function parseTeamPlan(raw: string): Task[] {
  // Routers/models sometimes emit a scalar for a one-item list. Preserve the
  // whole value; never split filenames or shell commands on punctuation.
  const list = (maxLength: number, maxItems: number) => z.preprocess(value => value == null ? [] : typeof value === 'string' ? (value.trim() ? [value.trim()] : []) : value, z.array(z.string().max(maxLength)).max(maxItems));
  const plan = z.object({ tasks: z.array(z.object({
    id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(), title: z.string().min(1).max(300), description: z.string().max(16000).optional(),
    role: roleSchema.default('coder'), phase: phaseSchema.optional(), acceptanceCriteria: list(1000, 30), verificationCommands: list(2000, 12), agentId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(), dependencies: list(64, 40), expectedFiles: list(1000, 200), skills: list(120, 8)
  })).min(1).max(40) }).parse(planObject(raw));
  const tasks: Task[] = plan.tasks.map((task, index) => ({ ...task, id: task.id || `T${index + 1}`, description: task.description || task.title, status: task.dependencies.length ? 'pending' : 'ready', createdAt: new Date().toISOString(), retries: 0 }));
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error('Task ID bị trùng');
  assertDag(tasks);
  validateProtocol(tasks);
  for (const task of tasks) {
    if (task.verificationCommands?.length && !canUseTool(task.role, 'run_command', task.role === 'general')) {
      throw new Error(`Task ${task.id}: role ${task.role} cannot execute verificationCommands. Move these required commands to a coder/tester task with the appropriate dependencies; keep verificationCommands:[] for this read-only task. Preserve the checks, do not replace them with claimed results.`);
    }
  }
  return tasks;
}

export class Teamwork {
  tasks: Task[] = [];
  agents = new Map<string, { role: Role; status: string; model: string }>();
  private abort = new AbortController();
  private static readonly activeWorkspaces = new Set<string>();
  private running = false;
  private internalFailure = false;

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

  async resume(sessionId: string, onEvent: (event: TeamworkEvent | string) => void = console.log) {
    if (!/^session-[a-f0-9]{8}$/.test(sessionId)) throw new Error('Invalid Teamwork session ID');
    const saved = JSON.parse(fs.readFileSync(path.join(this.c.workspace, '.vibe', 'sessions', sessionId, 'resume.json'), 'utf8'));
    if (saved.status === 'completed') throw new Error('Teamwork session already completed');
    return this.run(saved.goal, onEvent, sessionId);
  }
  async run(goal: string, onEvent: (event: TeamworkEvent | string) => void = console.log, resumeId?: string) {
    const workspace = path.resolve(this.c.workspace).toLowerCase();
    if (this.running || Teamwork.activeWorkspaces.has(workspace)) throw new Error('Teamwork đang chạy trong workspace này. Dừng hoặc đợi phiên hiện tại kết thúc.');
    this.running = true;
    Teamwork.activeWorkspaces.add(workspace);
    this.abort = new AbortController();
    this.internalFailure = false;
    this.tasks = [];
    this.agents.clear();
    try { return await this.runSession(goal, onEvent, resumeId); }
    finally { this.running = false; Teamwork.activeWorkspaces.delete(workspace); }
  }

  private async runSession(
    goal: string,
    onEvent: (event: TeamworkEvent | string) => void = console.log,
    resumeId?: string
  ) {
    let eventLog: EventLog | undefined;
    const emit = (event: TeamworkEvent) => {
      if (event.type !== 'agent_status' && event.type !== 'task_snapshot') {
        try { eventLog?.emit('teamwork_' + event.type, { event }); } catch { /* Pipeline checkpoints remain authoritative if event logging is unavailable. */ }
      }
      if (onEvent) {
        try {
          onEvent(event);
        } catch {
          // Prevent listener exceptions from breaking teamwork orchestration
        }
      }
    };

    const id = resumeId || `session-${crypto.randomBytes(4).toString('hex')}`;
    const root = path.join(this.c.workspace, '.vibe');
    fs.mkdirSync(root, { recursive: true });
    const log = new EventLog(root, id);
    eventLog = log;
    const sessionRoot = path.join(root, 'sessions', id);
    fs.mkdirSync(sessionRoot, { recursive: true });
    fs.writeFileSync(path.join(sessionRoot, 'ORIGINAL_REQUEST.md'), `# Original request\n\n${goal}\n`);
    const resumeFile = path.join(sessionRoot, 'resume.json');
    const resumed = resumeId ? JSON.parse(fs.readFileSync(resumeFile, 'utf8')) as { goal: string; planRaw: string; tasks: Task[]; evidence: [string, TaskEvidence][]; fingerprints?: Record<string, Record<string, string | null>>; repairRounds: number; status: string } : undefined;
    const fingerprints = resumed?.fingerprints || {};
    const evidence = new Map<string, TaskEvidence>(resumed?.evidence || []);
    const pipeline = new Pipeline(sessionRoot, id, this.c.maxAgents);
    let repairRounds = resumed?.repairRounds || 0;
    const teamBudget = new BudgetTracker({ budget: this.c.runBudget, rates: this.c.modelRates });
    this.db.session(id, 'running', this.c.model, goal);
    try {
    const worktrees = new Worktrees(this.c.workspace, root);
    let implementationWorkspace: Promise<{ dir: string; branch: string }> | undefined;
    if (resumed) {
      this.tasks = resumed.tasks;
      assertDag(this.tasks);
      for (const task of this.tasks) {
        const proof = evidence.get(task.id);
        if (task.status === 'completed') {
          if ((task.role === 'coder' && (!Object.keys(fingerprints[task.id] || {}).length || staleEvidence({ files: fingerprints[task.id] } as TaskEvidence))) || (proof && staleEvidence(proof))) throw new Error(`Resume requires source verification: completed task ${task.id} has missing or changed file fingerprints. Start a fresh plan to protect user edits.`);
        } else { task.status = 'pending'; delete task.error; delete task.startedAt; delete task.completedAt; }
      }
      const scopes = [...new Set(this.tasks.map(task => task.worktreePath).filter(Boolean))];
      if (scopes.length > 1 || scopes.some(scope => !fs.existsSync(scope!))) throw new Error('Resume worktree is missing or ambiguous');
      if (scopes.length) implementationWorkspace = Promise.resolve({ dir: scopes[0]!, branch: '' });
    }
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
    if (!isolated) emit({ type: 'agent_status', workspaceMode, message: 'Teamwork làm trong thư mục dự án. Các tác vụ độc lập chạy đồng thời và lấp slot ngay khi agent kết thúc. Worker có quyền ghi tệp riêng; kiểm tra/review chạy song song khi nguồn ổn định.' });

    const library = new SkillLibrary(this.c.workspace);
    let planRaw = resumed?.planRaw || '';
    if (!resumed) {
    const baseTools = new Tools(this.c.workspace, this.approve, 'planner', library);
    const plannerId = 'agent-plan-01';
    const namedPlanner = this.c.namedAgents?.find(agent => agent.enabled && agent.role === 'planner');
    let plannerModel = this.router.route({ role: 'planner', agentId: namedPlanner?.id, taskType: 'planning', complexity: 5, contextTokens: 1000, requiresTools: true, requiresLongContext: false }).selectedModel;
    const planner = new Agent(plannerId, 'planner', this.c.workspace, this.client, this.router, baseTools, log);

    this.agents.set(plannerId, { role: 'planner', status: 'running', model: plannerModel });
    this.db.agent(id, { id: plannerId, role: 'planner', status: 'running', model: plannerModel });

    emit({
      type: 'planner_start',
      agentId: plannerId,
      agentName: namedPlanner?.name || 'Planner',
      configuredAgentId: namedPlanner?.id,
      model: plannerModel,
      role: 'planner',
      status: 'running',
      message: 'Planner đang phân tích repository và lên kế hoạch...',
      timestamp: new Date().toISOString(),
    });

    const plannerState = newConversation();
    try {
      const planned = await validatedPlan(async (attempt, feedback) => {
        const output = await planner.run(
          attempt ? feedback :
        `Workspace mode: ${workspaceMode}; Git state: ${git.reason}. In shared-folder mode use project files directly; do not require Git commands. Inspect workspace and plan this goal: ${goal}. Return ONLY JSON {"summary":"...","tasks":[{"id":"T1","title":"...","description":"...","role":"coder","dependencies":[],"expectedFiles":[],"skills":[]}]} Available named agents (use agentId with matching role, prefer these when enabled): ${JSON.stringify(this.c.namedAgents?.filter(agent => agent.enabled).map(({ id, name, role }) => ({ id, name, role })) || [])}. Allowed roles: ${JSON.stringify(roleCatalog)}. For code changes first survey/specify as needed, assign non-overlapping exact expectedFiles to each implementation or test-writer task, then executed tester checks, independent reviewer, and challenger/auditor for security-sensitive or substantial changes. Use specialized named agents with matching roles; do not assign test writing to a tester (it cannot write). Every implementation must have dependent testing and review. All implementation tasks share one session worktree. Parallel workers must declare disjoint exact expectedFiles. Build a fan-out/fan-in DAG: run independent exploration/specification and implementation branches concurrently; sibling tests, reviews and challenges should depend on the shared implementation, not on each other unless they truly consume their outputs. Do not invent sequential dependencies just to order phases. Test-writing and implementation should be sibling coder tasks after a shared specification contract, not a test-writer-then-all-workers chain unless workers actually consume generated test output. Substantial goals should have at least two useful independent implementation tasks with disjoint files when the architecture permits. The scheduler continuously fills free slots across phases as soon as actual dependencies finish. Validators run concurrently on a stable source; repairs wait for them to drain. Return phase, acceptanceCriteria and verificationCommands for each task. List fields must use JSON arrays: acceptanceCriteria:["A complete criterion may be longer than 30 characters"], verificationCommands:["npm test"], dependencies:[], expectedFiles:[], skills:[]. Allowed phases: survey, specification, test_design, implementation, verification, review, challenge, audit, acceptance. For substantial project changes include specification, test writing, implementation, execution checks, all relevant independent reviewers, challenger, forensic auditor and a final fresh victory-auditor. Auditor must depend on reviews/challenges and implementations; acceptance must follow audit. Keep greetings and small tasks proportional. Every gate task reports JSON verdict PASS/FAIL/UNVERIFIED with findings and five handoff components. Explicit verificationCommands must actually execute through tools. Only coder and tester tasks can execute commands in Teamwork. Survey/specification/planner, orchestrator, reviewer, judge and general tasks MUST have verificationCommands:[]; assign their runtime checks to coder/tester dependencies instead. Read-only reviewers inspect actual files and recorded tester evidence. Do not use echo/console.log success messages as acceptance tests. Use only commands appropriate for the actual project: npm test requires a package.json test script; static sites can use an explicitly created Node test script. For greetings/questions use a general task to answer directly; do not invent a website or code requirement. Relevant skills (use search_skills for more; select exact IDs, never invent): ${JSON.stringify(library.search(goal).slice(0, 16).map(({ id, name, description }) => ({ id, name, description: description.slice(0, 160) })))}`,
        this.abort.signal, undefined, [], {
          state: plannerState, journal: new RunJournal(this.c.workspace, `${id}:planner`), budgetTracker: new BudgetTracker({ budget: this.c.runBudget, rates: this.c.modelRates, agentId: plannerId }), onBudget: budget => emit({ type: 'agent_status', agentId: plannerId, sessionId: id, step: 'budget', budget }), recall: (query, limit, beforeId) => this.db.recall(`${id}:planner`, query, limit, beforeId), namedAgentId: namedPlanner?.id, agentConfig: this.c, skillTask: goal,
          onModel: model => {
            plannerModel = model;
            this.agents.set(plannerId, { role: 'planner', status: 'running', model });
            this.db.agent(id, { id: plannerId, role: 'planner', status: 'running', model });
            emit({ type: 'agent_status', agentId: plannerId, agentName: namedPlanner?.name || 'Planner', role: 'planner', status: 'running', model });
          },
          checkpoint: memory => { this.db.saveConversation(`${id}:planner`, memory); writeAgentArtifact(sessionRoot, plannerId, 'BRIEFING.md', `# Planner briefing\n\nGoal: ${goal}\nModel: ${plannerModel}\nRole: planner (read-only)\nCheckpoint: ${id}:planner\nCompactions: ${memory.compactions}\n${memory.summary}\n`); },
          onItem: item => { this.db.archiveItem(`${id}:planner`, item); writeAgentArtifact(sessionRoot, plannerId, 'progress.md', `RUNNING\nLast update: ${new Date().toISOString()}\nStep: ${item.role}\n`); },
          onSkills: skills => emit({ type: 'agent_status', agentId: plannerId, role: 'planner', status: 'running', skills: skills.map(skill => skill.id), message: 'Planner đã nạp skill lập kế hoạch.' })
        }
      );
        writeAgentArtifact(sessionRoot, plannerId, `plan-attempt-${attempt + 1}.json`, output);
        return output;
      }, raw => {
        const tasks = this.parsePlan(raw);
        for (const task of tasks) assignedAgent(this.c, task.agentId, task.role);
        return tasks;
      }, this.abort.signal, (attempt, reason) => emit({ type: 'agent_status', agentId: plannerId, role: 'planner', status: 'running', step: 'plan_repair', message: `Planner đang sửa kế hoạch (${attempt}/2): ${reason}` }));
      planRaw = planned.raw;
      this.tasks = planned.value;
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

    }
    this.tasks.forEach(t => this.db.task(id, t));
    let lastSnapshot = 0;
    const snapshot = (status = 'running') => { lastSnapshot = Date.now(); durableJson(resumeFile, { version: 1, goal, planRaw, tasks: this.tasks, evidence: [...evidence], fingerprints, repairRounds, status }); emit({ type: 'task_snapshot', pipeline: pipeline.snapshot(this.tasks, evidence), sessionId: id, maxAgents: this.c.maxAgents, tasks: this.tasks.map(task => ({ ...task, phase: taskPhase(task), waitReason: waitingReason(task, this.tasks, this.c.maxAgents) })), timestamp: new Date().toISOString() }); };
    snapshot();
    fs.mkdirSync(path.join(root, 'sessions', id), { recursive: true });
    fs.writeFileSync(path.join(root, 'sessions', id, 'plan.md'), planRaw);
    fs.writeFileSync(path.join(sessionRoot, 'PROJECT.md'), `# Teamwork\n\nGoal: ${goal}\n\nWorkspace mode: ${workspaceMode}\n\nWorkflow: survey → specification → implementation/test writing → executed tests → independent review → adversarial checks/audit when warranted. Handoff summaries are claims; acceptance requires recorded tool evidence.\n`);

    const pendingRepairs: { task: Task; reason: string }[] = [];
    const executeTask = async (t: Task, index: number) => {
          t.status = 'running';
          pipeline.dispatch(this.tasks);
          t.startedAt = new Date().toISOString();
          const candidates = this.c.namedAgents?.filter(agent => agent.enabled && agent.role === t.role) || [];
          const specialized = candidates.filter(agent => phaseAgents[taskPhase(t)]?.includes(agent.id));
          const eligible = specialized.length ? specialized : candidates;
          const assigned = assignedAgent(this.c, t.agentId || eligible[index % Math.max(eligible.length, 1)]?.id, t.role);
          t.agentId = assigned?.id;
          t.agentName = assigned?.name;
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
            t.model = selectedModel;

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
            let step = 'Starting agent'; t.lastProgressAt = new Date().toISOString(); t.step = step; let stallReported = false;
            const progress = () => writeAgentArtifact(sessionRoot, aid, 'progress.md', `# Progress\n\nStatus: RUNNING\nPhase: ${taskPhase(t)}\nTask: ${t.id}\nAttempt: ${t.retries || 0}\nLast heartbeat: ${new Date().toISOString()}\nLast actual progress: ${t.lastProgressAt}\nProgress idle seconds: ${Math.floor((Date.now() - Date.parse(t.lastProgressAt!)) / 1000)}\nCurrent step: ${step}\n`);
            heartbeat = setInterval(() => { try { const idleMs = Date.now() - Date.parse(t.lastProgressAt!); t.stalled = idleMs >= 90000; if (t.stalled && !stallReported) { stallReported = true; emit({ type: 'agent_status', agentId: aid, taskId: t.id, status: 'running', stalled: true, lastProgressAt: t.lastProgressAt, step, message: `Chưa có tiến độ ${Math.floor(idleMs / 1000)} giây · ${step}. Đang chờ kết quả; heartbeat không phải tiến độ.`, timestamp: new Date().toISOString() }); } progress(); if (Date.now() - lastSnapshot >= 1000) snapshot(); } catch { /* The next durable checkpoint reports write failures. */ } }, 10000);
            const taskEvidence: TaskEvidence = resumed && evidence.get(t.id) ? evidence.get(t.id)! : { inspected: false, successfulChecks: 0, failedChecks: 0, toolErrors: 0 };
            if (['verification', 'review', 'challenge', 'audit', 'acceptance'].includes(taskPhase(t))) taskEvidence.files = dependencyFingerprints(t, this.tasks, scope);
            evidence.set(t.id, taskEvidence);
            const calls = new Map<string, string>();
            const agent = new Agent(aid, t.role, scope, this.client, this.router, new Tools(scope, this.approve, t.role, library, t.role === 'coder' ? t.expectedFiles : undefined, t.role === 'general'), log);
            const memoryKey = `${id}:${t.id}:attempt-${t.retries || 0}`;
            const journal = new RunJournal(this.c.workspace, memoryKey);
            const resumeTask = !!resumed && journal.status().resumable;
            const state = resumeTask ? this.db.conversation(memoryKey) : newConversation(taskHandoff(goal, t, this.tasks, Math.floor((this.c.contextWindow || 1048576) / 5), taskPhase(t) === 'audit'));
            const sessionMemory = this.db.conversation(id); state.pins = sessionMemory.pins; state.attachments = sessionMemory.attachments;
            state.messages.push({ role: 'user', content: dispatch });
            t.resultSummary = await agent.run(t.description, this.abort.signal, undefined, [], {
              state,
              journal, resume: resumeTask, budgetTracker: new BudgetTracker({ budget: this.c.runBudget, rates: this.c.modelRates, agentId: aid, taskId: t.id }), onBudget: budget => emit({ type: 'agent_status', agentId: aid, taskId: t.id, sessionId: id, step: 'budget', budget }),
              readOnlyTask: t.role === 'general',
              skills: t.skills,
              namedAgentId: assigned?.id,
              agentConfig: this.c,
              onModel: model => { step = 'model_request'; t.step = step; selectedModel = model; t.model = model; this.agents.set(aid, { role: t.role, status: 'running', model }); this.db.agent(id, { id: aid, role: t.role, status: 'running', model, currentTaskId: t.id }); this.db.task(id, t); emit({ type: 'agent_status', agentId: aid, taskId: t.id, status: 'running', model }); },
              skillWorkspace: this.c.workspace,
              onSkills: skills => {
                t.loadedSkills = skills.map(skill => skill.id);
                this.db.task(id, t);
                emit({ type: 'agent_status', agentId: aid, role: t.role, taskId: t.id, status: 'running', model: selectedModel, skills: t.loadedSkills, message: `${roleCatalog[t.role].label}: đã nạp ${skills.length} skill.` });
              },
              recall: (query, limit, beforeId) => this.db.recall(memoryKey, query, limit, beforeId),
              checkpoint: memory => {
                this.db.saveConversation(memoryKey, memory);
                writeAgentArtifact(sessionRoot, aid, 'BRIEFING.md', `# Persistent briefing\n\nGoal: ${goal}\nTask: ${t.id}\nPhase: ${taskPhase(t)}\nRole: ${t.role}\nModel: ${selectedModel}\nWorkspace: ${scope}\nOwned files: ${(t.expectedFiles || []).join(', ')}\nConversation checkpoint: ${memoryKey}\nUsage: ${JSON.stringify(memory.usage)}\nCompactions: ${memory.compactions}\n\nCurrent factual context (unverified until checked):\n${memory.summary || 'See archived conversation and DISPATCH.md.'}\n`);
              },
              onItem: item => {
                this.db.archiveItem(memoryKey, item); recordEvidence(taskEvidence, item, calls);
                if (t.role === 'coder' && item.role === 'tool') fingerprints[t.id] = dependencyFingerprints(t, this.tasks, scope);
                if (item.role === 'tool') pipeline.tool();
                if (Date.now() - lastSnapshot >= 1000) snapshot();
                t.lastProgressAt = new Date().toISOString(); t.stalled = false; stallReported = false; step = item.tool_calls?.map(call => call.function.name).join(', ') || (item.role === 'tool' ? `Finished ${calls.get(item.tool_call_id || '') || 'tool'}` : item.role);
                t.step = step; emit({ type: 'agent_status', agentId: aid, taskId: t.id, status: 'running', step, stalled: false, lastProgressAt: t.lastProgressAt, timestamp: new Date().toISOString() });
                progress();
              }
            });
            if (staleEvidence(taskEvidence)) throw new Error(`Integrity veto ${t.id}: validator changed assigned source files during verification`);
            if (t.role === 'coder') {
              fingerprints[t.id] = dependencyFingerprints(t, this.tasks, scope);
              if (t.id.startsWith('repair-')) for (const dependency of t.dependencies) { const original = this.tasks.find(task => task.id === dependency); if (original?.role === 'coder') fingerprints[original.id] = dependencyFingerprints(original, this.tasks, scope); }
            }
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
            if (!isAborted && ((failedProof?.failedChecks || 0) > 0 || reviewVerdict(t) === 'FAIL')) pendingRepairs.push({ task: t, reason: String(e) + '\nExecuted checks: ' + JSON.stringify(failedProof?.checks || []) });

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
    };

    const pool = new Map<string, Promise<void>>();
    let dispatchIndex = 0, fatalError: unknown;
    while (pool.size || pendingRepairs.length || this.tasks.some(t => !['completed', 'failed', 'blocked', 'cancelled'].includes(t.status))) {
      // Drain concurrent validators before a repair invalidates their source and evidence.
      if (!pool.size && pendingRepairs.length) {
        const findings = pendingRepairs.splice(0).filter(failure => failure.task.status === 'failed');
        const repair = !this.abort.signal.aborted && scheduleRepairs(this.tasks, findings, repairRounds + 1);
        if (repair) {
          repairRounds++;
          pipeline.repair(repairRounds, repair.id, findings.map(failure => `${failure.task.id}: ${failure.reason.slice(0, 500)}`));
          for (const task of this.tasks) { if (task.status === 'pending') evidence.delete(task.id); this.db.task(id, task); }
          log.emit('repair_scheduled', { round: repairRounds, repairId: repair.id, findings: findings.map(failure => ({ taskId: failure.task.id, reason: failure.reason })) });
          emit({ type: 'agent_status', taskId: repair.id, status: 'pending', message: `Vòng sửa ${repairRounds}/2: gom ${findings.length} lỗi từ ${findings.map(failure => failure.task.id).join(', ')}; chạy lại toàn bộ tác vụ phụ thuộc bị ảnh hưởng.` });
        }
      }
      if (fatalError) { if (pool.size) { await Promise.all(pool.values()); continue; } throw fatalError; }
      if (this.abort.signal.aborted) {
        for (const task of this.tasks) if (['pending', 'ready'].includes(task.status)) { task.status = 'cancelled'; this.db.task(id, task); }
      } else if (!pendingRepairs.length) {
        updateReady(this.tasks);
        this.tasks.filter(t => t.status === 'blocked').forEach(t => {
          t.error ||= `Bị chặn bởi tác vụ: ${t.dependencies.filter(dep => ['failed', 'blocked', 'cancelled'].includes(this.tasks.find(task => task.id === dep)!.status)).join(', ')}`;
          this.db.task(id, t);
        });
        for (const task of executionBatch(this.tasks, this.c.maxAgents)) {
          const promise = executeTask(task, dispatchIndex++).catch(error => { fatalError = error; this.internalFailure = true; this.abort.abort(); }).then(() => { pool.delete(task.id); });
          pool.set(task.id, promise);
        }
      }
      snapshot();
      if (pool.size) { await Promise.race(pool.values()); continue; }
      if (pendingRepairs.length) continue;
      if (this.tasks.some(t => !['completed', 'failed', 'blocked', 'cancelled'].includes(t.status))) {
        this.tasks.filter(t => ['pending', 'ready'].includes(t.status)).forEach(t => { t.status = 'blocked'; this.db.task(id, t); });
        snapshot(); throw new Error('Scheduler deadlock: không có task có thể chạy');
      }
    }
    if (fatalError) throw fatalError;

    const failed = this.tasks.filter(t => t.status !== 'completed');
    const status = this.abort.signal.aborted ? 'cancelled' : failed.length ? 'failed' : 'completed';
    this.db.session(id, status, this.c.model, goal);
    snapshot(status);
    for (const proof of evidence.values()) proof.stale = staleEvidence(proof);
    const gate = qualityGate(this.tasks, evidence);
    const rows = this.tasks.map(task => `| ${task.id} | ${taskPhase(task)} | ${task.status} | ${reviewVerdict(task)} | ${evidence.get(task.id)?.successfulChecks || 0} | ${evidence.get(task.id)?.stale ? 'STALE' : 'current'} |`).join('\n');
    fs.writeFileSync(path.join(sessionRoot, 'GATE_STATUS.md'), `# Acceptance: ${gate.verdict}\n\n${gate.reasons.map(reason => '- ' + reason).join('\n')}\n\n| Task | Phase | Execution | Report verdict | Successful checks | Source evidence |\n|---|---|---|---|---|---|\n${rows}\n\nRepair rounds: ${repairRounds}/2\nTask completion alone does not establish correctness. Successful commands are recorded execution evidence; their assertions still require review.\n`);
    fs.writeFileSync(path.join(sessionRoot, 'gate.json'), JSON.stringify({ ...gate, repairRounds, tasks: this.tasks.map(task => ({ id: task.id, phase: taskPhase(task), status: task.status, evidence: evidence.get(task.id) || null })) }, null, 2));
    const requirements = this.tasks.flatMap(task => (task.acceptanceCriteria || []).map(criterion => ({ taskId: task.id, criterion, requiredCommands: task.verificationCommands || [], checks: evidence.get(task.id)?.checks || [], stale: evidence.get(task.id)?.stale || false })));
    fs.writeFileSync(path.join(sessionRoot, 'requirements.json'), JSON.stringify({ goal, criteria: requirements, note: 'Natural-language criteria are declared contracts. Recorded execution evidence does not automatically prove every criterion; independent review/audit must evaluate them.' }, null, 2));
    emit({ type: 'session_end', sessionId: id, status, gate, pipeline: pipeline.snapshot(this.tasks, evidence, status, gate), timestamp: new Date().toISOString() });

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
    } catch (error) {
      const status = this.abort.signal.aborted && !this.internalFailure ? 'cancelled' : 'failed';
      this.db.session(id, status, this.c.model, goal);
      for (const task of this.tasks) {
        if (['pending', 'ready', 'running'].includes(task.status)) {
          task.status = status === 'cancelled' ? 'cancelled' : 'blocked';
          task.error ||= `Phiên đã dừng: ${String(error)}`;
          this.db.task(id, task);
        }
      }
      for (const [agentId, agent] of this.agents) if (agent.status === 'running') {
        agent.status = status;
        this.db.agent(id, { id: agentId, ...agent, status });
        emit({ type: 'agent_status', agentId, ...agent });
      }
      let finalPipeline;
      try { finalPipeline = pipeline.snapshot(this.tasks, evidence, status, { verdict: 'FAIL', reasons: [String(error)] }); } catch { /* Preserve the original storage failure. */ }
      emit({ type: 'task_snapshot', sessionId: id, pipeline: finalPipeline, maxAgents: this.c.maxAgents, tasks: this.tasks.map(task => ({ ...task, phase: taskPhase(task) })), timestamp: new Date().toISOString() });
      emit({ type: 'session_end', sessionId: id, status, pipeline: finalPipeline, message: String(error), gate: { verdict: 'FAIL', reasons: [String(error)] }, timestamp: new Date().toISOString() });
      throw error;
    }
  }
}



