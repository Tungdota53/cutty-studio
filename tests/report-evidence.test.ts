import {afterEach,describe,expect,it} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Tools,toolDefinitions} from '../src/tools.js';
import {runCommand} from '../src/command-runner.js';
import {isEnvironmentProbe,isReportCommand,verificationEvidence,qualityGate,type TaskEvidence} from '../src/team-artifacts.js';
import {parseTeamPlan} from '../src/teamwork.js';
import {assignedAgent,defaultAgents} from '../src/roles.js';
const roots:string[]=[];function root(){const p=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-report-'));roots.push(p);return p;}
afterEach(()=>roots.splice(0).forEach(p=>fs.rmSync(p,{recursive:true,force:true})));
const report="@'\n{\"verdict\":\"PASS\",\"findings\":[]}\n'@ | Set-Content -Path 'test-results/final-verification.json' -Encoding utf8";
describe('Project runtime and report evidence',()=>{
 it('recognizes only optional import probes and bounded report writes, never actual tests or audits',()=>{
  expect(isEnvironmentProbe(`python -c "import playwright; print('python-playwright available')"`)).toBe(true);
  for(const command of [`python -c "import playwright; assert False"`,`python -c "import playwright; print('ok'); exit(1)"`,`python -c "import playwright; print('ok')" && npm test`,'npm audit --json'])expect(isEnvironmentProbe(command)).toBe(false);
  expect(isReportCommand(report)).toBe(true);expect(isReportCommand(report,[report])).toBe(false);
  expect(isReportCommand(report+'; npm test')).toBe(false);expect(isReportCommand(report.replace('test-results/final','test-results/../final'))).toBe(false);
 });
 it('accepts successful required suites despite historical optional probes/report writes but retains real audit failures',()=>{
  const [task]=parseTeamPlan(JSON.stringify({tasks:[{id:'T2',role:'tester',title:'Verify',verificationCommands:['npm test','npm run test:browser']}]}));task.status='completed';
  const proof:TaskEvidence={inspected:true,successfulChecks:2,failedChecks:2,toolErrors:2,checks:[{command:`python -c "import playwright; print('available')"`,exitCode:9009,excerpt:''},{command:report,exitCode:1,excerpt:''},{command:'npm test',exitCode:0,excerpt:'4 passed'},{command:'npm run test:browser',exitCode:0,excerpt:'11 passed'}]};
  expect(verificationEvidence(task,proof)).toMatchObject({successfulChecks:2,failedChecks:0,warnings:2});expect(qualityGate([task],new Map([[task.id,proof]])).verdict).toBe('PASS');
  proof.checks!.push({command:'npm audit --json',exitCode:1,excerpt:'high vulnerability'});expect(qualityGate([task],new Map([[task.id,proof]])).verdict).toBe('FAIL');
 });
 it('keeps PASS reports with unresolved findings blocked',()=>{
  const [task]=parseTeamPlan(JSON.stringify({tasks:[{id:'T3',role:'reviewer',title:'Audit'}]}));task.status='completed';task.resultSummary=JSON.stringify({verdict:'PASS',findings:[{severity:'high',scope:'dev/test only'}]});
  expect(qualityGate([task],new Map([[task.id,{inspected:true,successfulChecks:1,failedChecks:0,toolErrors:0}]] )).verdict).toBe('FAIL');
 });
 it('allows read-only reviewers to save artifacts without source write access and checkpoints the final JSON',async()=>{
  const dir=root(),tools=new Tools(dir,undefined,'reviewer',undefined,undefined,true).setCheckpointContext(dir,'session-report');
  expect(toolDefinitions.find(t=>t.function.name==='write_report')!.function.parameters.required).toEqual(['path','content']);
  expect((await tools.run('write_report',JSON.stringify({path:'test-results/security.json',content:'{"verdict":"FAIL","findings":["high"]}'}))).ok).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(dir,'test-results/security.json'),'utf8')).verdict).toBe('FAIL');
  expect((await tools.run('write_file',JSON.stringify({path:'index.html',content:'changed'}))).ok).toBe(false);
 });
 it('rejects source paths, traversal, symlinks and malformed or oversized reports before creating checkpoints',async()=>{
  const dir=root(),outside=root(),tools=new Tools(dir,undefined,'tester').setCheckpointContext(dir);
  for(const [p,content] of [['index.html','{}'],['reports/../package.json','{}'],['reports/bad.json','[]'],['reports/bad.json','{'],['reports/huge.json',JSON.stringify({text:'x'.repeat(512*1024)})]])expect((await tools.run('write_report',JSON.stringify({path:p,content}))).ok).toBe(false);
  fs.symlinkSync(outside,path.join(dir,'reports'),process.platform==='win32'?'junction':'dir');
  expect((await tools.run('write_report',JSON.stringify({path:'reports/escape.json',content:'{}'}))).ok).toBe(false);
  expect(fs.existsSync(path.join(outside,'escape.json'))).toBe(false);expect(fs.existsSync(path.join(dir,'.vibe/checkpoints'))).toBe(false);
 });
 it.runIf(process.platform==='win32')('executes legacy PowerShell here-strings in the correct shell',async()=>{
  const dir=root();fs.mkdirSync(path.join(dir,'test-results'));
  const result=await runCommand(report,dir,10000);expect(result.exitCode).toBe(0);
  expect(JSON.parse(fs.readFileSync(path.join(dir,'test-results/final-verification.json'),'utf8').replace(/^\uFEFF/,''))).toEqual({verdict:'PASS',findings:[]});
 },15000);
 it('migrates the old stock Python prerequisite but preserves custom agent instructions',()=>{
  const agent={...defaultAgents.find(a=>a.id==='web-tester')!,instructions:'Test web interfaces. Check Python and Playwright availability before browser tests.'};
  expect(assignedAgent({namedAgents:[agent]},agent.id,'tester')!.instructions).toContain('Node Playwright does not require Python');
  agent.instructions='Use Python tests for this Python project';expect(assignedAgent({namedAgents:[agent]},agent.id,'tester')!.instructions).toBe(agent.instructions);
 });
});
