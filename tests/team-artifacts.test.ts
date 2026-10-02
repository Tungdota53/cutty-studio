import { describe, expect, it } from 'vitest';
import { qualityGate, recordEvidence, type TaskEvidence } from '../src/team-artifacts.js';
import { parseTeamPlan } from '../src/teamwork.js';

describe('Independent teamwork evidence', () => {
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
});
