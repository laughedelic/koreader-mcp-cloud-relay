/**
 * Offline memory: encryption bound to each paired AI app
 *
 * A reader can push a snapshot of what is being read, so paired AI apps can
 * still ask about it while the reader is offline. The relay must not be able
 * to read that snapshot on its own, so it is sealed like this:
 *
 * - Every paired app (OAuth grant) has an ECDH P-256 key pair. The private
 *   key lives only in the grant's `props`, which the OAuth provider stores
 *   encrypted with the app's token as key material. The public key is stored
 *   openly in the device's Durable Object.
 * - When a snapshot arrives, the Durable Object encrypts it with a fresh
 *   AES-256-GCM content key, wraps that key for every paired app's public
 *   key (ephemeral-static ECDH, then HKDF), stores the ciphertext and forgets
 *   the content key.
 * - When a paired app calls with a valid token and the reader is offline,
 *   the Worker gets the private key from the decrypted props, unwraps the
 *   content key and reads the snapshot for that one request.
 *
 * So the stored snapshot is unreadable from storage alone: reading it takes
 * a live token of a paired app. Revoking an app deletes its grant and tokens,
 * and with them the only copy of its private key.
 */

const CURVE = "P-256";
const CONTENT_AAD = new TextEncoder().encode("koreader-mcp-relay/snapshot/v1");
const WRAP_INFO_PREFIX = "koreader-mcp-relay/snapshot-key/v1/";
const HKDF_SALT = new Uint8Array(32);

/** A paired app's key pair, as kept in its grant props */
export interface AppKey {
  id: string;
  /** Private ECDH key (JWK, includes the public part) */
  jwk: JsonWebKey;
}

/** A content key wrapped for one app */
export interface WrappedKey {
  iv: string;
  key: string;
}

/** An encrypted snapshot as stored by the device's Durable Object */
export interface SealedSnapshot {
  /** Ephemeral public key used to wrap the content key */
  eph: JsonWebKey;
  /** IV of the content encryption */
  iv: string;
  /** Content key, wrapped once per paired app (by key ID) */
  wraps: Record<string, WrappedKey>;
  /** AES-256-GCM ciphertext of the snapshot JSON */
  ct: ArrayBuffer;
}

export const APP_KEY_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** The public part of an ECDH JWK, and nothing else */
export function publicJwk(jwk: JsonWebKey): JsonWebKey {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

/** Check that a value is a P-256 public key in JWK form; returns a clean copy or null */
export function parsePublicJwk(value: unknown): JsonWebKey | null {
  if (!value || typeof value !== "object") return null;
  const jwk = value as Record<string, unknown>;
  const coordinate = /^[A-Za-z0-9_-]{43}$/;
  if (jwk.kty !== "EC" || jwk.crv !== CURVE) return null;
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") return null;
  if (!coordinate.test(jwk.x) || !coordinate.test(jwk.y)) return null;
  return { kty: "EC", crv: CURVE, x: jwk.x, y: jwk.y };
}

/** Check the shape of an app key taken from grant props */
export function parseAppKey(value: unknown): AppKey | null {
  if (!value || typeof value !== "object") return null;
  const key = value as { id?: unknown; jwk?: unknown };
  if (typeof key.id !== "string" || !APP_KEY_ID_PATTERN.test(key.id)) return null;
  if (!parsePublicJwk(key.jwk) || typeof (key.jwk as JsonWebKey).d !== "string") return null;
  return { id: key.id, jwk: key.jwk as JsonWebKey };
}

/** Create the key pair of a newly paired app */
export async function generateAppKey(): Promise<AppKey> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: CURVE }, true, ["deriveBits"]) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey;
  return {
    id: toBase64(randomBytes(18)).replace(/\+/g, "-").replace(/\//g, "_"),
    jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d },
  };
}

/** Derive the key that wraps the content key for one app */
async function deriveWrapKey(
  privateKey: CryptoKey, publicKey: CryptoKey, keyId: string, usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  // (workers-types misnames the `public` field, hence the cast)
  const algorithm = { name: "ECDH", public: publicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const shared = await crypto.subtle.deriveBits(algorithm, privateKey, 256);
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: new TextEncoder().encode(WRAP_INFO_PREFIX + keyId) },
    material, { name: "AES-GCM", length: 256 }, false, [usage]);
}

function importPublic(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", publicJwk(jwk), { name: "ECDH", namedCurve: CURVE }, false, []);
}

/**
 * Encrypt a snapshot for a set of paired apps
 * @param recipients public keys by key ID; keys that fail to import are skipped
 */
export async function sealSnapshot(
  plaintext: ArrayBuffer | Uint8Array, recipients: Record<string, JsonWebKey>,
): Promise<SealedSnapshot> {
  const contentKeyBytes = randomBytes(32);
  const contentKey = await crypto.subtle.importKey("raw", contentKeyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: CONTENT_AAD }, contentKey, plaintext);

  const ephemeral = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: CURVE }, true, ["deriveBits"]) as CryptoKeyPair;
  const wraps: Record<string, WrappedKey> = {};
  for (const [keyId, jwk] of Object.entries(recipients)) {
    try {
      const wrapKey = await deriveWrapKey(ephemeral.privateKey, await importPublic(jwk), keyId, "encrypt");
      const wrapIv = randomBytes(12);
      const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv: wrapIv }, wrapKey, contentKeyBytes);
      wraps[keyId] = { iv: toBase64(wrapIv), key: toBase64(new Uint8Array(wrapped)) };
    } catch {
      // an unusable public key only locks out that one app
    }
  }
  contentKeyBytes.fill(0);

  return {
    eph: publicJwk(await crypto.subtle.exportKey("jwk", ephemeral.publicKey) as JsonWebKey),
    iv: toBase64(iv),
    wraps,
    ct,
  };
}

/** Decrypt a snapshot with one app's key; throws if the key doesn't fit */
export async function openSnapshot(
  sealed: { eph: JsonWebKey; iv: string; wrap: WrappedKey; ct: ArrayBuffer | Uint8Array }, appKey: AppKey,
): Promise<ArrayBuffer> {
  const privateKey = await crypto.subtle.importKey(
    "jwk", appKey.jwk, { name: "ECDH", namedCurve: CURVE }, false, ["deriveBits"]);
  const wrapKey = await deriveWrapKey(privateKey, await importPublic(sealed.eph), appKey.id, "decrypt");
  const contentKeyBytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(sealed.wrap.iv) }, wrapKey, fromBase64(sealed.wrap.key));
  const contentKey = await crypto.subtle.importKey("raw", contentKeyBytes, "AES-GCM", false, ["decrypt"]);
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(sealed.iv), additionalData: CONTENT_AAD }, contentKey, sealed.ct);
}
