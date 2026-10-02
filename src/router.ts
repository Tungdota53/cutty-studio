import type{Config,ModelCandidate}from'./config.js';import type{Quality,Role}from'./types.js';
export interface RouteRequest{role:Role;agentId?:string;taskType:string;complexity:number;contextTokens:number;requiresTools:boolean;requiresLongContext:boolean;preferSpeed?:boolean;preferQuality?:boolean}
export class ModelRouter {
  metrics = new Map<string, { ok: number; fail: number; latency: number }>();
  constructor(private c: Config) {}
  route(r: RouteRequest, config: Config = this.c) {
    const pinned = config.namedAgents?.find(a => a.id === r.agentId && a.enabled && a.role === r.role)?.model || config.agentProfiles?.[r.role]?.model || config.models[r.role];
    const ids = [...new Set((Array.isArray(pinned) ? pinned : pinned ? [pinned] : []).filter(Boolean))];
    // A provider/model must be attempted at most once per fallback chain.
    let pool = [...new Map(config.modelPool.map(model => [model.id, model])).values()];
    pool = [...ids.map(id => pool.find(model => model.id === id) || { id, tags: [], priority: 100 }), ...pool.filter(model => !ids.includes(model.id))];
    const score = (model: ModelCandidate) => model.priority + (model.tags.includes(r.role) ? 25 : 0) + (r.requiresTools && model.tags.includes('tools') ? 30 : 0) + (r.preferQuality && model.tags.includes('high-quality') ? 20 : 0) + (r.preferSpeed && model.tags.includes('fast') ? 20 : 0) - (this.metrics.get(model.id)?.fail || 0) * 10;
    pool.sort((a, b) => {
      const ai = ids.indexOf(a.id), bi = ids.indexOf(b.id);
      if (ai >= 0 || bi >= 0) return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
      return score(b) - score(a);
    });
    return { selectedModel: pool[0]?.id || config.model, fallbacks: pool.slice(1).map(model => model.id), reason: `weighted role=${r.role} quality=${config.quality}` };
  }
  record(id: string, ok: boolean, ms: number) { const x = this.metrics.get(id) || { ok: 0, fail: 0, latency: 0 }; ok ? x.ok++ : x.fail++; x.latency = (x.latency + ms) / 2; this.metrics.set(id, x); }
  status() { return [...this.metrics.entries()]; }
}
export const qualityPolicy=(q:Quality)=>({fast:{reviewRounds:0,candidates:1},balanced:{reviewRounds:1,candidates:1},high:{reviewRounds:2,candidates:2},max:{reviewRounds:2,candidates:3}}[q]);


