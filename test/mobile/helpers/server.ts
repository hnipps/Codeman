import { WebServer } from '../../../src/web/server.js';
import { openOnClassicDashboard } from '../../classic-dashboard.js';

const servers = new Set<WebServer>();

/**
 * A test server on an ephemeral port; read the port from `server.boundPort` once this resolves.
 * Its `/` is the tab dashboard, which is what these suites test.
 */
export async function createTestServer(): Promise<WebServer> {
  openOnClassicDashboard();
  const server = new WebServer(0, false, true); // testMode = true
  await server.start();
  servers.add(server);
  return server;
}

export async function stopTestServer(server: WebServer): Promise<void> {
  await server.stop();
  servers.delete(server);
}

export async function stopAllTestServers(): Promise<void> {
  for (const server of servers) {
    await server.stop();
  }
  servers.clear();
}
