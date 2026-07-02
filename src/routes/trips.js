import { Router } from "express";
import * as db from "../db.js";
import { requireAuth } from "../auth.js";

export default function tripsRouter(io) {
  const router = Router();
  router.use(requireAuth);

  const broadcast = (tripId) => {
    const fresh = db.getTripFull(tripId);
    if (fresh) io.to(`trip:${tripId}`).emit("trip:update", fresh);
    return fresh;
  };

  const assertMember = (req, res) => {
    if (!db.isTripMember(req.params.id, req.userId)) {
      res.status(403).json({ error: "Bu seyahatin üyesi değilsin" });
      return false;
    }
    return true;
  };

  // Create a trip — creator becomes admin + first member.
  router.post("/", (req, res) => {
    const { name, country, city } = req.body || {};
    if (!name?.trim() || !country?.trim() || !city?.trim()) {
      return res.status(400).json({ error: "name, country, city gerekli" });
    }
    const trip = db.createTrip({
      name: name.trim(), country: country.trim(), city: city.trim(),
      adminUserId: req.userId, adminName: req.userName,
    });
    res.status(201).json(trip);
  });

  // List trips the current device belongs to.
  router.get("/", (req, res) => {
    res.json(db.listTripsForUser(req.userId));
  });

  // Join a trip via invite code.
  router.post("/join", (req, res) => {
    const { inviteCode } = req.body || {};
    const trip = db.findTripByInvite((inviteCode || "").toUpperCase().trim());
    if (!trip) return res.status(404).json({ error: "Davet kodu geçersiz" });
    if (!db.isTripMember(trip.id, req.userId)) {
      db.addMember(trip.id, { userId: req.userId, name: req.userName });
    }
    res.json(broadcast(trip.id));
  });

  router.get("/:id", (req, res) => {
    if (!assertMember(req, res)) return;
    const trip = db.getTripFull(req.params.id);
    if (!trip) return res.status(404).json({ error: "Seyahat bulunamadı" });
    res.json(trip);
  });

  router.delete("/:id", (req, res) => {
    if (!assertMember(req, res)) return;
    const trip = db.getTripFull(req.params.id);
    if (trip.members.find(m => m.id === trip.admin)?.userId !== req.userId) {
      return res.status(403).json({ error: "Sadece admin seyahati silebilir" });
    }
    db.deleteTrip(req.params.id);
    io.to(`trip:${req.params.id}`).emit("trip:deleted", { id: req.params.id });
    res.status(204).end();
  });

  // ---- members ----
  router.post("/:id/members", (req, res) => {
    if (!assertMember(req, res)) return;
    const name = (req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "İsim gerekli" });
    db.addMember(req.params.id, { name }); // guest member, no device account
    res.status(201).json(broadcast(req.params.id));
  });

  router.delete("/:id/members/:memberId", (req, res) => {
    if (!assertMember(req, res)) return;
    const result = db.removeMember(req.params.id, req.params.memberId);
    if (!result.ok) return res.status(409).json({ error: result.reason });
    res.json(broadcast(req.params.id));
  });

  // ---- expenses ----
  router.post("/:id/expenses", (req, res) => {
    if (!assertMember(req, res)) return;
    const { desc, amount, category, paidBy, splitAmong } = req.body || {};
    if (!desc?.trim() || !amount || amount <= 0 || !paidBy || !splitAmong?.length) {
      return res.status(400).json({ error: "Eksik veya geçersiz harcama verisi" });
    }
    db.addExpense(req.params.id, { desc: desc.trim(), amount, category, paidBy, splitAmong });
    res.status(201).json(broadcast(req.params.id));
  });

  router.post("/:id/settle", (req, res) => {
    if (!assertMember(req, res)) return;
    const { from, to, amount } = req.body || {};
    if (!from || !to || !amount || amount <= 0) return res.status(400).json({ error: "Eksik ödeme verisi" });
    const trip = db.getTripFull(req.params.id);
    const nameOf = (id) => trip.members.find(m => m.id === id)?.name || "?";
    db.addExpense(req.params.id, {
      desc: `Ödeme: ${nameOf(from)} → ${nameOf(to)}`, amount, category: "diger",
      paidBy: from, splitAmong: [to], isSettlement: true,
    });
    res.status(201).json(broadcast(req.params.id));
  });

  router.delete("/:id/expenses/:expenseId", (req, res) => {
    if (!assertMember(req, res)) return;
    db.deleteExpense(req.params.id, req.params.expenseId);
    res.json(broadcast(req.params.id));
  });

  // ---- hazards (community safety notes) ----
  router.post("/:id/hazards", (req, res) => {
    if (!assertMember(req, res)) return;
    const text = (req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "Metin gerekli" });
    db.addHazard(req.params.id, text, req.userId);
    res.status(201).json(broadcast(req.params.id));
  });

  router.delete("/:id/hazards/:hazardId", (req, res) => {
    if (!assertMember(req, res)) return;
    db.deleteHazard(req.params.id, req.params.hazardId);
    res.json(broadcast(req.params.id));
  });

  return router;
}
