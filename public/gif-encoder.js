/* Minimal, dependency-free animated GIF89a encoder.
   No build step in this app (plain <script> tags), so this is a from-scratch
   implementation of the public GIF89a spec: median-cut color quantization
   for a single shared palette across all frames (avoids per-frame flicker),
   then standard variable-width LZW compression per frame. */
window.MetisGifEncoder = (() => {
  "use strict";

  // --- Median-cut color quantizer: reduces the sampled RGB pixels down to
  // at most `maxColors` representative colors, used as one shared palette. ---
  function quantize(pixelSamples, maxColors) {
    // Each box holds a slice of pixelSamples (flat [r,g,b,r,g,b,...]) plus
    // its axis-aligned bounding range, used to pick the widest axis to split.
    function boxFromIndices(indices) {
      let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
      for (const i of indices) {
        const r = pixelSamples[i], g = pixelSamples[i + 1], b = pixelSamples[i + 2];
        if (r < rMin) rMin = r; if (r > rMax) rMax = r;
        if (g < gMin) gMin = g; if (g > gMax) gMax = g;
        if (b < bMin) bMin = b; if (b > bMax) bMax = b;
      }
      return { indices, rMin, rMax, gMin, gMax, bMin, bMax };
    }
    function widestAxis(box) {
      const rr = box.rMax - box.rMin, gr = box.gMax - box.gMin, br = box.bMax - box.bMin;
      if (rr >= gr && rr >= br) return 0;
      if (gr >= br) return 1;
      return 2;
    }
    const allIndices = [];
    for (let i = 0; i < pixelSamples.length; i += 3) allIndices.push(i);
    let boxes = [boxFromIndices(allIndices)];
    while (boxes.length < maxColors) {
      boxes.sort((a, b) => (b.rMax - b.rMin + b.gMax - b.gMin + b.bMax - b.bMin) - (a.rMax - a.rMin + a.gMax - a.gMin + a.bMax - a.bMin));
      const box = boxes.shift();
      if (!box || box.indices.length < 2) { if (box) boxes.push(box); break; }
      const axis = widestAxis(box);
      const sorted = box.indices.slice().sort((a, b) => pixelSamples[a + axis] - pixelSamples[b + axis]);
      const mid = sorted.length >> 1;
      boxes.push(boxFromIndices(sorted.slice(0, mid)));
      boxes.push(boxFromIndices(sorted.slice(mid)));
    }
    const palette = boxes.map((box) => {
      let r = 0, g = 0, b = 0;
      for (const i of box.indices) { r += pixelSamples[i]; g += pixelSamples[i + 1]; b += pixelSamples[i + 2]; }
      const n = box.indices.length || 1;
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    });
    while (palette.length < 2) palette.push([0, 0, 0]);
    return palette;
  }

  // Brute-force O(paletteSize) per pixel, with no cache, was the actual
  // cause of the reported crash/hang: a real captured frame is hundreds of
  // thousands of pixels, and photographic imagery revisits the same handful
  // of colors constantly -- a memoized lookup turns most pixels into an O(1)
  // hit instead of re-scanning the whole palette every time.
  function makeNearestPaletteLookup(palette) {
    const cache = new Map();
    return (r, g, b) => {
      const key = (r << 16) | (g << 8) | b;
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      let best = 0, bestDist = Infinity;
      for (let i = 0; i < palette.length; i++) {
        const [pr, pg, pb] = palette[i];
        const dist = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
        if (dist < bestDist) { bestDist = dist; best = i; }
      }
      cache.set(key, best);
      return best;
    };
  }

  // --- Bit-packed byte writer for GIF's variable-width LZW output. ---
  function BitWriter() {
    const bytes = [];
    let bitBuffer = 0, bitCount = 0;
    return {
      writeCode(code, bits) {
        bitBuffer |= code << bitCount;
        bitCount += bits;
        while (bitCount >= 8) { bytes.push(bitBuffer & 0xff); bitBuffer >>= 8; bitCount -= 8; }
      },
      flush() { if (bitCount > 0) { bytes.push(bitBuffer & 0xff); bitBuffer = 0; bitCount = 0; } },
      bytes: () => bytes,
    };
  }

  // Standard GIF LZW encoder: dictionary of {prefixCode,suffixByte} -> code,
  // resetting when it hits the 4096-entry cap (or on explicit Clear Code).
  function lzwEncode(indexStream, minCodeSize) {
    const clearCode = 1 << minCodeSize;
    const endCode = clearCode + 1;
    let codeSize = minCodeSize + 1;
    let nextCode = endCode + 1;
    let dict = new Map();
    const writer = BitWriter();
    const resetDict = () => {
      dict = new Map();
      for (let i = 0; i < clearCode; i++) dict.set(String(i), i);
      nextCode = endCode + 1;
      codeSize = minCodeSize + 1;
    };
    resetDict();
    writer.writeCode(clearCode, codeSize);
    let prefix = String(indexStream[0]);
    for (let i = 1; i < indexStream.length; i++) {
      const k = indexStream[i];
      const combined = `${prefix},${k}`;
      if (dict.has(combined)) {
        prefix = combined;
        continue;
      }
      writer.writeCode(dict.get(prefix), codeSize);
      if (nextCode < 4096) {
        dict.set(combined, nextCode);
        nextCode += 1;
        if (nextCode > (1 << codeSize) && codeSize < 12) codeSize += 1;
      } else {
        writer.writeCode(clearCode, codeSize);
        resetDict();
      }
      prefix = String(k);
    }
    writer.writeCode(dict.get(prefix), codeSize);
    writer.writeCode(endCode, codeSize);
    writer.flush();
    return writer.bytes();
  }

  function pushU16(arr, value) { arr.push(value & 0xff, (value >> 8) & 0xff); }

  // Formats already-LZW-compressed bytes into GIF's length-prefixed
  // sub-blocks (max 255 bytes each) as one preallocated Uint8Array, instead
  // of spreading every byte through a single shared array -- for a
  // multi-hundred-KB frame that spread pattern was itself a real cost.
  function subBlockify(data) {
    const chunkCount = Math.ceil(data.length / 255);
    const out = new Uint8Array(data.length + chunkCount + 1);
    let o = 0;
    for (let i = 0; i < data.length; i += 255) {
      const len = Math.min(255, data.length - i);
      out[o++] = len;
      for (let j = 0; j < len; j++) out[o++] = data[i + j];
    }
    out[o] = 0; // block terminator
    return out;
  }

  // Large frames (a real desktop viewport capture) make quantizing/encoding
  // at full resolution slow and memory-heavy for no visual benefit in a
  // shareable GIF -- cap the longest side before doing any of that work.
  function downscale(imageData, maxDim) {
    const { width, height } = imageData;
    if (Math.max(width, height) <= maxDim) return imageData;
    const scale = maxDim / Math.max(width, height);
    const dstW = Math.max(1, Math.round(width * scale));
    const dstH = Math.max(1, Math.round(height * scale));
    const src = document.createElement("canvas");
    src.width = width; src.height = height;
    src.getContext("2d").putImageData(imageData, 0, 0);
    const dst = document.createElement("canvas");
    dst.width = dstW; dst.height = dstH;
    const dctx = dst.getContext("2d");
    dctx.drawImage(src, 0, 0, dstW, dstH);
    return dctx.getImageData(0, 0, dstW, dstH);
  }

  // frames: [{ imageData: ImageData, delayMs: number }], all the same size.
  // Returns a Blob (image/gif). loop: 0 = infinite.
  function encode(frames, { width, height, loop = 0, maxColors = 128, maxDim = 640 } = {}) {
    const scaledFrames = frames.map((frame) => ({ ...frame, imageData: downscale(frame.imageData, maxDim) }));
    width = scaledFrames[0].imageData.width;
    height = scaledFrames[0].imageData.height;

    // Sample pixels across all frames (not every pixel -- that's plenty for
    // a representative shared palette without a slow full scan).
    const samples = [];
    for (const frame of scaledFrames) {
      const data = frame.imageData.data;
      const step = Math.max(4, Math.floor(data.length / 4 / 4000) * 4);
      for (let i = 0; i < data.length; i += step) {
        samples.push(data[i], data[i + 1], data[i + 2]);
      }
    }
    const palette = quantize(samples, maxColors);
    let paletteSize = 2;
    while (paletteSize < palette.length) paletteSize *= 2;
    const minCodeSize = Math.max(2, Math.ceil(Math.log2(paletteSize)));
    const lookup = makeNearestPaletteLookup(palette);

    const parts = [];
    const header = [];
    header.push(..."GIF89a".split("").map((c) => c.charCodeAt(0)));
    pushU16(header, width);
    pushU16(header, height);
    const gctSizeBits = Math.ceil(Math.log2(paletteSize)) - 1;
    header.push(0x80 | (7 << 4) | gctSizeBits); // global color table present, 8-bit color res
    header.push(0); // background color index
    header.push(0); // pixel aspect ratio
    for (let i = 0; i < paletteSize; i++) {
      const [r, g, b] = palette[i] || [0, 0, 0];
      header.push(r, g, b);
    }
    // NETSCAPE2.0 application extension for looping
    header.push(0x21, 0xff, 0x0b);
    header.push(..."NETSCAPE2.0".split("").map((c) => c.charCodeAt(0)));
    header.push(0x03, 0x01);
    pushU16(header, loop);
    header.push(0x00);
    parts.push(new Uint8Array(header));

    for (const frame of scaledFrames) {
      const data = frame.imageData.data;
      const indices = new Uint8Array(width * height);
      for (let p = 0, i = 0; p < data.length; p += 4, i++) {
        indices[i] = lookup(data[p], data[p + 1], data[p + 2]);
      }
      // Graphic Control Extension + Image Descriptor (small, fixed-size)
      const frameHead = [0x21, 0xf9, 0x04, 0x04];
      pushU16(frameHead, Math.round((frame.delayMs || 200) / 10));
      frameHead.push(0x00, 0x00); // transparent color index (unused), block terminator
      frameHead.push(0x2c);
      pushU16(frameHead, 0); pushU16(frameHead, 0);
      pushU16(frameHead, width); pushU16(frameHead, height);
      frameHead.push(0x00); // no local color table
      frameHead.push(minCodeSize);
      parts.push(new Uint8Array(frameHead));
      const lzwBytes = lzwEncode(indices, minCodeSize);
      parts.push(subBlockify(lzwBytes));
    }
    parts.push(new Uint8Array([0x3b]));
    return new Blob(parts, { type: "image/gif" });
  }

  return { encode };
})();
