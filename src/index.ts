// qtc-faucet/src/index.ts
// QTC Faucet — Cloudflare Worker
//
// POST /drip  { "address": "0x<64 hex chars>" }
//   -> 200    { "ok": true, "txHash": "0x..." }
//   -> 400    { "ok": false, "error": "..." }   (bad request / invalid address)
//   -> 429    { "ok": false, "error": "..." }   (rate limited)
//   -> 500    { "ok": false, "error": "..." }   (node/signing failure)
//
// GET /       -> simple status page (useful for uptime monitors)

import {
  QtcClient,
  computeTxHash,
  serializeTransaction,
  isAddress,
  fromHex,
  toHex,
  type Hex,
} from 'qtc-client';
import { buildSigner, type DilithiumSigner } from './signer';

// ---------------------------------------------------------------------------
// Cloudflare Worker env bindings (set in wrangler.toml + dashboard secrets)
// ---------------------------------------------------------------------------

export interface Env {
  // vars
  QTC_RPC_URL: string;
  DRIP_AMOUNT: string;       // nano-QTC as a decimal string
  RATE_LIMIT_SECS: string;   // seconds between drips per address

  // KV namespace (rate limiting)
  FAUCET_RATE_LIMIT: KVNamespace;

  // secrets (set via `wrangler secret put`)
  FAUCET_SK: string;         // hex, 2560 bytes
  FAUCET_PK: string;         // hex, 1312 bytes
  FAUCET_ADDR: string;       // "0x" + 64 hex chars
}

// ---------------------------------------------------------------------------
// Signer singleton — initialised once per Worker isolate lifetime
// ---------------------------------------------------------------------------

let _signer: DilithiumSigner | null = null;

async function getSigner(env: Env): Promise<DilithiumSigner> {
  if (!_signer) {
    _signer = await buildSigner(env.FAUCET_SK, env.FAUCET_PK);
  }
  return _signer;
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    },
  });
}

function err(message: string, status: number): Response {
  return json({ ok: false, error: message }, status);
}

// ---------------------------------------------------------------------------
// Core drip logic
// ---------------------------------------------------------------------------

async function drip(address: Hex, env: Env): Promise<Response> {
  // 1. Rate limit check
  const rateLimitKey = `drip:${address.toLowerCase()}`;
  const lastDrip = await env.FAUCET_RATE_LIMIT.get(rateLimitKey);
  if (lastDrip !== null) {
    const secsRemaining =
      Number(env.RATE_LIMIT_SECS) -
      Math.floor((Date.now() - Number(lastDrip)) / 1000);
    if (secsRemaining > 0) {
      const hours = Math.ceil(secsRemaining / 3600);
      return err(
        `Rate limited. Try again in ~${hours}h.`,
        429
      );
    }
  }

  const client = new QtcClient({ url: env.QTC_RPC_URL });
  const signer = await getSigner(env);

  // 2. Fetch faucet nonce
  const faucetAddr = env.FAUCET_ADDR as Hex;
  const account = await client.getAccount(faucetAddr);

  // 3. Build unsigned tx
  const dripAmount = BigInt(env.DRIP_AMOUNT);
  const baseFee = await client.blockNumber().then(() => 1000n);
  // NOTE: baseFee should ideally come from the latest block's baseFee field.
  // For the faucet, 1000n (the default) is safe since the faucet controls
  // its own priority and the mempool will reject if too low.

  const unsignedTx = {
    from: fromHex(faucetAddr),
    to: fromHex(address),
    value: dripAmount,
    nonce: account.nonce,
    baseFee,
    priorityFee: 100n,
    gasLimit: 21_000n,
  };

  const hash = computeTxHash(unsignedTx);

  // 4. Sign
  // What gets signed: the signable bytes of a BlockHeader in qc-node are
  // the header fields. For transactions, qc-node's mempool does NOT
  // currently verify the signature field on incoming txs — it stores
  // whatever is sent. The signature here is a placeholder for forward
  // compatibility once qc-node adds tx-sig verification (tracked in
  // qtc-client README "Open questions").
  const signable = serializeTransaction({
    ...unsignedTx,
    hash,
    signature: new Uint8Array(0), // excluded from signable
    receivedAt: 0n,
  });
  const signature = await signer.sign(signable);

  // 5. Submit
  const txHash = await client.sendRawTransaction({
    ...unsignedTx,
    hash,
    signature,
    receivedAt: BigInt(Math.floor(Date.now() / 1000)),
  });

  // 6. Record drip timestamp in KV with TTL
  await env.FAUCET_RATE_LIMIT.put(
    rateLimitKey,
    String(Date.now()),
    { expirationTtl: Number(env.RATE_LIMIT_SECS) }
  );

  return json({ ok: true, txHash });
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('QTC Faucet is running.', { status: 200 });
    }

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST, GET, OPTIONS',
          'access-control-allow-headers': 'content-type',
        },
      });
    }

    if (request.method === 'POST' && url.pathname === '/drip') {
      let body: { address?: string };
      try {
        body = await request.json();
      } catch {
        return err('invalid JSON body', 400);
      }

      const address = body.address?.trim();
      if (!address || !isAddress(address)) {
        return err(
          'missing or invalid address — must be "0x" + 64 hex chars (32 bytes)',
          400
        );
      }

      try {
        return await drip(address as Hex, env);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(`faucet error: ${msg}`, 500);
      }
    }

    return err('not found', 404);
  },
};
