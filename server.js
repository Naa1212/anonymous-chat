const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 30 * 1024 * 1024, // 30MB buffer (safe for 20–25MB uploads)
});

app.use(express.static("public"));

// LIVE CHAT STATE
let queue = [];
let partners = new Map();
let identBySocket = new Map();

// Pending media (RAM only)
let pendingPhotos = new Map(); // receiverSocketId -> { fromSocketId, dataUrl }
let pendingVideos = new Map(); // receiverSocketId -> { fromSocketId, dataUrl }

// Bans (MVP memory only; if you want persistent bans, tell me and I’ll add data.json back)
let bannedIdents = new Set();

function pair(a, b) {
  partners.set(a, b);
  partners.set(b, a);
}

function unpair(a) {
  const b = partners.get(a);
  if (b) partners.delete(b);
  partners.delete(a);
}

function getIP(socket) {
  return socket.handshake.address || "unknown";
}

function makeIdent(socket) {
  const ip = getIP(socket);
  const ua = (socket.handshake.headers["user-agent"] || "").slice(0, 160);
  return `${ip}::${ua}`;
}

function isAgreed(socket) {
  return socket.data.agreed === true;
}

io.on("connection", (socket) => {
  const ident = makeIdent(socket);
  identBySocket.set(socket.id, ident);

  console.log("CONNECTED", socket.id);

  if (bannedIdents.has(ident)) {
    socket.emit("banned");
    socket.disconnect(true);
    return;
  }

  // Always require agreement each session
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

  // FIND
  socket.on("find", () => {
    if (!requireAgree()) return;
    if (partners.has(socket.id) || queue.includes(socket.id)) return;

    while (queue.length) {
      const other = queue.shift();
      if (other !== socket.id && !partners.has(other)) {
        pair(socket.id, other);
        socket.emit("matched");
        io.to(other).emit("matched");
        return;
      }
    }
    queue.push(socket.id);
    socket.emit("searching");
  });

  // NEXT
  socket.on("next", () => {
    if (!requireAgree()) return;

    const p = partners.get(socket.id);
    if (p) {
      unpair(socket.id);
      io.to(p).emit("partner_left");
    }
    queue = queue.filter((id) => id !== socket.id);

    socket.emit("searching");
    socket.emit("find");
  });

  // STOP
  socket.on("stop", () => {
    if (!requireAgree()) return;

    const p = partners.get(socket.id);
    if (p) {
      unpair(socket.id);
      io.to(p).emit("partner_left");
    }
    queue = queue.filter((id) => id !== socket.id);

    socket.emit("stopped");
  });

  // MESSAGE
  socket.on("message", (msg) => {
    if (!requireAgree()) return;
    if (typeof msg !== "string") return;

    const text = msg.trim();
    if (!text) return;

    const p = partners.get(socket.id);
    if (p) io.to(p).emit("message", text);
  });

  // REPORT -> ban partner (memory)
socket.on("report", () => {
  if (!requireAgree()) return;

  const p = partners.get(socket.id);
  if (!p) return;

  const partnerIdent = identBySocket.get(p);
  if (!partnerIdent) return;

  const count = (reportCounts.get(partnerIdent) || 0) + 1;
  reportCounts.set(partnerIdent, count);

  if (count >= 10) {
    const until = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
    tempBans.set(partnerIdent, until);
    reportCounts.delete(partnerIdent);

    unpair(socket.id);
    io.to(p).emit("reported_and_banned");
    socket.emit("report_received");

    try { io.sockets.sockets.get(p)?.disconnect(true); } catch {}
  }
});

// PHOTO
const pendingPhotos = new Map(); // key: receiverSocketId -> { fromSocketId, dataUrl }

socket.on("photo_offer", (dataUrl) => {
  if (!requireAgree()) return;

  const p = partners.get(socket.id);
  if (!p) return;

  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) return;

  pendingPhotos.set(p, { fromSocketId: socket.id, dataUrl });
  io.to(p).emit("photo_request");
  socket.emit("photo_sent");
});

socket.on("photo_accept", () => {
  if (!requireAgree()) return;

  const req = pendingPhotos.get(socket.id);
  if (!req) return;

  pendingPhotos.delete(socket.id);
  socket.emit("photo_deliver", req.dataUrl);
});

socket.on("photo_decline", () => {
  if (!requireAgree()) return;

  const req = pendingPhotos.get(socket.id);
  if (!req) return;

  pendingPhotos.delete(socket.id);
  socket.emit("stopped");
});

// VIDEO
const pendingVideos = new Map(); // key: receiverSocketId -> { fromSocketId, dataUrl }

socket.on("video_offer", (dataUrl) => {
  if (!requireAgree()) return;

  const p = partners.get(socket.id);
  if (!p) return;

  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:video/")) return;

  pendingVideos.set(p, { fromSocketId: socket.id, dataUrl });
  io.to(p).emit("video_request");
  socket.emit("video_sent");
});

socket.on("video_accept", () => {
  if (!requireAgree()) return;

  const req = pendingVideos.get(socket.id);
  if (!req) return;

  pendingVideos.delete(socket.id);
  socket.emit("video_deliver", req.dataUrl);
});

socket.on("video_decline", () => {
  if (!requireAgree()) return;

  const req = pendingVideos.get(socket.id);
  if (!req) return;

  pendingVideos.delete(socket.id);
  socket.emit("stopped");
});

  // VIDEO
  socket.on("video_offer", (dataUrl) => {
    if (!requireAgree()) return;

    const p = partners.get(socket.id);
    if (!p) return;

    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:video/")) return;

    pendingVideos.set(p, { fromSocketId: socket.id, dataUrl });
    io.to(p).emit("video_request");
    socket.emit("video_sent");
  });

  socket.on("video_accept", () => {
    if (!requireAgree()) return;

    const req = pendingVideos.get(socket.id);
    if (!req) return;

    io.to(socket.id).emit("video_receive", req.dataUrl);
    pendingVideos.delete(socket.id);
  });

  socket.on("video_decline", () => {
    if (!requireAgree()) return;
    pendingVideos.delete(socket.id);
  });

  socket.on("disconnect", () => {
    const p = partners.get(socket.id);
    if (p) {
      unpair(socket.id);
      io.to(p).emit("partner_left");
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
