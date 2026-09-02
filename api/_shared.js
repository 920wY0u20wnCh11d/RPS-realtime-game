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

async function readRawBody(req) {
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");

  if (req.body && typeof req.body === "object") {
    return JSON.stringify(req.body);
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  const raw = await readRawBody(req);
  if (!raw) return {};

  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw).entries());
  }

  try {
    return JSON.parse(raw);
  } catch {
    return Object.fromEntries(new URLSearchParams(raw).entries());
  }
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

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;

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
