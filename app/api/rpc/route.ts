const ALLOWED_METHODS = new Set(["getTransaction", "getTokenSupply"]);

export async function POST(request: Request) {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return Response.json({ error: { message: "Helius is not configured" } }, { status: 503 });

  let body: { method?: string; params?: unknown[] };
  try { body = await request.json(); } catch {
    return Response.json({ error: { message: "Invalid request" } }, { status: 400 });
  }
  if (!body.method || !ALLOWED_METHODS.has(body.method) || !Array.isArray(body.params)) {
    return Response.json({ error: { message: "RPC method not allowed" } }, { status: 400 });
  }

  const upstream = await fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: body.method, params: body.params }),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
