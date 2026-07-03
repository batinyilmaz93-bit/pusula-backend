// auth.js — lightweight "device identity" auth.
//
// This app doesn't need email/password accounts: a trip is a small group of
// friends joining via an invite code, exactly like the original artifact's
// model (pick a name, no login). So a "device" gets an anonymous user id the
// first time it calls /api/auth/device, a JWT is issued for that id, and
// every trip-scoped request is checked against trip membership.
//
// Swap-in path for a "real" identity system later: replace createUser/verify
// here with Supabase Auth / Clerk / NextAuth and keep every other route
// untouched — they only depend on `req.userId` being populated.

import jwt from "jsonwebtoken";
import { createUser, getUser } from "./db.js";

const SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

export async function issueDeviceToken(name) {
  const user = await createUser(name);
  const token = jwt.sign({ sub: user.id, name: user.name }, SECRET, { expiresIn: "180d" });
  return { token, user };
}

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Yetkilendirme gerekli (token yok)" });
  try {
    const payload = jwt.verify(token, SECRET);
    const user = await getUser(payload.sub);
    if (!user) return res.status(401).json({ error: "Geçersiz oturum" });
    req.userId = user.id;
    req.userName = user.name;
    next();
  } catch (e) {
    if (e?.name === "JsonWebTokenError" || e?.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Geçersiz veya süresi dolmuş token" });
    }
    console.error("Auth error:", e);
    return res.status(500).json({ error: "Kimlik doğrulama hatası" });
  }
}
