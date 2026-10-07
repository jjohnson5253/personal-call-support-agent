import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './config.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('PORT must be an integer from 1024 to 65535.');
const configStore = await new ConfigStore(
  fileURLToPath(new URL('../.data', import.meta.url)),
).load();
const { server, store, sockets } = createApp({ configStore, port });
server.listen(port, '127.0.0.1', () => {
  console.log(
    `\nPersonal Call Support Agent\nOpen http://localhost:${port}\nDemo works without API keys. Configure providers in Settings to make real calls.\n`,
  );
});
server.on('error', (error) => {
  console.error(
    error.code === 'EADDRINUSE'
      ? `Port ${port} is busy. Set PORT to another port.`
      : 'Could not start the local server.',
  );
  process.exit(1);
});
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Ending active calls and shutting down…');
  const timeout = setTimeout(() => process.exit(1), 18000);
  const results = await Promise.allSettled(
    [...store.sessions.values()]
      .filter((session) => !session.ended)
      .map((session) => session.stop()),
  );
  if (results.some((result) => result.status === 'rejected'))
    console.error('A hang-up could not be confirmed. Check the Twilio Console.');
  for (const socket of sockets.clients) socket.terminate();
  server.closeAllConnections();
  server.close(() => {
    clearTimeout(timeout);
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
