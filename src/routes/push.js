import { Router } from "express";
import * as db from "../db.js";
import { requireAuth } from "../auth.js";
import { getVapidPublicKey, isPushConfigured } from "../push.js";

const router = Router();

// Public — the frontend needs this before the user is even logged in isn't
// true here (subscribing only makes sense once logged in), but harmless to
// expose without auth.
router.get("/vapid-public-key", (req, res) => {
  res.json({ publicKey: getVapidPublicKey(), configured: isPushConfigured() });
});

router.use(requireAuth);

router.post("/subscribe", async (req, res) => {
  const { subscription, prefs } = req.body || {};
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: "Geçersiz abonelik verisi" });
  }
  try {
    await db.upsertPushSubscription(req.userId, {
      endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth, prefs,
    });
    res.status(201).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/unsubscribe", async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: "endpoint gerekli" });
  await db.removePushSubscription(endpoint);
  res.json({ ok: true });
});

router.patch("/prefs", async (req, res) => {
  const { endpoint, prefs } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: "endpoint gerekli" });
  await db.updatePushPrefs(endpoint, prefs || {});
  res.json({ ok: true });
});

export default router;
