import { describe, expect, it } from 'vitest';
import { taskHandoff } from '../src/handoff.js';
import { estimateMessages } from '../src/conversation.js';
import { parseTeamPlan } from '../src/teamwork.js';
import type { Task } from '../src/types.js';

describe('bounded handoff and executable plans', () => {
  const task = (id: string): Task => ({id, title: id, description: id, role: 'coder', status: 'completed', dependencies: [], createdAt: new Date().toISOString(), retries: 0});
  it('bounds multilingual goal, summaries and file manifests together', () => {
    const dependencies = Array.from({length: 40}, (_, i) => ({...task(`T${i}`), resultSummary: 'Việt Nam 🌏 kết quả '.repeat(1000), expectedFiles: Array.from({length: 200}, (_, j) => `src/${'x'.repeat(100)}/${j}.ts`)}));
    const next = {...task('next'), dependencies: dependencies.map(item => item.id)};
    for (const budget of [512, 1200, 6000]) {
      const messages = taskHandoff('Mục tiêu 🌏 '.repeat(2000), next, dependencies, budget);
      expect(estimateMessages(messages)).toBeLessThanOrEqual(budget);
      expect(JSON.stringify(messages)).not.toContain('\uFFFD');
      expect(messages[1]?.content).toContain('omittedReports');
    }
  });
  it('keeps complete short reports and excludes pending dependencies', () => {
    const dependency = {...task('a'), resultSummary: 'Original complete result'};
    const next = {...task('next'), dependencies: ['a', 'b']};
    const messages = taskHandoff('User goal', next, [dependency, {...task('b'), status: 'pending', resultSummary: 'Unexecuted claim'}]);
    expect(JSON.stringify(messages)).toContain('Original complete result');
    expect(JSON.stringify(messages)).not.toContain('Unexecuted claim');
    expect(JSON.stringify(taskHandoff('User goal', next, [dependency], 6000, true))).not.toContain('Original complete result');
  });
  it.each(['planner', 'orchestrator', 'reviewer', 'judge', 'general'])('rejects required commands for read-only role %s before execution', role => {
    expect(() => parseTeamPlan(JSON.stringify({tasks:[{title:'Inspect', role, verificationCommands:['node -v']}]}))).toThrow('cannot execute verificationCommands');
  });
  it('preserves real checks on shell-capable tasks', () => {
    const tasks = parseTeamPlan(JSON.stringify({tasks:[{id:'s',title:'Survey',role:'planner',verificationCommands:[]},{id:'t',title:'Verify environment',role:'tester',dependencies:['s'],verificationCommands:['node -v']}]}));
    expect(tasks[1].verificationCommands).toEqual(['node -v']);
  });
});
