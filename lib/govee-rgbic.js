function xorChecksum(bytes) {
  let value = 0;
  for (const byte of bytes) {
    value ^= byte;
  }
  return value;
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function segmentMasksForPart(stripPart, stripCount) {
  if (stripCount <= 1) {
    return { leftMask: 0xff, rightMask: 0x7f };
  }

  if (stripCount === 2) {
    if (stripPart === 0) {
      return { leftMask: 0xff, rightMask: 0x00 };
    }
    return { leftMask: 0x00, rightMask: 0x7f };
  }

  const part = Math.max(0, Math.min(stripCount - 1, Number(stripPart) || 0));
  const leftSegments = 8;
  const rightSegments = 7;
  const total = leftSegments + rightSegments;
  const start = Math.floor((part * total) / stripCount);
  const end = Math.floor(((part + 1) * total) / stripCount);

  let leftMask = 0;
  let rightMask = 0;
  for (let index = start; index < end; index += 1) {
    if (index < leftSegments) {
      leftMask |= 1 << index;
    } else {
      rightMask |= 1 << (index - leftSegments);
    }
  }

  return { leftMask: leftMask & 0xff, rightMask: rightMask & 0x7f };
}

function buildSegmentColorPacket(rgb, leftMask, rightMask) {
  const body = Buffer.from([
    0x33,
    0x05,
    0x0b,
    clampByte(rgb.r),
    clampByte(rgb.g),
    clampByte(rgb.b),
    0x00,
    0x00,
    leftMask & 0xff,
    rightMask & 0x7f,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ]);

  const packet = Buffer.concat([body, Buffer.from([xorChecksum(body)])]);
  return packet.toString("base64");
}

const RGBIC_SKU_PREFIXES = [
  "H619D",
  "H619E",
  "H619A",
  "H619B",
  "H619C",
  "H619Z",
  "H6143",
  "H6144",
  "H6145",
  "H6146",
  "H614A",
  "H614B",
  "H614E",
  "H6163",
  "H6168",
  "H6171",
  "H61E0",
  "H61A0",
  "H61A1",
  "H61A2",
  "H61A3",
];

function skuSupportsStripSplit(sku) {
  const model = String(sku || "").toUpperCase();
  return RGBIC_SKU_PREFIXES.some((prefix) => model.startsWith(prefix));
}

function inferSkuFromRef(ref) {
  const text = String(ref || "");
  const colon = text.indexOf(":");
  return colon === -1 ? text : text.slice(0, colon);
}

module.exports = {
  RGBIC_SKU_PREFIXES,
  skuSupportsStripSplit,
  inferSkuFromRef,
  segmentMasksForPart,
  buildSegmentColorPacket,
};
