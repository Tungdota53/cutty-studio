export const MOCK_SLASH_DATA = {
  models: {
    head: ['Model ID', 'Provider', 'Context', 'Quality'],
    rows: [
      ['gpt-4o', 'openai', 128000, 'max'],
      ['claude-3-5-sonnet', 'anthropic', 200000, 'high'],
      ['gemini-1.5-pro', 'google', 1000000, 'high'],
      ['deepseek-coder-v2', 'deepseek', 64000, 'fast']
    ]
  },

  routerStatus: {
    head: ['Model', 'Reqs', 'Errors', 'Avg Latency', 'Health'],
    rows: [
      ['gpt-4o', 120, 0, '450ms', 'healthy'],
      ['claude-3-5-sonnet', 85, 1, '620ms', 'healthy'],
      ['deepseek-coder-v2', 40, 5, '310ms', 'degraded']
    ]
  },

  agents: {
    head: ['Agent ID', 'Role', 'Status', 'Model'],
    rows: [
      ['agent-plan-01', 'planner', 'idle', 'gpt-4o'],
      ['agent-coder-01', 'coder', 'running', 'claude-3-5-sonnet'],
      ['agent-tester-01', 'tester', 'waiting', 'deepseek-coder-v2']
    ]
  },

  tasks: {
    head: ['Task ID', 'Role', 'Status', 'Dependencies', 'Title'],
    rows: [
      ['T1', 'planner', 'completed', '-', 'Analyze codebase'],
      ['T2', 'coder', 'running', 'T1', 'Implement UI theme'],
      ['T3', 'tester', 'pending', 'T2', 'Run test suite']
    ]
  },

  sessions: {
    head: ['Session ID', 'Created', 'Messages', 'Status'],
    rows: [
      ['sess_20261001_01', '2026-10-01 16:47:00', 14, 'closed'],
      ['sess_20261001_02', '2026-10-01 16:53:00', 4, 'active']
    ]
  },

  singleColumn: {
    head: ['Command'],
    rows: [
      ['/help'],
      ['/status'],
      ['/models'],
      ['/teamwork']
    ]
  },

  emptyTable: {
    head: ['Col1', 'Col2', 'Col3'],
    rows: [] as (string | number)[][]
  },

  completelyEmpty: {
    head: [] as string[],
    rows: [] as (string | number)[][]
  },

  longStrings: {
    head: ['ID', 'Path', 'Payload'],
    rows: [
      [
        'EXT-001',
        'd:/very/deeply/nested/directory/structure/that/exceeds/normal/terminal/lengths/by/a/lot/file.ts',
        'A'.repeat(400)
      ]
    ]
  }
};
