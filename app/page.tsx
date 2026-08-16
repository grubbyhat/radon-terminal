"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const MINT = "GnwoFdLNPZw9etvTAxPstSvQNHA5msqiQLNU9U78pump";
const MAX_TAPE = 140;

type ConnectionState = "CONNECTING" | "LIVE" | "RETRYING" | "OFFLINE";

type TapeTrade = {
  id: string;
  signature: string;
  slot: number;
  timestamp: number;
  side: "BUY" | "SELL";
  sol: number;
  tokens: number;
  priceSol: number;
  marketCapSol: number;
  wallet: string;
};

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

type JsonParsedTransaction = {
  slot?: number;
  blockTime?: number | null;
  transaction?: {
    signatures?: string[];
    message?: {
      accountKeys?: Array<string | { pubkey?: string; signer?: boolean }>;
    };
  };
  meta?: {
    err?: unknown;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  };
};

function compact(value: string, left = 4, right = 4) {
  if (value.length <= left + right + 1) return value;
  return `${value.slice(0, left)}…${value.slice(-right)}`;
}

function fixed(value: number, digits = 4) {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  if (Math.abs(value) < 0.0001) return value.toExponential(2);
  return value.toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: Math.min(2, digits),
  });
}

function abbreviated(value: number) {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1_000_000_000) return `${fixed(value / 1_000_000_000, 2)}B`;
  if (Math.abs(value) >= 1_000_000) return `${fixed(value / 1_000_000, 2)}M`;
  if (Math.abs(value) >= 1_000) return `${fixed(value / 1_000, 2)}K`;
  return fixed(value, 2);
}

function amountOf(balance?: TokenBalance) {
  const ui = balance?.uiTokenAmount;
  if (!ui) return 0;
  if (ui.uiAmountString != null) return Number(ui.uiAmountString) || 0;
  if (ui.uiAmount != null) return Number(ui.uiAmount) || 0;
  const raw = Number(ui.amount || 0);
  return raw / 10 ** Number(ui.decimals || 0);
}

function analyseTransaction(
  tx: JsonParsedTransaction,
  supply: number,
  signature: string,
): TapeTrade | null {
  const meta = tx?.meta;
  const message = tx?.transaction?.message;
  if (!meta || meta.err || !message) return null;

  const keys = (message.accountKeys || []).map((entry) =>
    typeof entry === "string" ? { pubkey: entry, signer: false } : {
      pubkey: entry.pubkey || "",
      signer: Boolean(entry.signer),
    },
  );
  const signerKeys = new Set(keys.filter((key) => key.signer).map((key) => key.pubkey));
  const tokenDeltas = new Map<string, number>();

  for (const balance of meta.preTokenBalances || []) {
    if (balance.mint !== MINT || !balance.owner) continue;
    tokenDeltas.set(balance.owner, (tokenDeltas.get(balance.owner) || 0) - amountOf(balance));
  }
  for (const balance of meta.postTokenBalances || []) {
    if (balance.mint !== MINT || !balance.owner) continue;
    tokenDeltas.set(balance.owner, (tokenDeltas.get(balance.owner) || 0) + amountOf(balance));
  }

  const candidates = [...tokenDeltas.entries()]
    .filter(([, delta]) => Math.abs(delta) > 0.000001)
    .map(([owner, tokenDelta]) => {
      const index = keys.findIndex((key) => key.pubkey === owner);
      const pre = index >= 0 ? Number(meta.preBalances?.[index] || 0) : 0;
      const post = index >= 0 ? Number(meta.postBalances?.[index] || 0) : 0;
      return {
        owner,
        tokenDelta,
        solDelta: (post - pre) / 1_000_000_000,
        signer: signerKeys.has(owner),
      };
    })
    .sort((a, b) => {
      if (a.signer !== b.signer) return a.signer ? -1 : 1;
      return Math.abs(b.solDelta) - Math.abs(a.solDelta);
    });

  const trade = candidates.find((candidate) => Math.abs(candidate.solDelta) > 0.000005);
  if (!trade) return null;

  const tokens = Math.abs(trade.tokenDelta);
  const sol = Math.abs(trade.solDelta);
  if (!tokens || !sol) return null;

  const priceSol = sol / tokens;
  const marketCapSol = supply > 0 ? priceSol * supply : 0;
  return {
    id: signature,
    signature,
    slot: Number(tx.slot || 0),
    timestamp: Number(tx.blockTime || Date.now() / 1000) * 1000,
    side: trade.tokenDelta > 0 ? "BUY" : "SELL",
    sol,
    tokens,
    priceSol,
    marketCapSol,
    wallet: trade.owner,
  };
}

