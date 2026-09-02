import crypto from "node:crypto";
import { json, methodGuard, readBody, verifyRoomToken } from "./_shared.js";

function pusherPresenceAuth({ socketId, channel, userId, userInfo }) {
  const key = process.env.PUSHER_KEY;
  const secret = process.env.PUSHER_SECRET;
  if (!key || !secret) {
    const missing = [];
    if (!key) missing.push("PUSHER_KEY");
    if (!secret) missing.push("PUSHER_SECRET");
    throw new Error(`missing_pusher_env:${missing.join(",")}`);
  }

  const channelData = JSON.stringify({
    user_id: userId,
    user_info: userInfo,
  });
  const stringToSign = `${socketId}:${channel}:${channelData}`;
  const signature = crypto.createHmac("sha256", secret).update(stringToSign).digest("hex");

  return {
    auth: `${key}:${signature}`,
    channel_data: channelData,
  };
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, "POST")) return;

  const body = await readBody(req);
  const socketId = body?.socket_id;
  const channel = body?.channel_name;
  const token = body?.token;
  const head = body?.head || null;

  if (!socketId || !channel || !token) {
    const missing = [];
    if (!socketId) missing.push("socket_id");
    if (!channel) missing.push("channel_name");
    if (!token) missing.push("token");
    json(res, 400, { ok: false, error: "missing_fields", missing });
    return;
  }

  const claims = verifyRoomToken(token);
  if (!claims) {
    json(res, 401, { ok: false, error: "invalid_or_expired_token" });
    return;
  }

  const expectedChannel = `presence-rps-${claims.roomCode}`;
  if (channel !== expectedChannel) {
    json(res, 403, { ok: false, error: "channel_mismatch" });
    return;
  }

  let auth;
  try {
    auth = pusherPresenceAuth({
      socketId,
      channel,
      userId: claims.playerId,
      userInfo: {
        n: claims.name,
        r: claims.role,
        h: head,
      },
    });
  } catch (error) {
    json(res, 500, { ok: false, error: error.message || "auth_failed" });
    return;
  }

  json(res, 200, auth);
}
