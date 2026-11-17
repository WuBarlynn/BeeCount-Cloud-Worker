import { DurableObject } from 'cloudflare:workers';

/**
 * One SyncHub instance per user (id = `u:<userId>`). It only fans out small
 * JSON notifications to that user's open WebSocket connections; it is not a
 * source of truth. D1 remains authoritative, and clients catch up through
 * /sync/pull after a reconnect.
 */
export class SyncHub extends DurableObject {
  private sockets = new Set<WebSocket>();

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as any);
    // Hibernation-friendly: sockets are restored by the platform after eviction.
    for (const ws of ctx.getWebSockets()) this.track(ws);
  }

  private track(ws: WebSocket): void {
    this.sockets.add(ws);
    ws.addEventListener('close', () => this.sockets.delete(ws));
    ws.addEventListener('error', () => this.sockets.delete(ws));
    ws.addEventListener('message', (event) => {
      const text = typeof event.data === 'string' ? event.data : '';
      if (text.includes('"ping"') && ws.readyState === WebSocket.OPEN) ws.send('{"type":"pong"}');
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith('/broadcast')) {
      const payload = await request.text();
      let delivered = 0;
      for (const ws of [...this.sockets]) {
        if (ws.readyState !== WebSocket.OPEN) {
          this.sockets.delete(ws);
          continue;
        }
        try {
          ws.send(payload);
          delivered++;
        } catch {
          this.sockets.delete(ws);
        }
      }
      return Response.json({ delivered, online: this.sockets.size });
    }

    if (url.pathname.endsWith('/online')) {
      return Response.json({ online: this.sockets.size });
    }

    const upgrade = request.headers.get('Upgrade');
    if (upgrade !== 'websocket') return new Response('expected websocket', { status: 426 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.track(server);
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }
}
