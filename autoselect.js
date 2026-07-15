"use strict";

/* Automatic crop-selection detection.
   - detectFaceSelection: positions the selection around the face found by
     pico.js so the head lands inside the pink guide squares.
   - detectSignatureSelection: positions the selection snugly around the
     signature ink so it fills most of the crop.
   Both return {x, y, w, h} in crop-canvas pixels, or null when nothing
   trustworthy is found (the caller then keeps its default selection). */
(function () {
  const DET_MAX_FACE = 640;  // detection working-image max side (face)
  const DET_MAX_SIGN = 300;  // detection working-image max side (signature)
  const Q_THRESH = 5.0;      // minimum pico.js detection confidence
  const FACE_W_FRAC = 0.45;  // face width as a fraction of selection width
  const FACE_CY = 0.42;      // face center as a fraction of selection height
  const MIN_SEL = 40;        // matches MIN_SEL_W in app.js

  let classifier = null;

  function getClassifier() {
    if (classifier) return classifier;
    const bin = atob(window.FACEFINDER_B64);
    const bytes = new Int8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    classifier = pico.unpack_cascade(bytes);
    return classifier;
  }

  /* Draw img downscaled so its longest side is <= maxSide and return
     {data, w, h} with the RGBA pixel data. */
  function imageData(img, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    return { data: ctx.getImageData(0, 0, w, h).data, w, h };
  }

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  /* Ratio-locked selection of width w centered at (cx, cy·bias), clamped
     into the crop canvas. */
  function ratioSel(w, cx, topY, ratio, cropW, cropH) {
    w = clamp(w, MIN_SEL, Math.min(cropW, cropH * ratio));
    const h = w / ratio;
    return {
      x: clamp(cx - w / 2, 0, cropW - w),
      y: clamp(topY, 0, cropH - h),
      w,
      h,
    };
  }

  function detectFaceSelection(img, ratio, cropW, cropH) {
    if (!window.pico || !window.FACEFINDER_B64) return null;
    const { data, w, h } = imageData(img, DET_MAX_FACE);

    // grayscale, same weighting as the official pico.js example
    const gray = new Uint8Array(w * h);
    for (let i = 0; i < gray.length; i++) {
      const p = i * 4;
      gray[i] = (2 * data[p] + 7 * data[p + 1] + data[p + 2]) / 10;
    }

    let dets = pico.run_cascade(
      { pixels: gray, nrows: h, ncols: w, ldim: w },
      getClassifier(),
      {
        shiftfactor: 0.1,
        scalefactor: 1.1,
        minsize: Math.max(20, Math.round(0.15 * Math.min(w, h))),
        maxsize: Math.max(w, h),
      }
    );
    dets = pico.cluster_detections(dets, 0.2);

    let best = null;
    for (const d of dets) {
      if (d[3] > Q_THRESH && (!best || d[3] > best[3])) best = d;
    }
    if (!best) return null;

    // map detection (row, col, diameter) to crop-canvas pixels
    const f = cropW / w;
    const faceCx = best[1] * f;
    const faceCy = best[0] * f;
    const faceD = best[2] * f;

    const selW = faceD / FACE_W_FRAC;
    const selH = selW / ratio;
    return ratioSel(selW, faceCx, faceCy - FACE_CY * selH, ratio, cropW, cropH);
  }

  function detectSignatureSelection(img, ratio, cropW, cropH) {
    const { data, w, h } = imageData(img, DET_MAX_SIGN);

    const lum = new Uint8Array(w * h);
    const chroma = new Uint8Array(w * h);
    for (let i = 0; i < lum.length; i++) {
      const p = i * 4;
      const r = data[p], g = data[p + 1], b = data[p + 2];
      lum[i] = (2 * r + 7 * g + b) / 10;
      chroma[i] = Math.max(r, g, b) - Math.min(r, g, b);
    }

    // background = median luminance of a 2px border frame
    const border = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (y < 2 || y >= h - 2 || x < 2 || x >= w - 2) border.push(lum[y * w + x]);
      }
    }
    border.sort((a, b) => a - b);
    const bg = border[border.length >> 1];
    if (bg < 100) return null; // dark background — heuristic unreliable

    // ink mask -> row/column ink-mass histograms
    const rowMass = new Float64Array(h);
    const colMass = new Float64Array(w);
    let total = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (lum[i] < bg - 30 || (chroma[i] > 50 && lum[i] < bg - 15)) {
          rowMass[y]++;
          colMass[x]++;
          total++;
        }
      }
    }
    if (total < 0.001 * w * h) return null; // effectively blank
    if (total > 0.35 * w * h) return null;  // shadowed / noisy photo

    // mass-trimmed bbox: span holding the central 99% of ink mass, so dust
    // specks, ruled lines and edge shadows carry no weight
    const trim = 0.005 * total;
    const span = (mass, n) => {
      let lo = 0, acc = 0;
      while (lo < n && acc + mass[lo] < trim) acc += mass[lo++];
      let hi = n - 1;
      acc = 0;
      while (hi > lo && acc + mass[hi] < trim) acc += mass[hi--];
      return [lo, hi];
    };
    const [y0, y1] = span(rowMass, h);
    const [x0, x1] = span(colMass, w);
    let bw = x1 - x0 + 1;
    let bh = y1 - y0 + 1;
    if (bw > 0.9 * w && bh > 0.9 * h) return null; // ink everywhere — no real bbox

    // pad 4% per side, then the smallest ratio-locked rect containing the bbox
    const padX = Math.max(2, 0.04 * bw);
    const padY = Math.max(2, 0.04 * bh);
    bw += 2 * padX;
    bh += 2 * padY;

    const f = cropW / w;
    const selW = Math.max(bw * f, bh * f * ratio);
    const bcx = (x0 + x1 + 1) / 2 * f;
    const bcy = (y0 + y1 + 1) / 2 * f;
    const selH0 = clamp(selW, MIN_SEL, Math.min(cropW, cropH * ratio)) / ratio;
    return ratioSel(selW, bcx, bcy - selH0 / 2, ratio, cropW, cropH);
  }

  window.AutoSelect = { detectFaceSelection, detectSignatureSelection };
})();
