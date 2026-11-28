/**
 * PairingIndex Durable Object
 *
 * One instance (named "global") maps short-lived 6-digit pairing codes to
 * device IDs, so the sign-in page can ask for the code alone.
 *
 * A code only opens a pairing window: it is single use, expires after
 * PAIRING_CODE_TTL_MS, and a device has at most one live code. The lasting
 * credential is the OAuth grant issued once the code is redeemed.
 *
 * Because the code alone picks the device, wrong guesses are capped
 * relay-wide as well as per IP. With N codes live, each guess hits with
 * probability N / 1,000,000, so at most GLOBAL_MAX_FAILURES guesses per
 * window keeps an attacker's odds per window around N in 10,000.
 */

export const PAIRING_CODE_TTL_MS = 10 * 60_000;

const FAILURE_WINDOW_MS = 10 * 60_000;
const PER_IP_MAX_FAILURES = 10;
const GLOBAL_MAX_FAILURES = 100;
const MINTS_PER_DEVICE_PER_HOUR = 20;

interface PairingEntry {
  deviceId: string;
  expiresAt: number;
}

interface Window {
  count: number;
  resetAt: number;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Uniform random 6-digit string (rejection sampling avoids modulo bias) */
function randomSixDigits(): string {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / 1_000_000) * 1_000_000;
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return String(buf[0] % 1_000_000).padStart(6, "0");
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export class PairingIndex implements DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname.replace(/^\/+/, "");
    if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    // Hashing is async and not a storage call, so without this other requests
    // could interleave mid-operation: a burst of guesses could all read the
    // failure counters before any of them is bumped, or redeem a code twice
    return this.state.blockConcurrencyWhile(async () => {
      switch (action) {
        case "mint":
          return this.mint(String(body.deviceId || ""));
        case "redeem":
          return this.redeem(String(body.code || ""), String(body.ip || "unknown"),
            typeof body.deviceId === "string" && body.deviceId ? body.deviceId : undefined);
        case "revoke-device":
          await this.dropDeviceCode(String(body.deviceId || ""));
          return json({ ok: true });
        default:
          return json({ error: "Not Found" }, 404);
      }
    });
  }

  /** Create a fresh code for a device (replacing its previous one) */
  private async mint(deviceId: string): Promise<Response> {
    if (!deviceId) return json({ error: "deviceId is required" }, 400);
    const now = Date.now();

    const mintKey = `mints:${deviceId}`;
    const mints = await this.bumpWindow(mintKey, 60 * 60_000, now, false);
    if (mints.count >= MINTS_PER_DEVICE_PER_HOUR) {
      return json({ error: "Too many pairing codes requested. Try again later.", code: "TOO_MANY_CODES" }, 429);
    }
    await this.bumpWindow(mintKey, 60 * 60_000, now, true);

    await this.dropDeviceCode(deviceId);
    await this.sweepExpired(now);

    // Codes must be unique among live codes; the space is far larger than the
    // number of devices pairing at once, so this loop ends quickly
    let code = "";
    let key = "";
    for (let i = 0; i < 20; i++) {
      code = randomSixDigits();
      key = `code:${await sha256Hex(code)}`;
      if (!(await this.state.storage.get(key))) break;
      code = "";
    }
    if (!code) return json({ error: "Could not allocate a pairing code. Try again." }, 503);

    const expiresAt = now + PAIRING_CODE_TTL_MS;
    await this.state.storage.put(key, { deviceId, expiresAt } satisfies PairingEntry);
    await this.state.storage.put(`device:${deviceId}`, key);
    return json({ code, expiresAt, expiresIn: Math.floor(PAIRING_CODE_TTL_MS / 1000) });
  }

  /**
   * Exchange a code for its device ID, once. With `expectedDeviceId` (sign-in
   * started from a device-specific URL) a code for another device counts as
   * a wrong guess and stays valid for its own device.
   */
  private async redeem(code: string, ip: string, expectedDeviceId?: string): Promise<Response> {
    const now = Date.now();
    const ipKey = `fail-ip:${ip}`;
    const globalKey = "fail-global";

    const ipFailures = await this.bumpWindow(ipKey, FAILURE_WINDOW_MS, now, false);
    const globalFailures = await this.bumpWindow(globalKey, FAILURE_WINDOW_MS, now, false);
    if (ipFailures.count >= PER_IP_MAX_FAILURES || globalFailures.count >= GLOBAL_MAX_FAILURES) {
      const resetAt = Math.max(
        ipFailures.count >= PER_IP_MAX_FAILURES ? ipFailures.resetAt : 0,
        globalFailures.count >= GLOBAL_MAX_FAILURES ? globalFailures.resetAt : 0);
      const minutes = Math.max(1, Math.ceil((resetAt - now) / 60_000));
      return json({
        error: `Too many wrong codes. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        code: "TOO_MANY_ATTEMPTS",
      }, 429);
    }

    const normalized = code.replace(/\D/g, "");
    let entry: PairingEntry | undefined;
    let key = "";
    if (normalized.length === 6) {
      key = `code:${await sha256Hex(normalized)}`;
      entry = await this.state.storage.get<PairingEntry>(key);
    }

    const expired = !!entry && entry.expiresAt <= now;
    const otherDevice = !!entry && !expired && !!expectedDeviceId && entry.deviceId !== expectedDeviceId;
    if (!entry || expired || otherDevice) {
      if (expired && entry) {
        await this.state.storage.delete(key);
        await this.state.storage.delete(`device:${entry.deviceId}`);
      }
      await this.bumpWindow(ipKey, FAILURE_WINDOW_MS, now, true);
      await this.bumpWindow(globalKey, FAILURE_WINDOW_MS, now, true);
      return json({
        error: "That code is wrong or has expired. Get a new one on your reader: MCP server > Connect an AI app.",
        code: "INVALID_CODE",
      }, 401);
    }

    // Single use
    await this.state.storage.delete(key);
    await this.state.storage.delete(`device:${entry.deviceId}`);
    return json({ deviceId: entry.deviceId });
  }

  private async dropDeviceCode(deviceId: string): Promise<void> {
    if (!deviceId) return;
    const previous = await this.state.storage.get<string>(`device:${deviceId}`);
    if (previous) {
      await this.state.storage.delete(previous);
      await this.state.storage.delete(`device:${deviceId}`);
    }
  }

  /** Delete expired codes (cheap: only a handful are ever live) */
  private async sweepExpired(now: number): Promise<void> {
    const entries = await this.state.storage.list<PairingEntry>({ prefix: "code:" });
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) {
        await this.state.storage.delete(key);
        const current = await this.state.storage.get<string>(`device:${entry.deviceId}`);
        if (current === key) await this.state.storage.delete(`device:${entry.deviceId}`);
      }
    }
    for (const prefix of ["fail-ip:", "mints:"]) {
      const windows = await this.state.storage.list<Window>({ prefix });
      for (const [key, window] of windows) {
        if (window.resetAt <= now) await this.state.storage.delete(key);
      }
    }
  }

  /** Fixed-window counter; returns the current window, incremented if `increment` */
  private async bumpWindow(key: string, windowMs: number, now: number, increment: boolean): Promise<Window> {
    let window = await this.state.storage.get<Window>(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + windowMs };
    }
    if (increment) {
      window.count += 1;
      await this.state.storage.put(key, window);
    }
    return window;
  }
}