async function rpc(method: string, params: unknown[]) {
  const response = await fetch("/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  if (!response.ok) throw new Error(`RPC ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || "RPC error");
  return payload.result;
}

function buildChart(trades: TapeTrade[]) {
  const points = trades.filter((trade) => trade.marketCapSol > 0).slice(-60);
  if (!points.length) return { path: "", area: "", min: 0, max: 0 };

  const values = points.map((trade) => trade.marketCapSol);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, max * 0.002, 1);
  const coords = points.map((trade, index) => {
    const x = points.length === 1 ? 50 : (index / (points.length - 1)) * 100;
    const y = 88 - ((trade.marketCapSol - min) / range) * 72;
    return [x, y] as const;
  });
  const path = coords.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const area = `${path} L100,100 L0,100 Z`;
  return { path, area, min, max };
}

function buildRadonProjection(trades: TapeTrade[]) {
  const recent = trades.slice(-72);
  const angles = [0, 25, 50, 75, 100, 125, 150];
  const binCount = 24;
  const rows = angles.map(() => Array.from({ length: binCount }, () => 0));
  if (!recent.length) return rows;

  const maxLog = Math.max(...recent.map((trade) => Math.log1p(trade.sol)), 0.001);
  recent.forEach((trade, index) => {
    const x = recent.length === 1 ? 0 : (index / (recent.length - 1)) * 2 - 1;
    const y = (Math.log1p(trade.sol) / maxLog) * 2 - 1;
    const weight = (trade.side === "BUY" ? 1 : -1) * (0.35 + Math.log1p(trade.sol) / maxLog);
    angles.forEach((angle, rowIndex) => {
      const theta = (angle * Math.PI) / 180;
      const rho = x * Math.cos(theta) + y * Math.sin(theta);
      const bin = Math.max(0, Math.min(binCount - 1, Math.round(((rho + Math.SQRT2) / (Math.SQRT2 * 2)) * (binCount - 1))));
      rows[rowIndex][bin] += weight;
    });
  });
  return rows;
}

function projectionGlyph(value: number, max: number) {
  const level = max ? Math.abs(value) / max : 0;
  if (level < 0.08) return "·";
  if (level < 0.22) return ":";
  if (level < 0.42) return "+";
  if (level < 0.66) return "#";
  return "█";
}

