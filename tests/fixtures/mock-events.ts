export interface TeamworkEvent {
  type: 'session_start' | 'planner_start' | 'planner_done' | 'task_start' | 'task_complete' | 'task_failed' | 'agent_status';
  agentId?: string;
  role?: string;
  status?: string;
  message?: string;
}

export const MOCK_EVENT_SEQUENCES = {
  happyPath: [
    { type: 'session_start', message: 'Session session-42 started' },
    { type: 'planner_start', agentId: 'planner-01', role: 'planner', message: 'Analyzing requirements' },
    { type: 'planner_done', agentId: 'planner-01', role: 'planner', message: 'Plan created with 3 tasks' },
    { type: 'task_start', agentId: 'coder-01', role: 'coder', message: 'Task T1: Implement UI theme' },
    { type: 'agent_status', agentId: 'coder-01', role: 'coder', status: 'running', message: 'Editing theme.ts' },
    { type: 'task_complete', agentId: 'coder-01', role: 'coder', message: 'Task T1 completed' },
    { type: 'task_start', agentId: 'tester-01', role: 'tester', message: 'Task T2: Verify UI theme' },
    { type: 'task_complete', agentId: 'tester-01', role: 'tester', message: 'Task T2 completed' },
    { type: 'task_start', agentId: 'reviewer-01', role: 'reviewer', message: 'Task T3: Code review' },
    { type: 'task_complete', agentId: 'reviewer-01', role: 'reviewer', message: 'Task T3 approved' }
  ] as TeamworkEvent[],

  failurePath: [
    { type: 'session_start', message: 'Session session-err started' },
    { type: 'planner_start', agentId: 'planner-01', role: 'planner', message: 'Planning' },
    { type: 'planner_done', agentId: 'planner-01', role: 'planner', message: 'Plan generated' },
    { type: 'task_start', agentId: 'coder-01', role: 'coder', message: 'Task T1: Build component' },
    { type: 'task_failed', agentId: 'coder-01', role: 'coder', status: 'failed', message: 'Syntax error in file' }
  ] as TeamworkEvent[],

  cancellationPath: [
    { type: 'session_start', message: 'Session session-cancel started' },
    { type: 'task_start', agentId: 'coder-02', role: 'coder', message: 'Task T2: Running long build' },
    { type: 'task_failed', agentId: 'coder-02', role: 'coder', status: 'cancelled', message: 'Operation cancelled by SIGINT' }
  ] as TeamworkEvent[],

  missingFields: [
    { type: 'session_start' },
    { type: 'planner_start' },
    { type: 'task_start', agentId: 'coder-01' },
    { type: 'agent_status', status: 'idle' },
    { type: 'task_complete' }
  ] as TeamworkEvent[],

  rapidBurst: Array.from({ length: 40 }, (_, i) => ({
    type: 'agent_status' as const,
    agentId: `agent-${i % 4}`,
    role: ['planner', 'coder', 'tester', 'reviewer'][i % 4],
    status: 'running',
    message: `Executing subtask step ${i}`
  }))
};
