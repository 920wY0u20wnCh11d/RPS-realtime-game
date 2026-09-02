import {
  channelForRoom,
  json,
  methodGuard,
  normalizeName,
  randomPlayerId,
  randomRoomCode,
  readBody,
  signRoomToken,
} from "./_shared.js";

const TTL_MS = 1000 * 60 * 60 * 4;

export default async function handler(req, res) {
  if (!methodGuard(req, res, "POST")) return;

  const body = await readBody(req);
  const name = normalizeName(body?.name || "Host");
  if (!name) {
    json(res, 400, { ok: false, error: "invalid_name" });
    return;
  }

  const roomCode = randomRoomCode();
  const playerId = randomPlayerId();
  const token = signRoomToken({
    roomCode,
    playerId,
    name,
    role: "host",
    exp: Date.now() + TTL_MS,
  });

  json(res, 200, {
    ok: true,
    roomCode,
    channel: channelForRoom(roomCode),
    playerId,
    role: "host",
    token,
    expiresInMs: TTL_MS,
  });
}
