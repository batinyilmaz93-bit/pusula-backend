// push.js — sends real push notifications (the kind that arrive even when
// the phone is locked / the app/browser is fully closed) using the Web
// Push standard. Unlike Resend or Geoapify, this needs NO third-party
// account or API key — VAPID is just a self-generated keypair, and the
// actual delivery infrastructure is run by the browser vendors themselves
// (Google/Mozilla/Apple), which the `web-push` library talks to directly.
//
// Setup: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY as environment
// variables (a matching pair — generating a fresh one without updating both
// breaks delivery). Without them, this module no-ops instead of crashing,
// so the rest of the app keeps working.

import webpush from "web-push";
import * as db from "./db.js";

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const configured = !!(PUBLIC_KEY && PRIVATE_KEY);

if (configured) {
  webpush.setVapidDetails("mailto:support@pusulaseyahat.app", PUBLIC_KEY, PRIVATE_KEY);
} else {
  console.log("[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY ayarlanmamış — push bildirimleri gönderilmeyecek (uygulama yine de çalışır).");
}

export const isPushConfigured = () => configured;
export const getVapidPublicKey = () => PUBLIC_KEY || null;

// Sends to every subscribed device belonging to the given users, except the
// one who triggered the event, and only if that subscription has this
// notification `type` enabled in its stored preferences.
export async function sendPushToUsers(userIds, { type, title, body, excludeUserId, url }) {
  if (!configured) return;
  const targets = userIds.filter(id => id !== excludeUserId);
  if (!targets.length) return;
  const subs = await db.getPushSubscriptionsForUsers(targets);
  const payload = JSON.stringify({ title, body, type, url: url || "/" });

  await Promise.all(subs.map(async (sub) => {
    if (sub.prefs[type] === false) return; // this device opted out of this category
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
    } catch (e) {
      // 404/410 = the browser/OS has invalidated this subscription (app
      // uninstalled, permissions revoked, etc.) — clean it up so we stop
      // wasting sends on it.
      if (e.statusCode === 404 || e.statusCode === 410) {
        await db.removePushSubscription(sub.endpoint).catch(() => {});
      } else {
        console.error("[push] gönderim hatası:", e.statusCode, e.message);
      }
    }
  }));
}
