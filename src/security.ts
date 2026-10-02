import fs from 'node:fs';import path from 'node:path';
const SECRET=/(authorization\s*[:=]\s*bearer\s+)[^\s"']+|((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,"']+/gi;
export const redact=(v:string)=>v.replace(SECRET,(_m,a,b)=>(a||b)+'[REDACTED]').replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[REDACTED PRIVATE KEY]');
export function safePath(root:string,input:string,write=false){
  const base=fs.realpathSync(root),target=path.resolve(base,input);
  const outside=(value:string)=>{const relative=path.relative(base,value);return relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)};
  if(outside(target))throw new Error('Path ngoài workspace bị chặn');
  let existing=target;
  if(write)while(!fs.existsSync(existing)){const parent=path.dirname(existing);if(parent===existing)throw new Error('Không có thư mục cha hợp lệ');existing=parent}
  if(outside(fs.realpathSync(existing)))throw new Error('Symlink ngoài workspace bị chặn');
  return target;
}
export const isSensitivePath=(p:string)=>/(^|[\\/])(\.env(?:\.|$)|\.npmrc$|id_(rsa|ed25519)$|credentials|private[_-]?key|token)([\\/]|$)/i.test(p);
export const isDestructive=(c:string)=>/(\brm\s+-rf\b|\bdel\s+\/|git\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+.*--force)|\b(drop\s+(database|table)|docker\s+(system\s+)?prune|shutdown|reboot)\b)/i.test(c);
