import { Router } from "express";
import {
  issueDeviceToken, registerWithPassword, loginWithPassword,
  requestPasswordReset, confirmPasswordReset, updateProfile, requireAuth,
} from "../auth.js";
import { exportUserData, deleteUserAccount } from "../db.js";

const router = Router();

// Kept for backward compatibility with sessions created before login support.
router.post("/device", async (req, res) => {
  const name = (req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "İsim gerekli" });
  const { token, user } = await issueDeviceToken(name);
  res.json({ token, user });
});

router.post("/register", async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email?.trim() || !password || !name?.trim()) {
    return res.status(400).json({ error: "İsim, e-posta ve şifre gerekli" });
  }
  try {
    const { token, user } = await registerWithPassword(email.trim(), password, name.trim());
    res.status(201).json({ token, user });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email?.trim() || !password) return res.status(400).json({ error: "E-posta ve şifre gerekli" });
  try {
    const { token, user } = await loginWithPassword(email.trim(), password);
    res.json({ token, user });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

router.post("/request-reset", async (req, res) => {
  const { email } = req.body || {};
  if (!email?.trim()) return res.status(400).json({ error: "E-posta gerekli" });
  try {
    const result = await requestPasswordReset(email.trim());
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/confirm-reset", async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: "Token ve yeni şifre gerekli" });
  try {
    const { token: authToken, user } = await confirmPasswordReset(token, password);
    res.json({ token: authToken, user });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch("/profile", requireAuth, async (req, res) => {
  try {
    const { name, phone, email, avatarPhoto } = req.body || {};
    const user = await updateProfile(req.userId, { name, phone, email, avatarPhoto });
    res.json({ user: { id: user.id, name: user.name, email: user.email, phone: user.phone, avatarPhoto: user.avatar_photo } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/export", requireAuth, async (req, res) => {
  try {
    const data = await exportUserData(req.userId);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/account", requireAuth, async (req, res) => {
  try {
    await deleteUserAccount(req.userId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
