"use strict";

/* Automatic crop-selection detection.
   - detectFace: pico.js face detection, returns the best face circle in
     crop-canvas pixels plus how many faces were found.
   - faceSelection: positions the selection so the face lands where the
     official Thulasi validator accepts it (see SPEC below).
   - detectSignatureSelection: positions the selection snugly around the
     signature ink so it fills most of the crop.
   Selection functions return {x, y, w, h} in crop-canvas pixels, or null
   when nothing trustworthy is found (the caller keeps its default). */
(function () {
  const DET_MAX_FACE = 640;  // detection working-image max side (face)
  const DET_MAX_SIGN = 300;  // detection working-image max side (signature)
  const Q_THRESH = 5.0;      // minimum pico.js detection confidence
  const MIN_SEL = 40;        // matches MIN_SEL_W in app.js

  /* Official Thulasi photo validator geometry, in pixels of the final
     150x200 file. The server re-runs face detection on the saved crop and
     checks the face box against two squares; the squares below were
     measured from the official overlay (thulasi.psc.kerala.gov.in
     images/mask.gif, 150x200):
       outer square x 20-129, y 25-134 (109x109 — quoted in the official
       "Chin must be above the bottom line of outer square(109 X 109)")
       inner square x 39-109, y 44-115 (~70x71)
     Inferred rules: exactly one face; face box at least inner-square sized
     and inside the outer square (chin above y=134); face centered on the
     squares' center. minFace/maxFace/centerTol are estimates from observed
     rejections (a 66x66 face was rejected as "not as per specification"). */
  const SPEC = {
    outW: 150, outH: 200,
    imgH: 165,                          // photo area above the name band
    outer: { x: 20, y: 25, size: 109 },
    inner: { x: 39, y: 44, size: 70 },
    centerX: 74.5, centerY: 79.5,       // outer-square center
    chinMaxY: 134,                      // outer-square bottom line
    minFace: 70,                        // ~inner square size
    maxFace: 109,                       // ~outer square size
    centerTol: 15,                      // allowed face-center offset
  };
  const K_HAAR = 0.8;        // pico circle diameter -> Haar-style box width

  /* Placement targets (final-file px). The face is aimed smaller than the
     exact window middle so the crop keeps the whole head (hair) and as much
     shoulder as the official geometry allows — PSC reviewers want "face and
     shoulders clearly visible", but the face check pins the face center to
     ~(74.5, 79.5) and >= ~70 px, so at most ~50 of the 165 photo-area px
     can sit below the chin. These targets give chin = 119 (46 px shoulder
     strip) with every official margin still >= 8 px. */
  const TARGET_FACE_W = 78;   // face box width (official window ~70..109)
  const TARGET_FACE_CY = 80;  // face center y (official center 79.5 +-15)
  const MIN_TARGET_FACE_W = 72; // zoom-out floor when fitting the head top
  const MAX_TARGET_FACE_CY = 91; // downshift ceiling when fitting the head

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

  /* Estimate the top of the head (hair) in working-image pixels: sample the
     background from the two top corners, then scan rows downward within the
     face's horizontal span for the first row that clearly differs from the
     background. Returns a row index, or null when the background is not
     plain enough to trust (busy scene, corners disagree). */
  function estimateHeadTop(data, w, h, faceCx, faceTop, faceHalfW) {
    const patch = (x0, y0) => {
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y0 + 6 && y < h; y++) {
        for (let x = x0; x < x0 + 6 && x < w; x++) {
          const p = (y * w + x) * 4;
          r += data[p]; g += data[p + 1]; b += data[p + 2]; n++;
        }
      }
      return [r / n, g / n, b / n];
    };
    const tl = patch(1, 1);
    const tr = patch(Math.max(0, w - 7), 1);
    const diff = (a, b) =>
      Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    if (diff(tl, tr) > 90) return null; // corners disagree — not a plain bg
    const bg = [(tl[0] + tr[0]) / 2, (tl[1] + tr[1]) / 2, (tl[2] + tr[2]) / 2];

    const x0 = Math.max(0, Math.round(faceCx - faceHalfW));
    const x1 = Math.min(w - 1, Math.round(faceCx + faceHalfW));
    const yEnd = Math.min(h - 1, Math.max(0, Math.round(faceTop)));
    for (let y = 0; y <= yEnd; y++) {
      let hits = 0;
      for (let x = x0; x <= x1; x++) {
        const p = (y * w + x) * 4;
        if (Math.abs(data[p] - bg[0]) + Math.abs(data[p + 1] - bg[1]) +
            Math.abs(data[p + 2] - bg[2]) > 90) hits++;
      }
      if (hits > 0.25 * (x1 - x0 + 1)) return y;
    }
    return yEnd; // nothing above the face differs — head starts at face top
  }

  /* Run pico.js on img and return the best face as {cx, cy, d, count,
     headTop} in crop-canvas pixels (d = circle diameter, count = confident
     detections, headTop = estimated top of hair or null), or null when no
     confident face is found. */
  function detectFace(img, cropW) {
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
    let count = 0;
    for (const d of dets) {
      if (d[3] > Q_THRESH) {
        count++;
        if (!best || d[3] > best[3]) best = d;
      }
    }
    if (!best) return null;

    let headTop = null;
    try {
      headTop = estimateHeadTop(
        data, w, h, best[1], best[0] - best[2] / 2, best[2] / 2);
    } catch (_) { /* head-top estimate is optional */ }

    // map detection (row, col, diameter) to crop-canvas pixels
    const f = cropW / w;
    return {
      cx: best[1] * f,
      cy: best[0] * f,
      d: best[2] * f,
      count,
      headTop: headTop === null ? null : headTop * f,
    };
  }

  /* Selection that puts the detected face at the official sweet spot:
     Haar-equivalent face box TARGET_FACE_W px wide, horizontally on the
     outer-square center, vertically at TARGET_FACE_CY. When the estimated
     head top would be clipped, zoom out and shift the face down — but only
     within the slack the official rules allow (face stays >= MIN_TARGET_
     FACE_W px, center <= MAX_TARGET_FACE_CY). */
  function faceSelection(face, ratio, cropW, cropH) {
    const faceW = K_HAAR * face.d;
    const maxFit = Math.min(cropW, cropH * ratio);
    let selW = faceW * SPEC.outW / TARGET_FACE_W;
    let faceCyOut = TARGET_FACE_CY;

    if (face.headTop !== null && face.headTop !== undefined) {
      // canvas px between the face center and the head top (plus padding)
      const gap = face.cy - face.headTop + 0.05 * face.d;
      const h0 = clamp(selW, MIN_SEL, maxFit) / ratio;
      if (h0 * (faceCyOut / SPEC.imgH) < gap) {
        // 1) zoom out at the same face height, down to the face-size floor
        const wNeeded = (gap * SPEC.imgH / faceCyOut) * ratio;
        const wFloor = faceW * SPEC.outW / MIN_TARGET_FACE_W;
        selW = Math.min(wNeeded, wFloor);
        // 2) if still short, let the face sit lower in the frame
        const h1 = clamp(selW, MIN_SEL, maxFit) / ratio;
        faceCyOut = clamp(gap / h1 * SPEC.imgH, TARGET_FACE_CY, MAX_TARGET_FACE_CY);
      }
    }

    // ratioSel centers horizontally on its cx argument; shift so the face
    // sits at SPEC.centerX rather than the exact selection midpoint
    const w = clamp(selW, MIN_SEL, maxFit);
    const h = w / ratio;
    const cx = face.cx - w * (SPEC.centerX / SPEC.outW - 0.5);
    const topY = face.cy - h * (faceCyOut / SPEC.imgH);
    return ratioSel(selW, cx, topY, ratio, cropW, cropH);
  }

  function detectFaceSelection(img, ratio, cropW, cropH) {
    const face = detectFace(img, cropW);
    return face ? faceSelection(face, ratio, cropW, cropH) : null;
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

  window.AutoSelect = {
    detectFace,
    faceSelection,
    detectFaceSelection,
    detectSignatureSelection,
    SPEC,
    K_HAAR,
  };
})();
