type WorkerResponse = Response & { webSocket?: WebSocket };
type WorkerSocket = WebSocket & { accept(options?: { allowHalfOpen?: boolean }): void };

const MINT = "GnwoFdLNPZw9etvTAxPstSvQNHA5msqiQLNU9U78pump";

type TokenBalance = {
  mint?: string;
  owner?: string;
  uiTokenAmount?: {
    amount?: string;
    decimals?: number;
    uiAmount?: number | null;
    uiAmountString?: string;
  };
};

function tokenAmount(balance?: TokenBalance) {
  const ui = balance?.uiTokenAmount;
  if (!ui) return 0;
  if (ui.uiAmountString != null) return Number(ui.uiAmountString) || 0;
  if (ui.uiAmount != null) return Number(ui.uiAmount) || 0;
  return Number(ui.amount || 0) / 10 ** Number(ui.decimals || 0);
}

function resolveTrade(result: any) {
  const tx = result?.transaction;
  const meta = tx?.meta;
  const message = tx?.transaction?.message;
  if (!meta || meta.err || !message) return null;

  const keys = (message.accountKeys || []).map((entry: any) =>
    typeof entry === "string"
      ? { pubkey: entry, signer: false }
      : { pubkey: entry?.pubkey || "", signer: Boolean(entry?.signer) },
  );
  const signerKeys = new Set<string>(
    keys.filter((key: { signer: boolean }) => key.signer).map((key: { pubkey: string }) => key.pubkey),
  );
  const tokenDeltas = new Map<string, number>();

  for (const balance of (meta.preTokenBalances || []) as TokenBalance[]) {
    if (balance.mint !== MINT || !balance.owner) continue;
    tokenDeltas.set(balance.owner, (tokenDeltas.get(balance.owner) || 0) - tokenAmount(balance));
  }
  for (const balance of (meta.postTokenBalances || []) as TokenBalance[]) {
    if (balance.mint !== MINT || !balance.owner) continue;
    tokenDeltas.set(balance.owner, (tokenDeltas.get(balance.owner) || 0) + tokenAmount(balance));
  }

  const candidates = [...tokenDeltas.entries()]
    .filter(([, delta]) => Math.abs(delta) > 0.000001)
    .map(([owner, delta]) => {
      const index = keys.findIndex((key: { pubkey: string }) => key.pubkey === owner);
      const pre = index >= 0 ? Number(meta.preBalances?.[index] || 0) : 0;
      const post = index >= 0 ? Number(meta.postBalances?.[index] || 0) : 0;
      return {
        owner,
        tokenDelta: delta,
        solDelta: (post - pre) / 1_000_000_000,
        signer: signerKeys.has(owner),
      };
    })
    .sort((a, b) => {
      if (a.signer !== b.signer) return a.signer ? -1 : 1;
      return Math.abs(b.solDelta) - Math.abs(a.solDelta);
    });

  const candidate = candidates.find((item) => Math.abs(item.solDelta) > 0.000005);
  if (!candidate) return null;
  const tokens = Math.abs(candidate.tokenDelta);
  const sol = Math.abs(candidate.solDelta);
  if (!tokens || !sol) return null;

  const signature = result?.signature || tx?.transaction?.signatures?.[0];
  if (!signature) return null;
  return {
    signature,
    slot: Number(result?.slot || 0),
    timestamp: Date.now(),
    side: candidate.tokenDelta > 0 ? "BUY" : "SELL",
    sol,
    tokens,
    wallet: candidate.owner,
  };
}

export async function GET() {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return new Response("Helius is not configured", { status: 503 });

  const encoder = new TextEncoder();
  let heliusSocket: WorkerSocket | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(line)); } catch { closed = true; }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      };

      send("retry: 1200\n\n");
      heartbeat = setInterval(() => send(": rt-heartbeat\n\n"), 20_000);

      try {
        const upstreamResponse = await fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`, {
          headers: { Upgrade: "websocket" },
        }) as WorkerResponse;
        heliusSocket = upstreamResponse.webSocket as WorkerSocket | undefined;
        if (!heliusSocket) throw new Error("Helius WebSocket upgrade failed");
        heliusSocket.accept({ allowHalfOpen: true });

        heliusSocket.addEventListener("message", (event) => {
          const text = typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(event.data as ArrayBuffer);
          let payload: any;
          try { payload = JSON.parse(text); } catch { payload = null; }

          if (payload?.id === 1 && payload?.error && heliusSocket?.readyState === WebSocket.OPEN) {
            heliusSocket.send(JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "logsSubscribe",
              params: [{ mentions: [MINT] }, { commitment: "confirmed" }],
            }));
          }

          // Resolve the full upstream transaction at the relay boundary and
          // send only the compact trade record the screen needs.
          if (payload?.method === "transactionNotification") {
            const result = payload.params?.result;
            const trade = resolveTrade(result);
            if (!trade) return;
            send(`data: ${JSON.stringify({
              jsonrpc: payload.jsonrpc || "2.0",
              method: "rtTrade",
              params: {
                subscription: payload.params?.subscription,
                result: trade,
              },
            })}\n\n`);
            return;
          }

          if (payload?.method === "logsNotification") {
            send(`data: ${JSON.stringify({
              jsonrpc: payload.jsonrpc || "2.0",
              method: payload.method,
              params: {
                subscription: payload.params?.subscription,
                result: {
                  context: payload.params?.result?.context,
                  value: { signature: payload.params?.result?.value?.signature },
                },
              },
            })}\n\n`);
            return;
          }

          send(`data: ${text}\n\n`);
        });
        heliusSocket.addEventListener("close", finish);
        heliusSocket.addEventListener("error", finish);

        heliusSocket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "transactionSubscribe",
          params: [
            { failed: false, accountInclude: [MINT] },
            {
              commitment: "confirmed",
              encoding: "jsonParsed",
              transactionDetails: "full",
              showRewards: false,
              maxSupportedTransactionVersion: 0,
            },
          ],
        }));
      } catch (error) {
        send(`event: stream-error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : "Stream failed" })}\n\n`);
        finish();
      }
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      try { heliusSocket?.close(1000, "Client disconnected"); } catch { /* already closed */ }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
