import { Router } from "express";
import { issueDeviceToken } from "../auth.js";

const router = Router();

router.post("/device", (req, res) => {
  const name = (req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "İsim gerekli" });
  const { token, user } = issueDeviceToken(name);
  res.json({ token, user });
});

export default router;
