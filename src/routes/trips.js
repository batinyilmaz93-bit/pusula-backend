import { Router } from "express";
import * as db from "../db.js";
import { requireAuth } from "../auth.js";

export default function tripsRouter(io) {
  const router = Router();
  router.use(requireAuth);

  const broadcast = async (tripId) => {
    const fresh = await db.getTripFull(tripId);
    if (fresh) io.to(`trip:${tripId}`).emit("trip:update", fresh);
    return fresh;
  };

  const assertMember = async (req, res) => {
    if (!(await db.isTripMember(req.params.id, req.userId))) {
      res.status(403).json({ error: "Bu seyahatin üyesi değilsin" });
      return false;
    }
    return true;
  };

  // Wrap every handler so a DB error returns JSON instead of hanging/crashing.
  const h = (fn) => (req, res) => fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ error: "Sunucu hatası, lütfen tekrar dene" });
  });

  // Create a trip — creator becomes admin + first member.
  router.post("/", h(async (req, res) => {
    const { name, country, city } = req.body || {};
    if (!name?.trim() || !country?.trim() || !city?.trim()) {
      return res.status(400).json({ error: "name, country, city gerekli" });
    }
    const trip = await db.createTrip({
      name: name.trim(), country: country.trim(), city: city.trim(),
      adminUserId: req.userId, adminName: req.userName,
    });
    res.status(201).json(trip);
  }));

  // List trips the current device belongs to.
  router.get("/", h(async (req, res) => {
    res.json(await db.listTripsForUser(req.userId));
  }));

  // Join a trip via invite code.
  router.post("/join", h(async (req, res) => {
    const { inviteCode } = req.body || {};
    const trip = await db.findTripByInvite((inviteCode || "").toUpperCase().trim());
    if (!trip) return res.status(404).json({ error: "Davet kodu geçersiz" });
    if (!(await db.isTripMember(trip.id, req.userId))) {
      await db.addMember(trip.id, { userId: req.userId, name: req.userName });
    }
    res.json(await broadcast(trip.id));
  }));

  router.get("/:id", h(async (req, res) => {
    if (!(await assertMember(req, res))) return;
    const trip = await db.getTripFull(req.params.id);
    if (!trip) return res.status(404).json({ error: "Seyahat bulunamadı" });
    res.json(trip);
  }));

  router.patch("/:id", h(async (req, res) => {
    if (!(await assertMember(req, res))) return;
    const { currencyCode } = req.body || {};
    if (currencyCode) await db.setTripCurrency(req.params.id, currencyCode);
    res.json(await broadcast(req.params.id));
  }));

  router.delete("/:id", h(async (req, res) => {
    if (!(await assertMember(req, res))) return;
    const trip = await db.getTripFull(req.params.id);
    if (trip.members.find(m => m.id === trip.admin)?.userId !== req.userId) {
      return res.status(403).json({ error: "Sadece admin seyahati silebilir" });
    }
    await db.deleteTrip(req.params.id);
    io.to(`trip:${req.params.id}`).emit("trip:deleted", { id: req.params.id });
    res.status(204).end();
  }));

  // ---- members ----
  router.post("/:id/members", h(async (req, res) => {
    if (!(await assertMember(req, res))) return;
    const name = (req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "İsim gerekli" });
    await db.addMember(req.params.id, { name }); // guest member, no device account
    res.status(201).json(await broadcast(req.params.id));
  }));

  router.delete("/:id/members/:memberId", h(async (req, res) => {
    if (!(await assertMember(req, res))) return;
    const trip = await db.getTripFull(req.params.id);
    const isAdmin = trip.members.find(m => m.id === trip.admin)?.userId === req.userId;
    const isSelf = trip.members.find(m => m.id === req.params.memberId)?.userId === req.userId;
    if (!isAdmin && !isSelf) {
      return res.status(403).json({ error: "Bu işlemi sadece admin ya da kendisi yapabilir" });
    }
    const result = await db.removeMember(req.params.id, req.params.memberId);
    if (!result.ok) return res.status(409).json({ error: result.reason });
    res.json(await broadcast(req.params.id));
  }));

  // ---- expenses ----
  router.post("/:id/expenses", h(async (req, res) => {
    if (!(await assertMember(req, res))) return;
    const { desc, amount, category, paidBy, splitAmong } = req.body || {};
    if (!desc?.trim() || !amount || amount <= 0 || !paidBy || !splitAmong?.length) {
      return res.status(400).json({ error: "Eksik veya geçersiz harcama verisi" });
    }
    await db.addExpense(req.params.id, { desc: desc.trim(), amount, category, paidBy, splitAmong });
    res.status(201).json(await broadcast(req.params.id));
  }));

  router.post("/:id/settle", h(async (req, res) => {
    if (!(await assertMember(req, res))) return;
    const { from, to, amount } = req.body || {};
    if (!from || !to || !amount || amount <= 0) return res.status(400).json({ error: "Eksik ödeme verisi" });
    const trip = await db.getTripFull(req.params.id);
    const nameOf = (id) => trip.members.find(m => m.id === id)?.name || "?";
    await db.addExpense(req.params.id, {
      desc: `Ödeme: ${nameOf(from)} → ${nameOf(to)}`, amount, category: "diger",
      paidBy: from, splitAmong: [to], isSettlement: true,
    });
    res.status(201).json(await broadcast(req.params.id));
  }));

  router.delete("/:id/expenses/:expenseId", h(async (req, res) => {
    if (!(await assertMember(req, res))) return;
    await db.deleteExpense(req.params.id, req.params.expenseId);
    res.json(await broadcast(req.params.id));
  }));

  // ---- hazards (community safety notes) ----
  router.post("/:id/hazards", h(async (req, res) => {
    if (!(await assertMember(req, res))) return;
    const text = (req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "Metin gerekli" });
    await db.addHazard(req.params.id, text, req.userId);
    res.status(201).json(await broadcast(req.params.id));
  }));

  router.delete("/:id/hazards/:hazardId", h(async (req, res) => {
    if (!(await assertMember(req, res))) return;
    await db.deleteHazard(req.params.id, req.params.hazardId);
    res.json(await broadcast(req.params.id));
  }));

  return router;
}
