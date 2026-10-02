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
export const teamSchema = z.object({ profiles: z.partialRecord(roleSchema, profileSchema.partial()).optional(), maxAgents: z.number().int().min(1).max(16).optional() });
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
