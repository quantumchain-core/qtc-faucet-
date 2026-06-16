// qtc-faucet/src/signer.ts
// Dilithium2 signing inside a Cloudflare Worker.
//
// THE PROBLEM:
// Cloudflare Workers can't run native Rust binaries. The qc-node signer
// uses pqcrypto-dilithium (a C/Rust hybrid compiled to native code).
// Workers only support JavaScript and WebAssembly.
//
// THE SOLUTION (chosen approach):
// Use the `pqclean-dilithium2` WASM build from the `pqc` npm package
// (https://www.npmjs.com/package/pqc). This is a WASM port of the same
// reference C implementation that pqcrypto-dilithium wraps — same
// algorithm, same key/signature sizes, fully compatible with qc-node.
//
// ALTERNATIVE (if WASM bundle size is too large for Workers free tier):
// Move signing to a small Rust microservice deployed on Cloudflare Workers
// with Workers for Platforms (Rust WASM target), or a VPS sidecar. The
// faucet Worker would call it via a private fetch, keeping the secret key
// server-side. That approach is documented in docs/FAUCET_SIGNER.md.
//
// WASM SIZE NOTE:
// The pqc WASM bundle is ~80KB gzipped. Cloudflare free tier allows 1MB
// compressed. This fits comfortably. Paid tier (10MB) is not needed.

// @ts-ignore — WASM package, types may be minimal
import { dilithium2 } from 'pqc';
import { fromHex } from 'qtc-client';

export interface DilithiumSigner {
  sign(message: Uint8Array): Promise<Uint8Array>;
  publicKey: Uint8Array;
}

/**
 * Build a signer from the FAUCET_SK and FAUCET_PK secrets set via
 * `wrangler secret put`. Both are expected as hex strings (no "0x" prefix).
 *
 * Called once at Worker startup — the WASM module is initialised lazily by
 * the `pqc` package on first use.
 */
export async function buildSigner(
  skHex: string,
  pkHex: string
): Promise<DilithiumSigner> {
  const sk = fromHex(skHex);
  const pk = fromHex(pkHex);

  if (sk.length !== 2560) {
    throw new Error(`FAUCET_SK must be 2560 bytes, got ${sk.length}`);
  }
  if (pk.length !== 1312) {
    throw new Error(`FAUCET_PK must be 1312 bytes, got ${pk.length}`);
  }

  return {
    publicKey: pk,

    async sign(message: Uint8Array): Promise<Uint8Array> {
      // pqc.dilithium2.sign returns a detached signature (2420 bytes)
      const sig: Uint8Array = await dilithium2.sign(message, sk);
      if (sig.length !== 2420) {
        throw new Error(`unexpected signature length: ${sig.length}, expected 2420`);
      }
      return sig;
    },
  };
}
