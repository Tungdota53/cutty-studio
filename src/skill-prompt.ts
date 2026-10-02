import { estimateTokens } from './conversation.js';
import type { Skill } from './skills.js';

type LoadedSkill = Skill & { instructions: string };

/** Progressive disclosure: keep resource pointers when instructions cannot fit. */
export function skillPrompt(skills: LoadedSkill[], tokenBudget: number): string {
  const budget = Math.max(0, Math.floor(tokenBudget));
  const cards = skills.map(skill => `Skill ${skill.id}: read_skill_resource({"id":${JSON.stringify(skill.id)},"path":"SKILL.md","startLine":1,"endLine":120}) before applying omitted instructions. Required resources: ${(skill.requires || []).join(', ') || 'See skill'}.`);
  let result = cards.join('\n\n');
  if (estimateTokens(result) > budget) {
    result = 'Skills available through search_skills/read_skill_resource; discover and read relevant instructions before use.';
    return estimateTokens(result) <= budget ? result : '';
  }
  for (let index = 0; index < skills.length; index++) {
    const skill = skills[index];
    const full = `Skill ${skill.id}:\nSkill file: ${skill.file}\n${skill.instructions}`;
    const candidate = cards.map((card, i) => i === index ? full : card).join('\n\n');
    if (estimateTokens(candidate) <= budget) cards[index] = full;
  }
  return cards.join('\n\n');
}
