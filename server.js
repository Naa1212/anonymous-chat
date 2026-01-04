const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 50 * 1024 * 1024, // 50MB buffer
});

app.use(express.static("public"));

// ===== LIVE CHAT STATE =====
let queue = [];
const partners = new Map();        // socketId -> socketId
const identBySocket = new Map();   // socketId -> ident

// ===== Agreement =====
function isAgreed(socket) {
  return socket.data.agreed === true;
}

// ===== Ident =====
function getIP(socket) {
  return socket.handshake.address || "unknown";
}
function makeIdent(socket) {
  const ip = getIP(socket);
  const ua = (socket.handshake.headers["user-agent"] || "").slice(0, 160);
  return `${ip}::${ua}`;
}

// ===== Pairing =====
function pair(a, b) {
  partners.set(a, b);
  partners.set(b, a);
}
function unpair(a) {
  const b = partners.get(a);
  if (b) partners.delete(b);
  partners.delete(a);
}

// ===== Moderation: report threshold ban =====
const REPORT_THRESHOLD = 10;
const BAN_MS = 24 * 60 * 60 * 1000; // 24h

// targetIdent -> Set of reporterIdents
const reportVotes = new Map();

// ident -> banUntil timestamp
const tempBans = new Map();

function isTemporarilyBanned(ident) {
  const until = tempBans.get(ident) || 0;
  if (Date.now() < until) return true;
  if (until) tempBans.delete(ident); // cleanup expired
  return false;
}

// ===== Pending media (receiverSocketId -> { fromSocketId, dataUrl }) =====
const pendingPhotos = new Map();
const pendingVideos = new Map();

// helper
function emitTo(id, event, payload) {
  if (!id) return;
  io.to(id).emit(event, payload);
}

io.on("connection", (socket) => {
  const ident = makeIdent(socket);
  identBySocket.set(socket.id, ident);

  console.log("CONNECTED", socket.id);

  // ban check
  if (isTemporarilyBanned(ident)) {
    socket.emit("banned");
    socket.disconnect(true);
    return;
  }

  // require agreement every session
  socket.data.agreed = false;
  socket.emit("need_agree");

  socket.on("agree", () => {
    socket.data.agreed = true;
    socket.emit("agreed_ok");
  });

  function requireAgree() {
    if (!isAgreed(socket)) {
      socket.emit("need_agree");
      return false;
    }
    return true;
  }

  // ===== FIND =====
  socket.on("find", () => {
    if (!requireAgree()) return;
    if (partners.has(socket.id)) return;
    if (queue.includes(socket.id)) return;

    // try match
    while (queue.length) {
      const other = queue.shift();
      if (!other) continue;
      if (other === socket.id) continue;
      if (partners.has(other)) continue;

      pair(socket.id, other);
      socket.emit("matched");
      emitTo(other, "matched");
      return;
    }

    queue.push(socket.id);
    socket.emit("searching");
  });

  // ===== STOP =====
  socket.on("stop", () => {
    if (!requireAgree()) return;

    const p = partners.get(socket.id);
    if (p) {
      unpair(socket.id);
      emitTo(p, "partner_left");
    }
    queue = queue.filter((id) => id !== socket.id);

    socket.emit("stopped");
  });

  // ===== MESSAGE =====
  socket.on("message", (msg) => {
    if (!requireAgree()) return;
    if (typeof msg !== "string") return;

    const text = msg.trim();
    if (!text) return;

    const p = partners.get(socket.id);
    if (p) emitTo(p, "message", text);
  });

  // ===== REPORT (ban after 10 unique reports) =====
  socket.on("report", () => {
    if (!requireAgree()) return;

    const p = partners.get(socket.id);
    if (!p) return;

    const targetIdent = identBySocket.get(p);
    const reporterIdent = identBySocket.get(socket.id);
    if (!targetIdent || !reporterIdent) return;

    // add vote
    let voters = reportVotes.get(targetIdent);
    if (!voters) {
      voters = new Set();
      reportVotes.set(targetIdent, voters);
    }
    voters.add(reporterIdent);

    socket.emit("report_received");

    // optional: stop current chat for safety
    if (p) {
      unpair(socket.id);
      emitTo(p, "partner_left");
      socket.emit("partner_left");
    }

    // threshold reached
    if (voters.size >= REPORT_THRESHOLD) {
      reportVotes.delete(targetIdent);

      tempBans.set(targetIdent, Date.now() + BAN_MS);

      // notify + disconnect target if online
      emitTo(p, "reported_and_banned");
      const targetSocket = io.sockets.sockets.get(p);
      if (targetSocket) {
        targetSocket.disconnect(true);
      }
    }
  });

  // ===== PHOTO FLOW =====
  socket.on("photo_offer", (dataUrl) => {
    if (!requireAgree()) return;

    const receiverId = partners.get(socket.id);
    if (!receiverId) return;

    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) return;

    pendingPhotos.set(receiverId, { fromSocketId: socket.id, dataUrl });
    emitTo(receiverId, "photo_request");
    socket.emit("photo_sent");
  });

  socket.on("photo_accept", () => {
    if (!requireAgree()) return;

    const req = pendingPhotos.get(socket.id);
    if (!req) return;

    pendingPhotos.delete(socket.id);

    // deliver to receiver
    socket.emit("photo_deliver", { dataUrl: req.dataUrl });

    // notify sender (optional)
    emitTo(req.fromSocketId, "message", "✅ Photo accepted");
  });

  socket.on("photo_decline", () => {
    if (!requireAgree()) return;

    const req = pendingPhotos.get(socket.id);
    if (!req) return;

    pendingPhotos.delete(socket.id);
    emitTo(req.fromSocketId, "message", "❌ Photo declined");
  });

  // ===== VIDEO FLOW =====
  socket.on("video_offer", (dataUrl) => {
    if (!requireAgree()) return;

    const receiverId = partners.get(socket.id);
    if (!receiverId) return;

    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:video/")) return;

    pendingVideos.set(receiverId, { fromSocketId: socket.id, dataUrl });
    emitTo(receiverId, "video_request");
    socket.emit("video_sent");
  });

  socket.on("video_accept", () => {
    if (!requireAgree()) return;

    const req = pendingVideos.get(socket.id);
    if (!req) return;

    pendingVideos.delete(socket.id);

    socket.emit("video_deliver", { dataUrl: req.dataUrl });
    emitTo(req.fromSocketId, "message", "✅ Video accepted");
  });

  socket.on("video_decline", () => {
    if (!requireAgree()) return;

    const req = pendingVideos.get(socket.id);
    if (!req) return;

    pendingVideos.delete(socket.id);
    emitTo(req.fromSocketId, "message", "❌ Video declined");
  });

  // ===== DISCONNECT CLEANUP =====
  socket.on("disconnect", () => {
    const p = partners.get(socket.id);
    if (p) {
      unpair(socket.id);
      emitTo(p, "partner_left");
    }
    queue = queue.filter((id) => id !== socket.id);

    pendingPhotos.delete(socket.id);
    pendingVideos.delete(socket.id);

    identBySocket.delete(socket.id);

    console.log("DISCONNECTED", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
