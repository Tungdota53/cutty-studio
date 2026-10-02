import { startStudio } from './server.js';
const studio = await startStudio({ port: 0, host: '127.0.0.1', openBrowser: false, token: process.env.VIBE_DESKTOP_TOKEN });
process.send?.({ type: 'ready', url: studio.url });
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await studio.close();
  process.exit(0);
}
process.on('message', (msg: any) => { if (msg?.type === 'shutdown') void shutdown(); });
process.on('disconnect', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
