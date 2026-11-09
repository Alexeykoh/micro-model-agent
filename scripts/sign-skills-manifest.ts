/**
 * Sign a skills manifest (P1 supply-chain): Ed25519 signature over the
 * manifest bytes. Usage:
 *   bun scripts/sign-skills-manifest.ts <dir> <privateKeyPemPath>
 * Writes `<dir>/skills-manifest.sig.json` and `<dir>/skills-manifest.pubkey`.
 */
import { createPrivateKey, createPublicKey, sign as cryptoSign } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const [dir, privPath] = process.argv.slice(2);
if (!dir || !privPath) {
  process.stderr.write("usage: bun scripts/sign-skills-manifest.ts <dir> <privateKeyPemPath>\n");
  process.exit(2);
}
const manifestPath = join(dir, "skills-manifest.json");
if (!existsSync(manifestPath)) {
  process.stderr.write(`no manifest at ${manifestPath}\n`);
  process.exit(1);
}
const privPem = readFileSync(privPath, "utf-8");
const raw = readFileSync(manifestPath);
const manifestSha256 = createHash("sha256").update(raw).digest("hex");
const sig = cryptoSign(null, raw, privPem).toString("base64");
writeFileSync(join(dir, "skills-manifest.sig.json"), JSON.stringify({ manifestSha256, sig }, null, 2), "utf-8");
// Export the matching public key for the loader's verifier.
const pubPem = createPublicKey(createPrivateKey(privPem)).export({ type: "spki", format: "pem" }) as string;
writeFileSync(join(dir, "skills-manifest.pubkey"), pubPem, "utf-8");
process.stdout.write(`[sign] ${manifestPath} -> skills-manifest.sig.json\n`);
