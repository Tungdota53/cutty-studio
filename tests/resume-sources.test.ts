import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { verifyCompletedSource } from '../src/resume-sources.js';
import type { Task } from '../src/types.js';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(root=>fs.rmSync(root,{recursive:true,force:true})));
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-repair-lineage-'));roots.push(root);const file=path.join(root,'style.css');fs.writeFileSync(file,'latest');const hash=(value:string)=>crypto.createHash('sha256').update(value).digest('hex');
  const task=(id:string,dependencies:string[],date:string)=>({id,dependencies,role:'coder',status:'completed',expectedFiles:['style.css'],completedAt:date} as Task);
  const tasks=[task('code',[],'2026-10-03T01:00:00Z'),task('repair-1',['code'],'2026-10-03T02:00:00Z'),task('repair-2',['code'],'2026-10-03T03:00:00Z')];
  return {root,file,tasks,fingerprints:{code:{[file]:hash('latest')},'repair-1':{[file]:hash('older')},'repair-2':{[file]:hash('latest')}}};}
describe('Repair snapshot lineage',()=>{
  it('accepts earlier repairs superseded by a later completed repair without rewriting history',()=>{const {root,tasks,fingerprints}=fixture();const before=JSON.stringify(fingerprints);for(const task of tasks)expect(()=>verifyCompletedSource(task,tasks,fingerprints,root)).not.toThrow();expect(JSON.stringify(fingerprints)).toBe(before);});
  it('rejects external edits even when a later repair exists',()=>{const {root,file,tasks,fingerprints}=fixture();fs.writeFileSync(file,'user edit');expect(()=>verifyCompletedSource(tasks[1],tasks,fingerprints,root)).toThrow('ngoài các vòng sửa');});
  it('rejects unfinished or unrelated repairs as supersession evidence',()=>{const {root,tasks,fingerprints}=fixture();tasks[2].status='failed';expect(()=>verifyCompletedSource(tasks[1],tasks,fingerprints,root)).toThrow();tasks[2].status='completed';tasks[2].dependencies=['other-worker'];expect(()=>verifyCompletedSource(tasks[1],tasks,fingerprints,root)).toThrow();});
  it('rejects missing fingerprints on the latest repair',()=>{const {root,tasks,fingerprints}=fixture();delete (fingerprints as any)['repair-2'];expect(()=>verifyCompletedSource(tasks[1],tasks,fingerprints,root)).toThrow('thiếu dấu vết');});
});
