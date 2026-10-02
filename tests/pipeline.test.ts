import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Pipeline } from '../src/pipeline.js';
import { parseTeamPlan } from '../src/teamwork.js';

describe('Persisted pipeline failure diagnosis', () => {
  it('preserves root errors and blocked causes across checkpoints while redacting secrets', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-pipeline-'));
    try {
      const tasks = parseTeamPlan(JSON.stringify({ tasks: [
        { id: 'code', role: 'coder', title: 'Code' },
        { id: 'test', role: 'tester', title: 'Test', dependencies: ['code'] },
      ] }));
      const pipeline = new Pipeline(root, 'session-test', 2);
      tasks[0].status = 'running'; pipeline.dispatch(tasks);
      pipeline.snapshot(tasks, new Map());
      tasks[0].status = 'failed'; tasks[0].error = 'Context exhausted; api_key=private-value';
      tasks[1].status = 'blocked';
      const report = pipeline.snapshot(tasks, new Map(), 'failed');
      const saved = JSON.parse(fs.readFileSync(path.join(root, 'pipeline.json'), 'utf8'));
      expect(saved).toEqual(report);
      expect(saved.sequence).toBe(2);
      expect(saved.peakConcurrency).toBe(1);
      expect(saved.execution.blocked[0].blockedBy).toEqual(['code']);
      expect(saved.tasks[0].error).toBe('Context exhausted; api_key=[REDACTED]');
      expect(JSON.stringify(saved)).not.toContain('private-value');
      expect(fs.existsSync(path.join(root, 'pipeline.json.tmp'))).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
