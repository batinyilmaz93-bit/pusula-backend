// auth.js — real email/password accounts, plus the original anonymous
// "device" flow kept for backward compatibility with existing sessions.
//
// Passwords are hashed with bcryptjs (pure JS, no native build step) before
// ever touching the database — plaintext passwords are never stored or
// logged.

import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import {
  createUser, getUser, createUserWithPassword, getUserByEmail,
  setResetToken, getUserByResetToken, updatePassword, updateUserProfile,
} from "./db.js";
import { sendEmail } from "./email.js";

const SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const sign = (user) => jwt.sign({ sub: user.id, name: user.name }, SECRET, { expiresIn: "180d" });

export async function issueDeviceToken(name) {
  const user = await createUser(name);
  return { token: sign(user), user };
}

export async function registerWithPassword(email, password, name) {
  const existing = await getUserByEmail(email);
  if (existing) throw new Error("Bu e-posta ile zaten bir hesap var, giriş yapmayı dene.");
  if (password.length < 6) throw new Error("Şifre en az 6 karakter olmalı.");
  const hash = await bcrypt.hash(password, 10);
  const user = await createUserWithPassword(email, hash, name);
  return { token: sign(user), user: { id: user.id, name: user.name, email: user.email, phone: user.phone } };
}

export async function loginWithPassword(email, password) {
  const user = await getUserByEmail(email);
  if (!user || !user.password_hash) throw new Error("E-posta veya şifre hatalı.");
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw new Error("E-posta veya şifre hatalı.");
  return { token: sign(user), user: { id: user.id, name: user.name, email: user.email, phone: user.phone } };
}

// Always returns the same generic result whether or not the email exists —
// this prevents the endpoint being used to check which emails are
// registered. The actual reset link (if the account exists) goes out by
// email only. In dev (no RESEND_API_KEY), the link is also returned in the
// response so the flow can be tested end-to-end without real email.
export async function requestPasswordReset(email) {
  const user = await getUserByEmail(email);
  let devLink = null;
  if (user) {
    const token = randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
    await setResetToken(user.id, token, expires);
    const appUrl = process.env.APP_URL || "http://localhost:5173";
    const link = `${appUrl}/?resetToken=${token}`;
    const result = await sendEmail({
      to: user.email,
      subject: "Pusula — Şifre sıfırlama",
      html: `<p>Merhaba ${user.name},</p><p>Şifreni sıfırlamak için <a href="${link}">buraya tıkla</a>. Bu bağlantı 1 saat geçerlidir.</p><p>Bu isteği sen yapmadıysan bu e-postayı yok sayabilirsin.</p>`,
    });
    if (!result.sent) devLink = link; // surfaced only when email delivery isn't configured
  }
  return { message: "Bu e-posta kayıtlıysa, şifre sıfırlama bağlantısı gönderildi.", devLink };
}

export async function confirmPasswordReset(token, newPassword) {
  if (newPassword.length < 6) throw new Error("Şifre en az 6 karakter olmalı.");
  const user = await getUserByResetToken(token);
  if (!user) throw new Error("Bağlantı geçersiz veya kullanılmış.");
  if (new Date(user.reset_token_expires) < new Date()) throw new Error("Bu bağlantının süresi dolmuş, yeniden şifre sıfırlama iste.");
  const hash = await bcrypt.hash(newPassword, 10);
  await updatePassword(user.id, hash);
  return { token: sign(user), user: { id: user.id, name: user.name, email: user.email, phone: user.phone } };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9+()\s-]{7,20}$/;

export async function updateProfile(userId, { name, phone, email } = {}) {
  const patch = {};
  if (name !== undefined) {
    if (!name?.trim()) throw new Error("İsim boş olamaz.");
    patch.name = name.trim();
  }
  if (phone !== undefined) {
    const trimmed = phone?.trim() || "";
    if (trimmed && !PHONE_RE.test(trimmed)) throw new Error("Telefon numarası geçersiz görünüyor.");
    patch.phone = trimmed || null;
  }
  if (email !== undefined) {
    const trimmed = email?.trim().toLowerCase() || "";
    if (trimmed) {
      if (!EMAIL_RE.test(trimmed)) throw new Error("E-posta adresi geçersiz görünüyor.");
      const existing = await getUserByEmail(trimmed);
      if (existing && existing.id !== userId) throw new Error("Bu e-posta başka bir hesapta kullanılıyor.");
    }
    patch.email = trimmed || null;
  }
  return updateUserProfile(userId, patch);
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
