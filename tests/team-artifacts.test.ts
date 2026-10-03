import { describe, expect, it } from 'vitest';
import { executionDiagnosis, qualityGate, recordEvidence, type TaskEvidence } from '../src/team-artifacts.js';
import { parseTeamPlan } from '../src/teamwork.js';

describe('Independent teamwork evidence', () => {
  it('keeps failed command evidence when the runner reports ok=false', () => {
    const evidence = { inspected: false, successfulChecks: 0, failedChecks: 0, toolErrors: 0 };
    const calls = new Map([['check', 'run_command']]);
    recordEvidence(evidence, { role: 'tool', tool_call_id: 'check', content: JSON.stringify({ ok: false, output: 'exit=7\nfailed' }) }, calls);
    expect(evidence.failedChecks).toBe(1); expect(evidence.successfulChecks).toBe(0);
    recordEvidence(evidence, { role: 'tool', tool_call_id: 'check', content: JSON.stringify({ ok: false, output: 'exit=0\nuntrusted completion' }) }, calls);
    expect(evidence.successfulChecks).toBe(0);
  });
  it('does not equate completed claims with verified implementation', () => {
    const tasks = parseTeamPlan(JSON.stringify({ tasks: [{ id: 'code', role: 'coder', title: 'Code' }, { id: 'test', role: 'tester', title: 'Test', dependencies: ['code'] }, { id: 'review', role: 'reviewer', title: 'Review', dependencies: ['test'] }] }));
    for (const task of tasks) task.status = 'completed';
    expect(qualityGate(tasks, new Map()).verdict).toBe('UNVERIFIED');
    const evidence = new Map<string, TaskEvidence>([['test', { inspected: true, successfulChecks: 1, failedChecks: 0, toolErrors: 0 }], ['review', { inspected: true, successfulChecks: 0, failedChecks: 0, toolErrors: 0 }]]);
    tasks[2].resultSummary = JSON.stringify({ verdict: 'PASS', findings: [] });
    expect(qualityGate(tasks, evidence).verdict).toBe('PASS');
    evidence.get('test')!.failedChecks++;
    expect(qualityGate(tasks, evidence).verdict).toBe('FAIL');
  });
  it('records actual tool results and rejects free-form claims as execution evidence', () => {
    const evidence = { inspected: false, successfulChecks: 0, failedChecks: 0, toolErrors: 0 };
    const calls = new Map([['check', 'run_tests'], ['read', 'read_file']]);
    recordEvidence(evidence, { role: 'assistant', content: 'Tests passed exit=0' }, calls);
    expect(evidence.successfulChecks).toBe(0);
    recordEvidence(evidence, { role: 'tool', tool_call_id: 'check', content: JSON.stringify({ ok: true, output: 'command=npm test\nexit=0\n3 passed' }) }, calls);
    recordEvidence(evidence, { role: 'tool', tool_call_id: 'read', content: JSON.stringify({ ok: true, output: 'source' }) }, calls);
    recordEvidence(evidence, { role: 'tool', tool_call_id: 'check', content: JSON.stringify({ ok: true, output: 'exit=1\nfailed' }) }, calls);
    expect(evidence).toMatchObject({ inspected: true, successfulChecks: 1, failedChecks: 1 });
  });
  it('reports context failures before downstream blocked checks without weakening acceptance', () => {
    const tasks = parseTeamPlan(JSON.stringify({ tasks: [
      { id: 'code', role: 'coder', title: 'Code' },
      { id: 'test', role: 'tester', title: 'Test', dependencies: ['code'], verificationCommands: ['npm test'] },
      { id: 'review', role: 'reviewer', title: 'Review', dependencies: ['test'] },
    ] }));
    tasks[0].status = 'failed'; tasks[0].error = 'Context budget exhausted';
    tasks[1].status = tasks[2].status = 'blocked';
    const gate = qualityGate(tasks, new Map());
    expect(gate.verdict).toBe('FAIL');
    expect(gate.reasons[0]).toBe('code: Context budget exhausted');
    expect(gate.reasons).toHaveLength(3);
    expect(gate.diagnosis.blocked).toEqual([
      { taskId: 'test', blockedBy: ['code'], dependencies: ['code'] },
      { taskId: 'review', blockedBy: ['code'], dependencies: ['test'] },
    ]);
    tasks.forEach(task => { task.status = 'completed'; });
    expect(qualityGate(tasks, new Map()).verdict).toBe('UNVERIFIED');
  });
  it('handles dependency cycles and cancellation when identifying blocked roots', () => {
    const tasks = parseTeamPlan(JSON.stringify({ tasks: [
      { id: 'code', role: 'coder', title: 'Code' },
      { id: 'test', role: 'tester', title: 'Test', dependencies: ['code'] },
    ] }));
    tasks[0].status = 'cancelled'; tasks[1].status = 'blocked';
    expect(executionDiagnosis(tasks).blocked[0].blockedBy).toEqual(['code']);
    tasks[0].status = 'blocked'; tasks[0].dependencies = ['test'];
    expect(executionDiagnosis(tasks).blocked[0].blockedBy).toEqual([]);
  });
  it('accepts Windows execution headers but never output-body exit claims or malformed payloads', () => {
    const proof: TaskEvidence = { inspected: false, successfulChecks: 0, failedChecks: 0, toolErrors: 0 };
    const calls = new Map([['check', 'run_tests']]);
    const tool = (content: string) => recordEvidence(proof, { role: 'tool', tool_call_id: 'check', content }, calls);
    tool(JSON.stringify({ ok: true, output: 'command=npm test\r\nexit=0\r\npassed' }));
    expect(proof.checks?.[0].command).toBe('npm test');
    tool(JSON.stringify({ ok: true, output: 'exit=undefined\nstdout:\nexit=0\n' }));
    tool(JSON.stringify({ ok: true, output: 42 }));
    tool('null');
    expect(proof.successfulChecks).toBe(1);
    expect(proof.toolErrors).toBe(1);
  });
});
