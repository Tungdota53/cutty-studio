/** Resolve explicit continuation against the selected session, never a global
 * "most recent" session that may belong to another conversation. */
export function resolveTeamworkIntent(line: string, sessionId: unknown): string {
  const teamwork = /^\/teamwork\s+/i.test(line);
  const text = line.replace(/^\/teamwork\s+/i, '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/đ/g, 'd').replace(/[.!?…]+$/u, '').trim().replace(/\s+/g, ' ');
  const continuation = /^(?:tiep tuc(?: (?:tien do|cong viec|nhiem vu|phien)(?: cu| truoc| dang do| bi gian doan)?)?(?: (?:di|nhe))?|continue(?: (?:previous|last) (?:task|session))?|resume)$/.test(text);
  if (!continuation) return line;
  if (/^session-[a-f0-9]{8}$/.test(String(sessionId))) return `/teamwork-resume ${sessionId}`;
  if (teamwork) throw new Error('Hãy mở phiên Teamwork cũ trong lịch sử rồi gửi “tiếp tục”. Chưa chọn phiên để khôi phục; app không lập kế hoạch mới.');
  return line;
}
