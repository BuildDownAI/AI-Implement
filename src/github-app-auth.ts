import crypto from "node:crypto";

// Cache: org → { token, expiresAt }
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Wraps raw bytes in an ASN.1 TLV (tag-length-value) structure.
 */
function wrapAsn1(tag: number, content: Buffer): Buffer {
  const len = content.length;
  let header: Buffer;
  if (len < 128) {
    header = Buffer.from([tag, len]);
  } else if (len < 256) {
    header = Buffer.from([tag, 0x81, len]);
  } else if (len < 65536) {
    header = Buffer.from([tag, 0x82, (len >> 8) & 0xff, len & 0xff]);
  } else {
    header = Buffer.from([tag, 0x83, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  }
  return Buffer.concat([header, content]);
}

/**
 * Converts a PKCS#1 PEM key (BEGIN RSA PRIVATE KEY) to PKCS#8 (BEGIN PRIVATE KEY).
 * Node 22 / OpenSSL 3 on Alpine doesn't support PKCS#1 without the legacy provider,
 * so we wrap the PKCS#1 DER bytes in a PKCS#8 envelope.
 */
function pkcs1ToPkcs8(pkcs1Pem: string): string {
  const b64 = pkcs1Pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
    .replace(/-----END RSA PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const pkcs1Der = Buffer.from(b64, "base64");

  // PKCS#8 structure: SEQUENCE { version INTEGER 0, algorithm SEQUENCE { OID, NULL }, key OCTET STRING }
  const version = Buffer.from([0x02, 0x01, 0x00]);
  const rsaOid = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);
  const algoSeq = wrapAsn1(0x30, Buffer.concat([rsaOid, Buffer.from([0x05, 0x00])]));
  const keyOctet = wrapAsn1(0x04, pkcs1Der);
  const pkcs8Der = wrapAsn1(0x30, Buffer.concat([version, algoSeq, keyOctet]));

  const lines = pkcs8Der.toString("base64").match(/.{1,64}/g) || [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

/**
 * Parses a PEM private key, converting PKCS#1 to PKCS#8 if needed for OpenSSL 3 compat.
 */
function parsePrivateKey(pem: string): crypto.KeyObject {
  const normalized = pem.includes("-----BEGIN RSA PRIVATE KEY-----")
    ? pkcs1ToPkcs8(pem)
    : pem;
  return crypto.createPrivateKey(normalized);
}

/**
 * Creates a signed JWT for authenticating as a GitHub App.
 * Valid for 10 minutes (GitHub's max is 10 min).
 */
function createAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iat: now - 60, // 60s clock skew buffer
    exp: now + 600,
    iss: appId,
  })).toString("base64url");

  const signing = `${header}.${payload}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signing);
  const keyObject = parsePrivateKey(privateKey);
  const sig = sign.sign(keyObject, "base64url");
  return `${signing}.${sig}`;
}

/**
 * Returns a cached installation access token for the given org.
 * Tokens are valid for 1 hour; we cache for 50 minutes.
 *
 * The GitHub App must be installed on the target org.
 */
export async function getInstallationToken(
  appId: string,
  privateKey: string,
  org: string,
): Promise<string> {
  const cached = tokenCache.get(org);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  // Normalize PEM key — handle \n literals from env vars
  const normalizedKey = privateKey.replace(/\\n/g, "\n");
  const jwt = createAppJwt(appId, normalizedKey);

  const headers = {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ai-implement",
  };

  // Resolve installation ID for the org
  const installRes = await fetch(`https://api.github.com/orgs/${org}/installation`, { headers });
  if (!installRes.ok) {
    const body = await installRes.text();
    throw new Error(`GitHub App not installed on org "${org}" (${installRes.status}): ${body}`);
  }
  const install = await installRes.json() as { id: number };

  // Exchange for an installation access token
  const tokenRes = await fetch(
    `https://api.github.com/app/installations/${install.id}/access_tokens`,
    { method: "POST", headers },
  );
  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    throw new Error(`Failed to get installation token for org "${org}" (${tokenRes.status}): ${body}`);
  }
  const tokenData = await tokenRes.json() as { token: string; expires_at: string };

  tokenCache.set(org, { token: tokenData.token, expiresAt: Date.now() + 50 * 60 * 1000 });
  return tokenData.token;
}

/** Clears the token cache (useful for testing). */
export function clearTokenCache(): void {
  tokenCache.clear();
}
