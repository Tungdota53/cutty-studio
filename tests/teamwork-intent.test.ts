import { describe, expect, it } from 'vitest';
import { resolveTeamworkIntent } from '../src/studio/teamwork-intent.js';
describe('Teamwork continuation intent', () => {
  it.each(['tiếp tục','Tiếp tục đi!','tiếp tục tiến độ cũ','tiếp tục công việc đang dở nhé','continue','resume'])('resumes the selected session for %s', text => {
    expect(resolveTeamworkIntent(`/teamwork ${text}`, 'session-bf5ef563')).toBe('/teamwork-resume session-bf5ef563');
    expect(resolveTeamworkIntent(text, 'session-bf5ef563')).toBe('/teamwork-resume session-bf5ef563');
  });
  it('requires a selected Teamwork session instead of silently replanning', () => {
    expect(() => resolveTeamworkIntent('/teamwork tiếp tục', 'chat-one')).toThrow('không lập kế hoạch mới');
    expect(() => resolveTeamworkIntent('/teamwork tiếp tục', 'session-../../bad')).toThrow();
    expect(resolveTeamworkIntent('tiếp tục', 'chat-one')).toBe('tiếp tục');
  });
  it('keeps new goals and explicit commands intact', () => {
    for (const text of ['/teamwork xây dựng website mới','/teamwork tiếp tục nâng cấp giao diện mới','/teamwork-resume session-aabbccdd']) expect(resolveTeamworkIntent(text,'session-bf5ef563')).toBe(text);
  });
});
