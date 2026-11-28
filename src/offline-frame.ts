/**
 * The internal message a device's Durable Object returns to the Worker when
 * the device can't answer an MCP request: a JSON header (OfflineInfo)
 * followed by the snapshot ciphertext, if there is one for the calling app.
 *
 * Layout: 4-byte big-endian header length, header JSON (UTF-8), ciphertext.
 * It never leaves the Worker: the Worker turns it into an MCP response.
 */

import type { OfflineInfo } from "./types";

/** Response header that marks an offline frame */
export const OFFLINE_FRAME_HEADER = "X-Relay-Offline";

export function encodeOfflineFrame(info: OfflineInfo, ciphertext?: ArrayBuffer): Uint8Array {
  const header = new TextEncoder().encode(JSON.stringify(info));
  const body = ciphertext ? new Uint8Array(ciphertext) : new Uint8Array(0);
  const frame = new Uint8Array(4 + header.length + body.length);
  new DataView(frame.buffer).setUint32(0, header.length);
  frame.set(header, 4);
  frame.set(body, 4 + header.length);
  return frame;
}

export function decodeOfflineFrame(buffer: ArrayBuffer): { info: OfflineInfo; ciphertext: Uint8Array } {
  if (buffer.byteLength < 4) throw new Error("offline frame too short");
  const headerLength = new DataView(buffer).getUint32(0);
  if (4 + headerLength > buffer.byteLength) throw new Error("offline frame header out of range");
  const info = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength))) as OfflineInfo;
  return { info, ciphertext: new Uint8Array(buffer, 4 + headerLength) };
}
