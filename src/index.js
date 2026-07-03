import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server } from "socket.io";

import authRouter from "./routes/auth.js";
import tripsRouter from "./routes/trips.js";
import proxyRouter from "./routes/proxy.js";
import { attachSocketHandlers } from "./ws.js";
import { initSchema } from "./db.js";

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });
attachSocketHandlers(io);

app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.use("/api/auth", authRouter);
app.use("/api/trips", tripsRouter(io));
app.use("/api/proxy", proxyRouter);

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ error: "Sunucu hatası" });
});

const PORT = process.env.PORT || 4000;

initSchema()
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(`Pusula seyahat backend http://localhost:${PORT}`);
    });
  })
  .catch((e) => {
    console.error("Veritabanı şeması oluşturulamadı — DATABASE_URL doğru mu?", e);
    process.exit(1);
  });
