import {
  channelForRoom,
  json,
  methodGuard,
  normalizeName,
  randomPlayerId,
  readBody,
  signRoomToken,
} from "./_shared.js";

const TTL_MS = 1000 * 60 * 60 * 4;

export default async function handler(req, res) {
  if (!methodGuard(req, res, "POST")) return;

  const body = await readBody(req);
  const roomCode = String(body?.roomCode || "").trim();
  const name = normalizeName(body?.name || "");

  if (!/^\d{4}$/.test(roomCode)) {
    json(res, 400, { ok: false, error: "invalid_room_code" });
    return;
  }

  if (!name) {
    json(res, 400, { ok: false, error: "invalid_name" });
    return;
  }

  const playerId = randomPlayerId();
  const token = signRoomToken({
    roomCode,
    playerId,
    name,
    role: "guest",
    exp: Date.now() + TTL_MS,
  });

  json(res, 200, {
    ok: true,
    roomCode,
    channel: channelForRoom(roomCode),
    playerId,
    role: "guest",
    token,
    expiresInMs: TTL_MS,
  });
}
