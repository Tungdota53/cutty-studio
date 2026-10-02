import { describe, expect, it } from 'vitest';
import { parseTeamPlan } from '../src/teamwork.js';
import { executionBatch } from '../src/team-protocol.js';
import { scheduleRepair } from '../src/team-repair.js';
import { taskHandoff } from '../src/handoff.js';
import { qualityGate, type TaskEvidence } from '../src/team-artifacts.js';

const plan = () => parseTeamPlan(JSON.stringify({ tasks: [
  { id: 'code', role: 'coder', title: 'Code', expectedFiles: ['src/a.ts'] },
  { id: 'test', role: 'tester', title: 'Test', dependencies: ['code'] },
  { id: 'review', role: 'reviewer', title: 'Review', dependencies: ['test'] },
  { id: 'audit', role: 'tester', phase: 'audit', title: 'Audit', dependencies: ['review'] }
] }));
describe('Anti-style phase and ownership protocol', () => {
  it('runs disjoint workers together and serializes colliding or undeclared writers', () => {
    const tasks = parseTeamPlan(JSON.stringify({ tasks: [
      { id: 'a', role: 'coder', title: 'A', expectedFiles: ['src/a.ts'] },
      { id: 'b', role: 'coder', title: 'B', expectedFiles: ['src/b.ts'] },
      { id: 'c', role: 'coder', title: 'C', expectedFiles: ['SRC/A.ts'] }
    ] }));
    expect(executionBatch(tasks, 4).map(task => task.id)).toEqual(['a', 'b']);
    tasks[0].expectedFiles = [];
    expect(executionBatch(tasks, 4)).toEqual([tasks[0]]);
  });
  it('rejects incompatible phases and ambiguous or escaping file ownership', () => {
    for (const task of [{ role: 'coder', phase: 'audit' }, { role: 'coder', expectedFiles: ['../x'] }, { role: 'coder', expectedFiles: ['src/**'] }, { role: 'coder', expectedFiles: ['C:\\x'] }]) expect(() => parseTeamPlan(JSON.stringify({ tasks: [{ id: 'a', title: 'A', ...task }] }))).toThrow();
  });
  it('invalidates old checks and creates a bounded repair without weakening criteria', () => {
    const tasks = plan(); tasks.forEach(task => task.status = 'completed');
    tasks[2].status = 'failed'; tasks[2].resultSummary = '{"verdict":"FAIL","findings":["bug"]}';
    const repair = scheduleRepair(tasks, tasks[2], 'bug', 1)!;
    expect(repair.expectedFiles).toEqual(['src/a.ts']); expect(repair.dependencies).toEqual(['code']);
    for (const task of tasks.slice(1, 4)) { expect(task.status).toBe('pending'); expect(task.dependencies).toContain(repair.id); expect(task.resultSummary).toBeUndefined(); }
    expect(scheduleRepair(tasks, tasks[2], 'bug', 3)).toBeUndefined();
  });
  it('withholds prior verdicts from fresh forensic audit context', () => {
    const tasks = plan(); tasks[2].status = 'completed'; tasks[2].resultSummary = 'PRIOR_PASS_DO_NOT_TRUST';
    const context = taskHandoff('Goal', tasks[3], tasks, 6000, true);
    expect(JSON.stringify(context)).not.toContain('PRIOR_PASS_DO_NOT_TRUST');
    expect(JSON.stringify(context)).toContain('Fresh audit');
  });
  it('requires all review verdicts and gives auditor a veto over success', () => {
    const tasks = plan(); tasks.forEach(task => { task.status = 'completed'; task.resultSummary = '{"verdict":"PASS","findings":[]}'; });
    const proof = (): TaskEvidence => ({ inspected: true, successfulChecks: 1, failedChecks: 0, toolErrors: 0 });
    const evidence = new Map(tasks.map(task => [task.id, proof()]));
    expect(qualityGate(tasks, evidence).verdict).toBe('PASS');
    tasks[3].resultSummary = '{"verdict":"FAIL","findings":["integrity violation"]}';
    expect(qualityGate(tasks, evidence).verdict).toBe('FAIL');
    tasks[3].resultSummary = '{"verdict":"PASS","findings":[]}';
    const second = { ...tasks[2], id: 'review2', resultSummary: 'unstructured claim' }; tasks.push(second); evidence.set(second.id, proof());
    expect(qualityGate(tasks, evidence).verdict).toBe('UNVERIFIED');
  });
  it('refuses success for stale evidence and for required commands that never ran', () => {
    const tasks = plan(); tasks.forEach(task => { task.status = 'completed'; task.resultSummary = '{"verdict":"PASS","findings":[]}'; });
    tasks[1].verificationCommands = ['npm test'];
    const evidence = new Map(tasks.map(task => [task.id, { inspected: true, successfulChecks: 1, failedChecks: 0, toolErrors: 0 } as TaskEvidence]));
    expect(qualityGate(tasks, evidence).verdict).toBe('UNVERIFIED');
    evidence.get('test')!.checks = [{ command: 'npm test', exitCode: 0, excerpt: 'passed' }];
    expect(qualityGate(tasks, evidence).verdict).toBe('PASS');
    evidence.get('test')!.stale = true;
    expect(qualityGate(tasks, evidence).verdict).toBe('UNVERIFIED');
  });
});
