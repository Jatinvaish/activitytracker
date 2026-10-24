const zlib = require('zlib');
const { nativeImage } = require('electron');

const COLORS = {
  active:  [0x4c, 0xaf, 0x87],
  idle:    [0xc8, 0x90, 0x50],
  meeting: [0x5a, 0x9f, 0xd4],
  break:   [0x9b, 0x7f, 0xd4],
  away:    [0x86, 0x86, 0x86],
  problem: [0xe0, 0x7a, 0x8b],
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  const body = Buffer.concat([Buffer.from(type), data]);
  len.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// Anti-aliased filled circle as an RGBA PNG; no image files to ship
function circlePng(size, [r, g, b]) {
  const stride = 1 + size * 4;
  const raw = Buffer.alloc(size * stride);
  const c = (size - 1) / 2;
  const radius = size / 2 - size / 16;
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      const alpha = Math.max(0, Math.min(1, radius - Math.hypot(x - c, y - c) + 0.5));
      const o = y * stride + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = Math.round(alpha * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const cache = {};
function trayIcon(kind) {
  if (!cache[kind]) {
    const color = COLORS[kind] || COLORS.problem;
    const img = nativeImage.createFromBuffer(circlePng(16, color), { scaleFactor: 1 });
    img.addRepresentation({ scaleFactor: 2, buffer: circlePng(32, color) });
    cache[kind] = img;
  }
  return cache[kind];
}

module.exports = { trayIcon };
