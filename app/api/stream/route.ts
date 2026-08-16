type WorkerResponse = Response & { webSocket?: WebSocket };
type WorkerResponseInit = ResponseInit & { webSocket?: WebSocket };
type WorkerSocket = WebSocket & { accept(options?: { allowHalfOpen?: boolean }): void };

export async function GET(request: Request) {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }

  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return new Response("Helius is not configured", { status: 503 });

  const pair = new WebSocketPair();
  const [client, browserSocket] = Object.values(pair) as [WebSocket, WorkerSocket];
  browserSocket.accept({ allowHalfOpen: true });

  const upstreamResponse = await fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`, {
    headers: { Upgrade: "websocket" },
  }) as WorkerResponse;
  const heliusSocket = upstreamResponse.webSocket as WorkerSocket | undefined;
  if (!heliusSocket) {
    browserSocket.close(1011, "Helius connection failed");
    return new Response("Helius connection failed", { status: 502 });
  }
  heliusSocket.accept({ allowHalfOpen: true });

  const closeBoth = (code = 1000, reason = "Stream closed") => {
    try { browserSocket.close(code, reason); } catch { /* already closed */ }
    try { heliusSocket.close(code, reason); } catch { /* already closed */ }
  };
  browserSocket.addEventListener("message", (event) => {
    if (heliusSocket.readyState === WebSocket.OPEN) heliusSocket.send(event.data);
  });
  heliusSocket.addEventListener("message", (event) => {
    if (browserSocket.readyState === WebSocket.OPEN) browserSocket.send(event.data);
  });
  browserSocket.addEventListener("close", (event) => closeBoth(event.code || 1000, event.reason || "Client closed"));
  heliusSocket.addEventListener("close", (event) => closeBoth(event.code || 1011, event.reason || "Upstream closed"));
  browserSocket.addEventListener("error", () => closeBoth(1011, "Client stream error"));
  heliusSocket.addEventListener("error", () => closeBoth(1011, "Helius stream error"));

  return new Response(null, { status: 101, webSocket: client } as WorkerResponseInit);
}
