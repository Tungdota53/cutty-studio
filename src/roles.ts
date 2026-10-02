import { z } from 'zod';
import type { Role } from './types.js';
import type { Config } from './config.js';

export const roles = ['orchestrator', 'planner', 'coder', 'tester', 'reviewer', 'judge', 'general'] as const;
export const roleSchema = z.enum(roles);
export const profileSchema = z.object({
  instructions: z.string().max(6000),
  skills: z.array(z.string().min(1).max(120)).max(8),
  autoSkills: z.boolean(),
  model: z.string().max(200)
});
export type RoleProfile = z.infer<typeof profileSchema>;
export const namedAgentSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), name: z.string().min(1).max(100), role: roleSchema, model: z.string().max(200).default(''), instructions: z.string().max(6000).default(''), skills: z.array(z.string().min(1).max(120)).max(8).default([]), enabled: z.boolean().default(true) });
export type NamedAgent = z.infer<typeof namedAgentSchema>;
export const teamSchema = z.object({ profiles: z.partialRecord(roleSchema, profileSchema.partial()).optional(), namedAgents: z.array(namedAgentSchema).max(32).refine(items => new Set(items.map(item => item.id)).size === items.length, 'Agent ID bị trùng').optional(), maxAgents: z.number().int().min(1).max(16).optional() });
export const roleCatalog: Record<Role, { label: string; responsibility: string; skill: string; readOnly: boolean }> = {
  orchestrator: { label: 'Điều phối', responsibility: 'Phân việc, theo dõi phụ thuộc và tổng hợp bằng chứng.', skill: 'team-orchestration', readOnly: true },
  planner: { label: 'Lập kế hoạch', responsibility: 'Khảo sát dự án, chia nhiệm vụ và xác định tiêu chí nghiệm thu.', skill: 'repository-planning', readOnly: true },
  coder: { label: 'Lập trình', responsibility: 'Thực hiện thay đổi trong phạm vi tệp được giao và kiểm tra kết quả.', skill: 'scoped-implementation', readOnly: false },
  tester: { label: 'Kiểm thử', responsibility: 'Chạy kiểm tra và báo cáo bằng chứng; không tự sửa mã nguồn.', skill: 'evidence-testing', readOnly: false },
  reviewer: { label: 'Rà soát', responsibility: 'Đọc diff, phát hiện lỗi và báo cáo mức độ ảnh hưởng.', skill: 'code-review', readOnly: true },
  judge: { label: 'Đánh giá', responsibility: 'Đối chiếu yêu cầu, bằng chứng kiểm thử và kết luận nghiệm thu.', skill: 'acceptance-check', readOnly: true },
  general: { label: 'Trợ lý', responsibility: 'Giải quyết yêu cầu và xác minh kết quả bằng công cụ.', skill: 'workspace-assistant', readOnly: false }
};
export function roleProfile(role: Role, config?: Partial<Config>): RoleProfile {
  return profileSchema.parse({ instructions: '', autoSkills: true, model: '', skills: [`builtin:${roleCatalog[role].skill}`], ...config?.agentProfiles?.[role] });
}
export function canUseTool(role: Role, name: string) {
  if (['write_file', 'edit_file'].includes(name)) return role === 'coder' || role === 'general';
  if (['run_command', 'run_tests'].includes(name)) return !roleCatalog[role].readOnly;
  return true;
}
export function assignedAgent(config: Partial<Config>, id: string | undefined, role: Role) {
  if (!id) return undefined;
  const agent = config.namedAgents?.find(item => item.id === id);
  if (!agent || !agent.enabled) throw new Error(`Agent không khả dụng: ${id}`);
  if (agent.role !== role) throw new Error(`Agent ${id} có vai ${agent.role}, không phù hợp vai ${role}`);
  return agent;
}
export const defaultAgents: NamedAgent[] = [
  { id: 'frontend', name: 'Frontend', role: 'coder', skills: ['github:anthropic/frontend-design'], instructions: 'Build and refine user interfaces.', model: '', enabled: true },
  { id: 'backend', name: 'Backend', role: 'coder', skills: [], instructions: 'Implement backend and data logic.', model: '', enabled: true },
  { id: 'web-tester', name: 'Web Tester', role: 'tester', skills: ['github:anthropic/webapp-testing'], instructions: 'Test web interfaces. Check Python and Playwright availability before browser tests.', model: '', enabled: true },
  { id: 'security-review', name: 'Security Reviewer', role: 'reviewer', skills: ['github:openai/security-best-practices'], instructions: 'Review security when assigned a security task. Report findings without changing code.', model: '', enabled: true },
  { id: 'planner', name: 'Planner', role: 'planner', skills: [], instructions: '', model: '', enabled: true },
  { id: 'assistant', name: 'Assistant', role: 'general', skills: [], instructions: '', model: '', enabled: true }
];
