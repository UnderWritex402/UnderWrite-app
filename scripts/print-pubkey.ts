/**
 * Prints the agent's raw uncompressed secp256k1 public key.
 *
 * `agent-registry` on Soroban stores a `BytesN<65>`: the 0x04 prefix followed
 * by the 64-byte X/Y coordinates. That is NOT an Ethereum address — an
 * address is `keccak256(pubkey[1:])[12:]`, a lossy 20-byte digest that the
 * contract cannot recover a signer into. EVM tooling almost never surfaces the
 * raw key because it almost never needs it, which is why this script exists.
 *
 * Usage:
 *
 *   node --env-file=.env scripts/print-pubkey.ts
 *   AGENT_EVM_PRIVATE_KEY=0x... node scripts/print-pubkey.ts
 *
 * Output is the 65-byte key and nothing else, so it can be piped straight
 * into the `register_agent` call. Anything else goes to stderr.
 *
 * The output is a *public* key and safe to share. It is an input to the
 * contract call, not app configuration — do not add it to .env or commit it.
 */

import { privateKeyToAccount } from "viem/accounts";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const privateKey = process.env["AGENT_EVM_PRIVATE_KEY"];

if (privateKey === undefined || privateKey.trim() === "") {
  fail(
    "AGENT_EVM_PRIVATE_KEY is not set.\n" +
      "Pass it via the environment, e.g. `node --env-file=.env scripts/print-pubkey.ts`.",
  );
}

if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey.trim())) {
  fail(
    "AGENT_EVM_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string (66 characters).",
  );
}

const account = privateKeyToAccount(privateKey.trim() as `0x${string}`);
const publicKey = account.publicKey;

// agent-registry's parameter is BytesN<65>; a key of any other length or
// prefix would be rejected on-chain, so it is checked here rather than after
// a failed transaction.
if (!/^0x04[0-9a-fA-F]{128}$/.test(publicKey)) {
  fail(
    `Derived key is not a 65-byte uncompressed secp256k1 public key: ${publicKey}`,
  );
}

process.stderr.write(
  `address (for reference, NOT what agent-registry wants): ${account.address}\n`,
);
process.stdout.write(`${publicKey}\n`);
