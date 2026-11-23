import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { Signature } from "ox";

const digest = value => createHash("sha256").update(value).digest();

// Optional Chromium fixture for the local contract lifecycle tests.
export async function createVirtualPasskey() {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  const source = await readFile(new URL("../../src/lib/passkey-webauthn.ts", import.meta.url), "utf8");
  const js = stripTypeScriptTypes(source);
  const server = createServer((req, res) => {
    if (req.url === "/passkey.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(js);
    } else res.end("<!doctype html><title>Kettigo local passkey test</title>");
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const origin = `http://localhost:${server.address().port}`;
  let browser;
  async function close() {
    try { await browser?.close(); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    } });
    await page.goto(origin);
    const registration = await page.evaluate(async () => {
      const { createKettigoCredential } = await import("/passkey.js");
      const cred = await createKettigoCredential({ rpId: location.hostname, rpName: "Kettigo" });
      return { id: Array.from(new Uint8Array(cred.rawId)), key: Array.from(new Uint8Array(cred.response.getPublicKey())) };
    });
    const id = Buffer.from(registration.id).toString("hex");
    const key = createPublicKey({ key: Buffer.from(registration.key), format: "der", type: "spki" });
    async function sign(challenge) {
      const assertion = await page.evaluate(async ({ id, bytes }) => {
        const { getKettigoCredential } = await import("/passkey.js");
        const cred = await getKettigoCredential(id, { rpId: location.hostname }, { publicKey: { challenge: Uint8Array.from(bytes) } });
        const array = value => Array.from(new Uint8Array(value));
        return { client: array(cred.response.clientDataJSON), auth: array(cred.response.authenticatorData), sig: array(cred.response.signature) };
      }, { id, bytes: Array.from(challenge) });
      const client = Buffer.from(assertion.client);
      const auth = Buffer.from(assertion.auth);
      const info = JSON.parse(client.toString());
      assert.equal(info.type, "webauthn.get");
      assert.equal(info.origin, origin);
      assert.equal(info.challenge, challenge.toString("base64url"));
      assert.deepEqual(auth.subarray(0, 32), digest("localhost"));
      assert.equal(auth[32] & 5, 5);
      assert.ok(verify("sha256", Buffer.concat([auth, digest(client)]), key, Buffer.from(assertion.sig)));
      const prefix = `{"type":"webauthn.get","challenge":"${info.challenge}",`;
      assert.ok(client.toString().startsWith(prefix));
      const { r, s } = Signature.fromDerBytes(Uint8Array.from(assertion.sig));
      return { authenticatorData: `0x${auth.toString("hex")}`, clientDataFields: client.toString().slice(prefix.length, -1), r, s };
    }
    const jwk = key.export({ format: "jwk" });
    const coordinate = value => BigInt(`0x${Buffer.from(value, "base64url").toString("hex")}`);
    return {
      close,
      coordinates: { x: coordinate(jwk.x), y: coordinate(jwk.y) },
      signDigest(hexDigest) {
        assert.match(hexDigest, /^0x[0-9a-f]{64}$/i);
        return sign(Buffer.from(hexDigest.slice(2), "hex"));
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
