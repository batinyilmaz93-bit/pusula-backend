import { Router } from "express";
import * as db from "../db.js";
import { requireAuth } from "../auth.js";
import { sendEmail } from "../email.js";
import { sendPushToUsers } from "../push.js";

export default function tripsRouter(io) {
  const router = Router();
  router.use(requireAuth);

  const broadcast = async (tripId) => {
    const fresh = await db.getTripFull(tripId);
    if (fresh) io.to(`trip:${tripId}`).emit("trip:update", fresh);
    return fresh;
  };

  // Distinct from broadcast(): this is specifically for events that should
  // trigger a user-facing notification (toast + sound), not every data
  // refresh. The frontend also uses actorUserId to skip notifying whoever
  // just performed the action themselves.
  const notify = (tripId, { type, title, body, actorUserId }) => {
    io.to(`trip:${tripId}`).emit("trip:notify", { type, title, body, actorUserId, tripId, at: new Date().toISOString() });
  };

  const assertMember = async (req, res) => {
    if (!(await db.isTripMember(req.params.id, req.userId))) {
      res.status(403).json({ error: "Bu seyahatin üyesi değilsin" });
      return false;
    }
    return true;
  };

  // "viewer" role members can see everything but can't add/edit content —
  // used to gate expense/hazard/photo/chat mutations, not read routes.
  const assertCanEdit = async (req, res) => {
    if (!(await assertMember(req, res))) return false;
    const role = await db.getMemberRole(req.params.id, req.userId);
    if (role === "viewer") {
      res.status(403).json({ error: "Sadece görüntüleme yetkin var, değişiklik yapamazsın" });
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
    const alreadyMember = await db.isTripMember(trip.id, req.userId);
    if (!alreadyMember) {
      await db.addMember(trip.id, { userId: req.userId, name: req.userName });
    }
    const fresh = await broadcast(trip.id);
    if (!alreadyMember) {
      notify(trip.id, { type: "member_joined", title: "Yeni üye katıldı", body: `${req.userName} seyahate katıldı`, actorUserId: req.userId });
      const userIds = fresh.members.map(m => m.userId).filter(Boolean);
      sendPushToUsers(userIds, { type: "member_joined", title: "Yeni üye katıldı", body: `${req.userName}, "${fresh.name}" seyahatine katıldı`, excludeUserId: req.userId }).catch(() => {});
    }
    res.json(fresh);
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
    const email = (req.body?.email || "").trim() || null;
    if (!name) return res.status(400).json({ error: "İsim gerekli" });
    await db.addMember(req.params.id, { name, email }); // guest member, no device account yet
    const fresh = await broadcast(req.params.id);
    if (email) {
      const appUrl = process.env.APP_URL || "http://localhost:5173";
      const joinLink = `${appUrl}/?join=${fresh.inviteCode}`;
      // Fire-and-forget: a slow/misconfigured email provider shouldn't block
      // the member actually being added — the trip already has them either way.
      sendEmail({
        to: email,
        subject: `${fresh.name} seyahatine davet edildin — Pusula`,
        html: `<p>Merhaba ${name},</p><p><b>${req.userName}</b> seni <b>${fresh.name}</b> (${fresh.city}, ${fresh.country}) seyahatine ekledi.</p><p>Ortak bütçeyi ve seyahat detaylarını görmek için <a href="${joinLink}">buraya tıkla</a>, ya da Pusula uygulamasında davet kodunu gir: <b>${fresh.inviteCode}</b></p>`,
      }).catch(err => console.error("[members] davet e-postası gönderilemedi:", err));
    }
    res.status(201).json(fresh);
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

  router.patch("/:id/members/:memberId/role", h(async (req, res) => {
    if (!(await assertMember(req, res))) return;
    const trip = await db.getTripFull(req.params.id);
    const isAdmin = trip.members.find(m => m.id === trip.admin)?.userId === req.userId;
    if (!isAdmin) return res.status(403).json({ error: "Sadece admin rol değiştirebilir" });
    if (req.params.memberId === trip.admin) return res.status(400).json({ error: "Admin'in rolü değiştirilemez" });
    const { role } = req.body || {};
    try {
      await db.setMemberRole(req.params.id, req.params.memberId, role);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    res.json(await broadcast(req.params.id));
  }));

  // ---- expenses ----
  router.post("/:id/expenses", h(async (req, res) => {
    if (!(await assertCanEdit(req, res))) return;
    const { desc, amount, category, paidBy, splitAmong, receiptPhoto } = req.body || {};
    if (!desc?.trim() || !amount || amount <= 0 || !paidBy || !splitAmong?.length) {
      return res.status(400).json({ error: "Eksik veya geçersiz harcama verisi" });
    }
    if (receiptPhoto && receiptPhoto.length > 4_000_000) {
      return res.status(400).json({ error: "Fotoğraf çok büyük, daha küçük bir tane dene" });
    }
    await db.addExpense(req.params.id, { desc: desc.trim(), amount, category, paidBy, splitAmong, receiptPhoto: receiptPhoto || null });
    const fresh = await broadcast(req.params.id);
    notify(req.params.id, { type: "expense_added", title: "Yeni harcama", body: `${req.userName}: "${desc.trim()}" — ${amount} eklendi`, actorUserId: req.userId });
    sendPushToUsers(fresh.members.map(m => m.userId).filter(Boolean), {
      type: "expense_added", title: "Yeni harcama", body: `${req.userName}: "${desc.trim()}" — ${amount} eklendi`, excludeUserId: req.userId,
    }).catch(() => {});
    res.status(201).json(fresh);
  }));

  router.post("/:id/settle", h(async (req, res) => {
    if (!(await assertCanEdit(req, res))) return;
    const { from, to, amount } = req.body || {};
    if (!from || !to || !amount || amount <= 0) return res.status(400).json({ error: "Eksik ödeme verisi" });
    const trip = await db.getTripFull(req.params.id);
    const nameOf = (id) => trip.members.find(m => m.id === id)?.name || "?";
    await db.addExpense(req.params.id, {
      desc: `Ödeme: ${nameOf(from)} → ${nameOf(to)}`, amount, category: "diger",
      paidBy: from, splitAmong: [to], isSettlement: true,
    });
    const fresh = await broadcast(req.params.id);
    notify(req.params.id, { type: "payment_made", title: "Ödeme yapıldı", body: `${nameOf(from)}, ${nameOf(to)}'ya ${amount} ödedi`, actorUserId: req.userId });
    sendPushToUsers(fresh.members.map(m => m.userId).filter(Boolean), {
      type: "payment_made", title: "Ödeme yapıldı", body: `${nameOf(from)}, ${nameOf(to)}'ya ${amount} ödedi`, excludeUserId: req.userId,
    }).catch(() => {});
    res.status(201).json(fresh);
  }));

  router.delete("/:id/expenses/:expenseId", h(async (req, res) => {
    if (!(await assertCanEdit(req, res))) return;
    await db.deleteExpense(req.params.id, req.params.expenseId);
    res.json(await broadcast(req.params.id));
  }));

  router.post("/:id/photos", h(async (req, res) => {
    if (!(await assertCanEdit(req, res))) return;
    const { photo } = req.body || {};
    if (!photo) return res.status(400).json({ error: "Fotoğraf gerekli" });
    if (photo.length > 3_000_000) return res.status(400).json({ error: "Fotoğraf çok büyük" });
    const count = await db.countTripPhotos(req.params.id);
    if (count >= 5) return res.status(400).json({ error: "Bu seyahat için en fazla 5 fotoğraf yüklenebilir" });
    await db.addTripPhoto(req.params.id, { photo, uploadedBy: req.userId });
    res.status(201).json(await broadcast(req.params.id));
  }));

  router.delete("/:id/photos/:photoId", h(async (req, res) => {
    if (!(await assertCanEdit(req, res))) return;
    await db.deleteTripPhoto(req.params.id, req.params.photoId);
    res.json(await broadcast(req.params.id));
  }));

  router.get("/:id/messages", h(async (req, res) => {
    if (!(await assertMember(req, res))) return;
    const messages = await db.getMessages(req.params.id);
    res.json({ messages });
  }));

  router.post("/:id/messages", h(async (req, res) => {
    if (!(await assertMember(req, res))) return;
    const trip = await db.getTripFull(req.params.id);
    const me = trip.members.find(m => m.userId === req.userId);
    if (!me) return res.status(403).json({ error: "Bu seyahatin üyesi değilsin" });

    const { kind, text, lat, lon, photo, live } = req.body || {};
    if (kind === "location") {
      if (typeof lat !== "number" || typeof lon !== "number") {
        return res.status(400).json({ error: "Konum bilgisi geçersiz" });
      }
    } else if (kind === "photo") {
      if (!photo) return res.status(400).json({ error: "Fotoğraf gerekli" });
      if (photo.length > 3_000_000) return res.status(400).json({ error: "Fotoğraf çok büyük" });
    } else if (!text?.trim()) {
      return res.status(400).json({ error: "Mesaj boş olamaz" });
    }
    const validKind = ["location", "photo"].includes(kind) ? kind : "text";
    const message = await db.addMessage(req.params.id, {
      senderMemberId: me.id, senderName: me.name,
      kind: validKind,
      text: text?.trim(), lat, lon, live: validKind === "location" ? !!live : false, photo: validKind === "photo" ? photo : null,
    });
    // Chat is high-frequency — push just the new message over the socket
    // instead of re-broadcasting (and every client re-fetching) the whole
    // trip object the way other mutations do.
    io.to(`trip:${req.params.id}`).emit("trip:message", message);
    const isLocation = message.kind === "location";
    const isPhoto = message.kind === "photo";
    // Live-tracking sends a new location every ~45s — only the first one
    // (frontend passes live:false for that one, true for the periodic
    // follow-ups) should actually ping people; otherwise every walk down
    // the street would spam everyone's phone with notifications.
    const shouldNotify = !isLocation || !live;
    if (shouldNotify) {
      sendPushToUsers(trip.members.map(m => m.userId).filter(Boolean), {
        type: isLocation ? "location_shared" : "chat_message",
        title: isLocation ? "Konum paylaşıldı" : me.name,
        body: isLocation ? `${me.name} konumunu paylaşıyor` : isPhoto ? `${me.name} bir fotoğraf gönderdi` : message.text,
        excludeUserId: req.userId,
      }).catch(() => {});
    }
    res.status(201).json(message);
  }));

  // ---- hazards (community safety notes) ----
  router.post("/:id/hazards", h(async (req, res) => {
    if (!(await assertCanEdit(req, res))) return;
    const text = (req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "Metin gerekli" });
    await db.addHazard(req.params.id, text, req.userId);
    res.status(201).json(await broadcast(req.params.id));
  }));

  router.delete("/:id/hazards/:hazardId", h(async (req, res) => {
    if (!(await assertCanEdit(req, res))) return;
    await db.deleteHazard(req.params.id, req.params.hazardId);
    res.json(await broadcast(req.params.id));
  }));

  return router;
}
