// ws.js — realtime layer. Clients join a `trip:{id}` room after opening a
// trip; every mutation in routes/trips.js re-broadcasts the fresh trip object
// to that room, so every phone in the group sees updates within ~100ms
// instead of waiting for the next poll — this is the actual multi-device
// upgrade over the artifact's local-only window.storage.

export function attachSocketHandlers(io) {
  io.on("connection", (socket) => {
    socket.on("trip:join", (tripId) => {
      if (typeof tripId === "string") socket.join(`trip:${tripId}`);
    });
    socket.on("trip:leave", (tripId) => {
      if (typeof tripId === "string") socket.leave(`trip:${tripId}`);
    });
  });
}
