import { describe, expect, it, vi } from 'vitest';
import { parseTeamPlan } from '../src/teamwork.js';
import { validatedPlan } from '../src/plan-recovery.js';
import { updateReady } from '../src/dag.js';
import { executionBatch } from '../src/team-protocol.js';

const valid = JSON.stringify({ tasks: [{ id: 'a', title: 'Answer', role: 'general' }] });
describe('Planner recovery and scheduling', () => {
  it('extracts a fenced plan with quoted braces and unrelated metadata', () => {
    const raw = JSON.stringify({ tasks: [{ title: 'Show { "example": true }', role: 'general' }] });
    expect(parseTeamPlan('metadata {"summary":"ready"}\n```json\n' + raw + '\n```')[0].title).toContain('{ "example"');
  });
  it('rejects ambiguous, truncated and oversized output', () => {
    expect(() => parseTeamPlan(valid + valid)).toThrow('nhiều kế hoạch');
    expect(() => parseTeamPlan(valid.slice(0, -3))).toThrow('cắt ngắn');
    expect(() => parseTeamPlan('x'.repeat(1_000_001))).toThrow('1 MB');
  });
  it('repairs invalid structure with field feedback before returning tasks', async () => {
    const generate = vi.fn().mockResolvedValueOnce('{"tasks":[{"title":"A","acceptanceCriteria":23}]}').mockResolvedValue(valid);
    const retry = vi.fn();
    const result = await validatedPlan(generate, parseTeamPlan, undefined, retry);
    expect(result.value[0].id).toBe('a');
    expect(generate.mock.calls[1][1]).toContain('tasks.0.acceptanceCriteria');
    expect(retry).toHaveBeenCalledTimes(1);
  });
  it('caps validation repairs at two and retains the final cause', async () => {
    const generate = vi.fn().mockResolvedValue('{"tasks":[]}');
    await expect(validatedPlan(generate, parseTeamPlan)).rejects.toThrow('sau 3 lần');
    expect(generate).toHaveBeenCalledTimes(3);
  });
  it('does not replay transport failures as plan repairs', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('API 401'));
    await expect(validatedPlan(generate, parseTeamPlan)).rejects.toThrow('API 401');
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('honors cancellation before a repair call', async () => {
    const abort = new AbortController();
    const generate = vi.fn().mockResolvedValue('bad');
    await expect(validatedPlan(generate, parseTeamPlan, abort.signal, () => abort.abort(new Error('Stopped')))).rejects.toThrow('Stopped');
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('propagates blocked status regardless of plan ordering', () => {
    const tasks = parseTeamPlan(JSON.stringify({tasks:[{id:'c',title:'C',dependencies:['b']},{id:'b',title:'B',dependencies:['a']},{id:'a',title:'A'}]}));
    tasks[2].status='failed'; updateReady(tasks);
    expect(tasks.map(task=>task.status)).toEqual(['blocked','blocked','failed']);
  });
  it('prioritizes the longer dependency chain without ignoring file locks', () => {
    const tasks = parseTeamPlan(JSON.stringify({tasks:[{id:'short',title:'Short',expectedFiles:['short.txt']},{id:'long',title:'Long',expectedFiles:['long.txt']},{id:'next',title:'Next',dependencies:['long'],expectedFiles:['next.txt']}]}));
    expect(executionBatch(tasks,1).map(task=>task.id)).toEqual(['long']);
    tasks[0].status='running'; tasks[1].expectedFiles=['SHORT.txt'];
    expect(executionBatch(tasks,2)).toEqual([]);
  });
});
