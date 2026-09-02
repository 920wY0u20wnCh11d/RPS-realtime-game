import { json, methodGuard } from "./_shared.js";

export default async function handler(req, res) {
  if (!methodGuard(req, res, "GET")) return;

  json(res, 200, {
    ok: true,
    key: process.env.PUSHER_KEY || "",
    cluster: process.env.PUSHER_CLUSTER || "",
  });
}
