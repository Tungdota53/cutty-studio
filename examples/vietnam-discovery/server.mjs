import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)), port=Number(process.env.PORT||5177);
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
http.createServer((req,res)=>{try{const url=new URL(req.url,'http://localhost'),target=path.resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));if(!target.startsWith(root+path.sep)||!mime[path.extname(target)]){res.writeHead(404);return res.end('Not found');}const content=fs.readFileSync(target);res.writeHead(200,{'Content-Type':mime[path.extname(target)],'X-Content-Type-Options':'nosniff'});res.end(content);}catch{res.writeHead(404);res.end('Not found');}}).listen(port,'127.0.0.1',()=>console.log(`Vietnam Discovery: http://127.0.0.1:${port}`));