export default function Home() {
  const [connection, setConnection] = useState<ConnectionState>("CONNECTING");
  const [source, setSource] = useState("HELIUS TX SUBSCRIBE");
  const [trades, setTrades] = useState<TapeTrade[]>([]);
  const [supply, setSupply] = useState(0);
  const [lastSlot, setLastSlot] = useState(0);
  const [streamError, setStreamError] = useState("");
  const supplyRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    rpc("getTokenSupply", [MINT])
      .then((result) => {
        if (cancelled) return;
        const nextSupply = Number(result?.value?.uiAmountString || result?.value?.uiAmount || 0);
        supplyRef.current = nextSupply;
        setSupply(nextSupply);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let backoff = 600;
    const seen = new Set<string>();
    const queue: string[] = [];
    let active = 0;

    const fetchTransaction = async (signature: string) => {
      for (const delay of [0, 250, 700, 1400]) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        const tx = await rpc("getTransaction", [signature, {
          encoding: "jsonParsed",
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        }]);
        if (tx) return tx as JsonParsedTransaction;
      }
      return null;
    };

    const drain = () => {
      while (!stopped && active < 5 && queue.length) {
        const signature = queue.shift()!;
        active += 1;
        fetchTransaction(signature)
          .then((tx) => {
            if (!tx || stopped) return;
            const trade = analyseTransaction(tx, supplyRef.current, signature);
            if (!trade) return;
            setLastSlot(trade.slot);
            setTrades((current) => [...current, trade].slice(-MAX_TAPE));
          })
          .catch(() => undefined)
          .finally(() => {
            active -= 1;
            drain();
          });
      }
    };

    const enqueue = (signature?: string) => {
      if (!signature || seen.has(signature)) return;
      seen.add(signature);
      if (seen.size > 3000) {
        const oldest = seen.values().next().value;
        if (oldest) seen.delete(oldest);
      }
      queue.push(signature);
      drain();
    };

    const scheduleReconnect = () => {
      if (stopped) return;
      setConnection("RETRYING");
      retryTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 1.7, 8000);
    };

    const connect = () => {
      if (stopped) return;
      setConnection("CONNECTING");
      setStreamError("");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/api/stream`);

      socket.addEventListener("open", () => {
        backoff = 600;
        socket?.send(JSON.stringify({
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
      });

      socket.addEventListener("message", (event) => {
        let payload: any;
        try { payload = JSON.parse(String(event.data)); } catch { return; }

        if (payload.id === 1 && payload.error) {
          setSource("HELIUS LOG SUBSCRIBE");
          socket?.send(JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "logsSubscribe",
            params: [{ mentions: [MINT] }, { commitment: "confirmed" }],
          }));
          return;
        }
        if ((payload.id === 1 || payload.id === 2) && payload.result != null) {
          setConnection("LIVE");
          setStreamError("");
          return;
        }
        if (payload.id === 2 && payload.error) {
          setStreamError(payload.error.message || "Subscription rejected");
          setConnection("OFFLINE");
          return;
        }

        if (payload.method === "transactionNotification") {
          const result = payload.params?.result;
          enqueue(result?.signature || result?.transaction?.signature);
        }
        if (payload.method === "logsNotification") {
          enqueue(payload.params?.result?.value?.signature);
        }
      });

      socket.addEventListener("close", scheduleReconnect);
      socket.addEventListener("error", () => {
        setStreamError("Stream interrupted");
      });
    };

    connect();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
  }, []);

  const chronological = useMemo(() => [...trades].sort((a, b) => a.timestamp - b.timestamp), [trades]);
  const newestFirst = useMemo(() => [...chronological].reverse(), [chronological]);
  const chart = useMemo(() => buildChart(chronological), [chronological]);
  const projection = useMemo(() => buildRadonProjection(chronological), [chronological]);
  const projectionMax = useMemo(() => Math.max(0.001, ...projection.flat().map(Math.abs)), [projection]);
  const stats = useMemo(() => {
    const buySol = chronological.filter((trade) => trade.side === "BUY").reduce((sum, trade) => sum + trade.sol, 0);
    const sellSol = chronological.filter((trade) => trade.side === "SELL").reduce((sum, trade) => sum + trade.sol, 0);
    const total = buySol + sellSol;
    const cutoff = Date.now() - 30_000;
    const recent = chronological.filter((trade) => trade.timestamp >= cutoff);
    const latest = chronological.at(-1);
    return {
      buySol,
      sellSol,
      pressure: total ? (buySol / total) * 100 : 50,
      wallets: new Set(chronological.map((trade) => trade.wallet)).size,
      velocity: recent.length / 30,
      marketCap: latest?.marketCapSol || 0,
      price: latest?.priceSol || 0,
    };
  }, [chronological]);

  return (
    <main className="terminal-shell">
      <header className="topline">
        <div className="brand-block">
          <pre className="brand-mark" aria-label="RT logo">{`+----+
| RT |
+----+`}</pre>
          <div>
            <h1>RADON TERMINAL</h1>
            <p>MARKET-STRUCTURE RECONSTRUCTION</p>
          </div>
        </div>
        <div className="stream-meta">
          <span className={`status-dot status-${connection.toLowerCase()}`} aria-hidden="true" />
          <span>{connection}</span>
          <span className="meta-rule" />
          <span>{source}</span>
          <span className="meta-rule" />
          <span>SLOT {lastSlot || "—"}</span>
        </div>
      </header>

      <section className="instrument-bar" aria-label="Tracked token">
        <div className="instrument-id">
          <span className="eyebrow">LIVE MINT</span>
          <strong>{MINT}</strong>
        </div>
        <div className="instrument-stat">
          <span>SUPPLY</span>
          <strong>{supply ? abbreviated(supply) : "—"}</strong>
        </div>
        <div className="instrument-stat">
          <span>PRICE</span>
          <strong>{stats.price ? `${fixed(stats.price, 8)} SOL` : "—"}</strong>
        </div>
        <div className="instrument-stat major">
          <span>MARKET CAP</span>
          <strong>{stats.marketCap ? `${abbreviated(stats.marketCap)} SOL` : "—"}</strong>
        </div>
      </section>

      <section className="workspace">
        <div className="tape-panel">
          <div className="section-heading">
            <div>
              <span className="eyebrow">01 / TRANSACTION TAPE</span>
              <h2>BUY / SELL STREAM</h2>
            </div>
            <span className="row-count">{trades.length.toString().padStart(3, "0")} EVENTS</span>
          </div>

          <div className="tape-head tape-grid" aria-hidden="true">
            <span>TIME</span><span>SIDE</span><span>SOL</span><span>TOKENS</span><span>MCAP / SOL</span><span>WALLET</span><span>TX</span>
          </div>
          <div className="tape-body" aria-live="polite">
            {!newestFirst.length ? (
              <div className="empty-tape">
                <span className="empty-pulse" />
                <strong>{connection === "LIVE" ? "STREAM OPEN / WAITING FOR SWAP" : "OPENING LIVE STREAM"}</strong>
                <small>{streamError || "Transactions matching the mint will print here."}</small>
              </div>
            ) : newestFirst.map((trade) => (
              <div className="tape-row tape-grid" key={trade.id}>
                <time>{new Date(trade.timestamp).toLocaleTimeString("en-GB", { hour12: false, fractionalSecondDigits: 3 })}</time>
                <span><b className={`side side-${trade.side.toLowerCase()}`}>{trade.side}</b></span>
                <strong>{fixed(trade.sol, 4)}</strong>
                <span>{abbreviated(trade.tokens)}</span>
                <span>{abbreviated(trade.marketCapSol)}</span>
                <span title={trade.wallet}>{compact(trade.wallet, 4, 4)}</span>
                <a href={`https://solscan.io/tx/${trade.signature}`} target="_blank" rel="noreferrer" title={trade.signature}>{compact(trade.signature, 3, 3)}</a>
              </div>
            ))}
          </div>
        </div>

        <aside className="analysis-panel">
          <div className="section-heading compact-heading">
            <div>
              <span className="eyebrow">02 / STRUCTURE</span>
              <h2>FLOW RECONSTRUCTION</h2>
            </div>
          </div>

          <div className="metric-grid">
            <div><span>BUY PRESSURE</span><strong>{fixed(stats.pressure, 1)}%</strong></div>
            <div><span>VELOCITY</span><strong>{fixed(stats.velocity, 2)} TX/S</strong></div>
            <div><span>BUY VOLUME</span><strong>{fixed(stats.buySol, 2)} SOL</strong></div>
            <div><span>SELL VOLUME</span><strong>{fixed(stats.sellSol, 2)} SOL</strong></div>
            <div><span>WALLETS</span><strong>{stats.wallets}</strong></div>
            <div><span>IMBALANCE</span><strong>{stats.pressure >= 50 ? "+" : "−"}{fixed(Math.abs(stats.pressure - 50) * 2, 1)}</strong></div>
          </div>

          <div className="chart-card">
            <div className="chart-title"><span>IMPLIED MARKET CAP</span><span>LAST 60 SWAPS / SOL</span></div>
            <div className="chart-wrap">
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Implied market cap from recent swaps">
                <line x1="0" y1="25" x2="100" y2="25" className="chart-gridline" />
                <line x1="0" y1="50" x2="100" y2="50" className="chart-gridline" />
                <line x1="0" y1="75" x2="100" y2="75" className="chart-gridline" />
                {chart.area ? <path d={chart.area} className="chart-area" /> : null}
                {chart.path ? <path d={chart.path} className="chart-line" /> : null}
              </svg>
              {!chart.path ? <span className="chart-empty">AWAITING PRICE FORMATION</span> : null}
              <span className="chart-high">{chart.max ? abbreviated(chart.max) : "—"}</span>
              <span className="chart-low">{chart.min ? abbreviated(chart.min) : "—"}</span>
            </div>
          </div>

          <div className="projection-card">
            <div className="chart-title"><span>RADON PROJECTION</span><span>TIME × SIZE × DIRECTION</span></div>
            <div className="projection" aria-label="Discrete Radon projection of transaction flow">
              {projection.map((row, rowIndex) => (
                <div className="projection-row" key={rowIndex}>
                  <small>{(rowIndex * 25).toString().padStart(3, "0")}°</small>
                  <code>{row.map((value, index) => <span className={value >= 0 ? "projection-buy" : "projection-sell"} key={index}>{projectionGlyph(value, projectionMax)}</span>)}</code>
                </div>
              ))}
            </div>
          </div>

          <div className="method-note">
            <span className="eyebrow">METHOD</span>
            <p>RT resolves every matching Helius transaction into direction, SOL notional, token quantity, implied price, market value and wallet recurrence. A rolling discrete Radon projection compresses time, trade size and direction into the structure field above, exposing bursts and persistent flow that a conventional price chart hides.</p>
          </div>
        </aside>
      </section>

      <footer>
        <span>RT / 01</span>
        <span>CONFIRMED COMMITMENT</span>
        <span>TRANSFER EVENTS EXCLUDED</span>
        <span>UTC {new Date().toISOString().slice(0, 19).replace("T", " ")}</span>
      </footer>
    </main>
  );
}
