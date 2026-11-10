// Локальный запуск того же ретранслятора без Cloudflare: node dev-server.js [порт]
// Нужен для проверки на своём компьютере и как запасной вариант в домашней сети (адрес вида ws://192.168.x.x:8787).
import http from 'node:http';
import crypto from 'node:crypto';
import { Room, CODE_RE } from './relay-core.js';

const PORT = Number(process.env.PORT) || Number(process.argv[2]) || 8787;
const rooms = new Map();

function frame(op, payload) {
  const b = Buffer.from(payload);
  const h = b.length < 126 ? Buffer.from([0x80 | op, b.length]) : Buffer.from([0x80 | op, 126, b.length >> 8, b.length & 255]);
  return Buffer.concat([h, b]);
}

function makeSock(socket) {
  return {
    socket,
    send(text) { if (!socket.destroyed) socket.write(frame(1, text)); },
    close(code = 1000, reason = '') {
      if (socket.destroyed) return;
      const r = Buffer.from(reason);
      socket.write(frame(8, Buffer.concat([Buffer.from([code >> 8, code & 255]), r])));
      socket.end();
    },
  };
}

const server = http.createServer((req, res) => { res.end('petushinye-boi relay (dev): ok'); });
server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  const m = /^\/room\/([A-Za-z0-9]+)$/.exec(url.pathname);
  const key = req.headers['sec-websocket-key'];
  if (!m || !key || !CODE_RE.test(m[1].toUpperCase())) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const code = m[1].toUpperCase();
  if (!rooms.has(code)) rooms.set(code, new Room());
  const room = rooms.get(code), sock = makeSock(socket);
  room.join(url.searchParams.get('role'), sock);
  let buf = Buffer.alloc(0), closed = false;
  const done = () => { if (closed) return; closed = true; room.leave(sock); if (!room.peers.length) rooms.delete(code); };
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 15, masked = !!(buf[1] & 128);
      let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { socket.destroy(); return; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      const mask = masked ? buf.subarray(off, off + 4) : null, p = Buffer.from(buf.subarray(off + (masked ? 4 : 0), need));
      if (mask) for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
      buf = buf.subarray(need);
      if (op === 1) room.message(sock, p.toString('utf8'));
      else if (op === 8) { sock.close(1000); done(); return; }
      else if (op === 9) socket.write(frame(10, p));
    }
  });
  socket.on('close', done);
  socket.on('error', done);
});
server.listen(PORT, () => console.log('Ретранслятор запущен: ws://localhost:' + PORT + '  (для телефонов в одной Wi-Fi: ws://<IP компьютера>:' + PORT + ')'));
