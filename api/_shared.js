import crypto from "node:crypto";

const ROOM_CODE_MIN = 1000;
const ROOM_CODE_MAX = 9999;

export function json(res, statusCode, body) {
  res.status(statusCode).setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(body));
}

export function methodGuard(req, res, method) {
  if (req.method !== method) {
    json(res, 405, { ok: false, error: "method_not_allowed" });
    return false;
  }
  return true;
}

export function normalizeName(name) {
  return String(name || "").trim().slice(0, 20).replace(/\s+/g, " ");
}

export function randomRoomCode() {
  const code = crypto.randomInt(ROOM_CODE_MIN, ROOM_CODE_MAX + 1);
  return String(code);
}

export function randomPlayerId() {
  return crypto.randomBytes(8).toString("hex");
}

function getSigningSecret() {
  return process.env.ROOM_SIGNING_SECRET || process.env.PUSHER_SECRET || "dev-only-secret";
}

function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function fromB64url(input) {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4;
  const padded = pad ? base64 + "=".repeat(4 - pad) : base64;
  return Buffer.from(padded, "base64").toString();
}

export function signRoomToken(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto
    .createHmac("sha256", getSigningSecret())
    .update(body)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${body}.${sig}`;
}

export function verifyRoomToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  const expected = crypto
    .createHmac("sha256", getSigningSecret())
    .update(body)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  try {
    const parsed = JSON.parse(fromB64url(body));
    if (parsed.exp && Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function channelForRoom(roomCode) {
  return `presence-rps-${roomCode}`;
}
