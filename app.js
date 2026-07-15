"use strict";

const BAND_HEIGHT = 35;       // white strip for name + date on the photo
const DISPLAY_MAX_W = 360;    // crop canvas display box
const DISPLAY_MAX_H = 420;
const MIN_SEL_W = 40;         // smallest allowed selection width (canvas px)
const HIT_CSS_TOUCH = 24;     // corner hit radius for touch/pen (CSS px)
const HIT_CSS_MOUSE = 12;     // corner hit radius for mouse (CSS px)

/* Stamp 300 DPI into the JFIF APP0 header of a canvas-produced JPEG.
   Metadata only — pixel data and byte length are unchanged. */
async function withDpi300(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const isJfif =
    buf[2] === 0xff && buf[3] === 0xe0 &&
    buf[6] === 0x4a && buf[7] === 0x46 && buf[8] === 0x49 &&
    buf[9] === 0x46 && buf[10] === 0x00;
  if (!isJfif) return blob;
  buf[13] = 1;                            // density units: dots per inch
  buf[14] = 300 >> 8; buf[15] = 300 & 0xff; // X density
  buf[16] = 300 >> 8; buf[17] = 300 & 0xff; // Y density
  return new Blob([buf], { type: "image/jpeg" });
}

/* Convert a canvas to a 300 DPI JPEG blob no larger than maxBytes at the
   highest quality that fits. At 150 px wide, quality 1.0 almost always fits,
   so most photos get no visible compression at all. */
async function toJpegUnder(canvas, maxBytes) {
  let blob = null;
  for (let q = 1.0; q >= 0.35; q -= 0.02) {
    blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", q));
    if (blob && blob.size <= maxBytes) return withDpi300(blob);
  }
  return blob ? withDpi300(blob) : blob;
}

/* Draw a crop of img scaled down to dw x dh, halving in steps so the
   result stays sharp instead of aliasing on big source photos. */
function drawScaled(ctx, img, sx, sy, sw, sh, dx, dy, dw, dh) {
  let src = img, cw = sw, ch = sh;
  let csx = sx, csy = sy, csw = sw, csh = sh;
  while (cw / dw > 2 && ch / dh > 2) {
    cw = Math.max(dw, Math.round(cw / 2));
    ch = Math.max(dh, Math.round(ch / 2));
    const t = document.createElement("canvas");
    t.width = cw;
    t.height = ch;
    const tctx = t.getContext("2d");
    tctx.imageSmoothingQuality = "high";
    tctx.drawImage(src, csx, csy, csw, csh, 0, 0, cw, ch);
    src = t;
    csx = 0; csy = 0; csw = cw; csh = ch;
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, csx, csy, csw, csh, dx, dy, dw, dh);
}

function formatDate(isoDate) {
  const [y, m, d] = isoDate.split("-");
  return `${d}-${m}-${y}`;
}

class ResizeTool {
  /* opts: prefix, targetW, targetH, imageAreaH, hasBand, maxBytes, limitKB,
     showFaceGuides */
  constructor(opts) {
    Object.assign(this, opts);
    this.ratio = this.targetW / this.imageAreaH; // selection w/h

    this.drop = document.getElementById(`${this.prefix}-drop`);
    this.file = document.getElementById(`${this.prefix}-file`);
    this.editor = document.getElementById(`${this.prefix}-editor`);
    this.canvas = document.getElementById(`${this.prefix}-canvas`);
    this.changeBtn = document.getElementById(`${this.prefix}-change`);
    this.preview = document.getElementById(`${this.prefix}-preview`);
    this.sizeInfo = document.getElementById(`${this.prefix}-size`);
    this.download = document.getElementById(`${this.prefix}-download`);
    this.imgWarn = document.getElementById(`${this.prefix}-imgwarn`);

    this.ctx = this.canvas.getContext("2d");
    this.img = null;
    this.sel = { x: 0, y: 0, w: 0, h: 0 }; // selection in canvas px
    this.dispScale = 1;                     // canvas px per source-image px
    this.pxPerCss = 1;                      // canvas px per displayed CSS px
    this.blobUrl = null;
    this.updateTimer = null;
    this.renderSeq = 0;
    this.imgSeq = 0;       // invalidates pending auto-select on new image
    this.selDirty = false; // user touched the selection; auto-select must not stomp it

    this.bindUpload();
    this.bindCropper();
  }

  /* ---------- upload ---------- */
  bindUpload() {
    this.drop.addEventListener("click", () => this.file.click());
    this.drop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") this.file.click();
    });
    this.drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      this.drop.classList.add("dragover");
    });
    this.drop.addEventListener("dragleave", () => this.drop.classList.remove("dragover"));
    this.drop.addEventListener("drop", (e) => {
      e.preventDefault();
      this.drop.classList.remove("dragover");
      if (e.dataTransfer.files.length) this.loadFile(e.dataTransfer.files[0]);
    });
    this.file.addEventListener("change", () => {
      if (this.file.files.length) this.loadFile(this.file.files[0]);
    });
    this.changeBtn.addEventListener("click", () => {
      this.editor.hidden = true;
      this.drop.hidden = false;
      this.file.value = "";
    });
  }

  loadFile(file) {
    if (!file.type.startsWith("image/")) {
      alert("Please choose an image file (JPG or PNG).");
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      this.setImage(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      alert("Could not read that image. Please try a different file.");
    };
    img.src = url;
  }

  setImage(img) {
    this.img = img;
    this.drop.hidden = true;
    this.editor.hidden = false;

    // fit the whole image into the display box
    this.dispScale = Math.min(DISPLAY_MAX_W / img.width, DISPLAY_MAX_H / img.height);
    this.canvas.width = Math.max(1, Math.round(img.width * this.dispScale));
    this.canvas.height = Math.max(1, Math.round(img.height * this.dispScale));

    // default: centered selection at 80% of the largest ratio-locked fit —
    // this is also the silent fallback when auto-detection finds nothing
    const cw = this.canvas.width, ch = this.canvas.height;
    let w = 0.8 * Math.min(cw, ch * this.ratio);
    let h = w / this.ratio;
    this.sel = { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
    this.refreshScale();

    if (img.width < this.targetW || img.height < this.imageAreaH) {
      this.imgWarn.textContent =
        `This image is only ${img.width}×${img.height} px — smaller than the required output. ` +
        `It will be upscaled and may look blurry. A larger photo is recommended.`;
      this.imgWarn.hidden = false;
    } else {
      this.imgWarn.hidden = true;
    }

    this.draw();
    this.scheduleUpdate();
    this.selDirty = false;
    this.runAutoSelect();
  }

  refreshScale() {
    const r = this.canvas.getBoundingClientRect();
    if (r.width > 0) this.pxPerCss = this.canvas.width / r.width;
  }

  /* Reposition the selection via face/signature detection. Runs after the
     default selection has painted; keeps it silently on failure. */
  runAutoSelect() {
    if (!this.autoSelect || !window.AutoSelect) return;
    const seq = ++this.imgSeq;
    setTimeout(() => {
      if (seq !== this.imgSeq || this.selDirty) return;
      let sel = null;
      try {
        sel = this.autoSelect === "face"
          ? AutoSelect.detectFaceSelection(this.img, this.ratio, this.canvas.width, this.canvas.height)
          : AutoSelect.detectSignatureSelection(this.img, this.ratio, this.canvas.width, this.canvas.height);
      } catch (_) { /* fall back to the default selection */ }
      if (seq !== this.imgSeq || this.selDirty || !sel) return;
      this.sel = sel;
      this.draw();
      this.scheduleUpdate();
    }, 30);
  }

  /* ---------- selection cropper ---------- */
  corners() {
    const { x, y, w, h } = this.sel;
    return {
      tl: { x, y },
      tr: { x: x + w, y },
      bl: { x, y: y + h },
      br: { x: x + w, y: y + h },
    };
  }

  hitTest(p, pointerType) {
    // hit radius is defined in CSS px (what the finger actually covers) and
    // converted to canvas px, so targets stay big on phones where the canvas
    // is displayed smaller than its pixel size
    const cssR = pointerType === "mouse" ? HIT_CSS_MOUSE : HIT_CSS_TOUCH;
    const radius = cssR * this.pxPerCss;
    const c = this.corners();
    // nearest corner within the radius wins — with a touch-sized radius on a
    // small selection several corners can overlap one tap
    let best = null, bestD = Infinity;
    for (const key of ["tl", "tr", "bl", "br"]) {
      const d = Math.hypot(p.x - c[key].x, p.y - c[key].y);
      if (d <= radius && d < bestD) { best = key; bestD = d; }
    }
    if (best) return best;
    const s = this.sel;
    if (p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h) return "move";
    return "draw";
  }

  /* Ratio-locked rectangle anchored at (ax, ay) stretched toward (px, py),
     clamped to the canvas. */
  ratioRect(ax, ay, px, py) {
    const R = this.ratio;
    const sx = px < ax ? -1 : 1;
    const sy = py < ay ? -1 : 1;
    let w = Math.max(Math.abs(px - ax), Math.abs(py - ay) * R, MIN_SEL_W);
    const availW = sx > 0 ? this.canvas.width - ax : ax;
    const availH = sy > 0 ? this.canvas.height - ay : ay;
    w = Math.min(w, availW, availH * R);
    const h = w / R;
    return { x: sx > 0 ? ax : ax - w, y: sy > 0 ? ay : ay - h, w, h };
  }

  bindCropper() {
    let mode = null;          // "move" | "tl"|"tr"|"bl"|"br" | "draw"
    let start = null;         // pointer position at pointerdown
    let startSel = null;      // selection at pointerdown
    let anchor = null;        // fixed corner for resize/draw

    const toCanvas = (e) => {
      const r = this.canvas.getBoundingClientRect();
      if (r.width > 0) this.pxPerCss = this.canvas.width / r.width;
      return {
        x: (e.clientX - r.left) * (this.canvas.width / r.width),
        y: (e.clientY - r.top) * (this.canvas.height / r.height),
      };
    };

    const cursorFor = (hit) => {
      if (hit === "move") return "move";
      if (hit === "tl" || hit === "br") return "nwse-resize";
      if (hit === "tr" || hit === "bl") return "nesw-resize";
      return "crosshair";
    };

    this.canvas.addEventListener("pointerdown", (e) => {
      if (!this.img) return;
      e.preventDefault();
      this.selDirty = true; // a user drag always beats a pending auto-select
      const p = toCanvas(e);
      const hit = this.hitTest(p, e.pointerType);
      mode = hit;
      start = p;
      startSel = { ...this.sel };
      if (hit === "tl" || hit === "tr" || hit === "bl" || hit === "br") {
        const c = this.corners();
        const opposite = { tl: "br", tr: "bl", bl: "tr", br: "tl" }[hit];
        anchor = c[opposite];
      } else if (hit === "draw") {
        anchor = p;
      }
      try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointers have no capture */ }
    });

    this.canvas.addEventListener("pointermove", (e) => {
      if (!this.img) return;
      const p = toCanvas(e);
      if (!mode) {
        this.canvas.style.cursor = cursorFor(this.hitTest(p, e.pointerType));
        return;
      }
      if (mode === "move") {
        this.sel.x = Math.min(Math.max(startSel.x + (p.x - start.x), 0), this.canvas.width - this.sel.w);
        this.sel.y = Math.min(Math.max(startSel.y + (p.y - start.y), 0), this.canvas.height - this.sel.h);
      } else {
        this.sel = this.ratioRect(anchor.x, anchor.y, p.x, p.y);
      }
      this.draw();
      this.scheduleUpdate();
    });

    const endDrag = () => { mode = null; };
    this.canvas.addEventListener("pointerup", endDrag);
    this.canvas.addEventListener("pointercancel", endDrag);
  }

  draw() {
    const { ctx, canvas, img, sel } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // dim everything outside the selection
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.fillRect(0, 0, canvas.width, sel.y);
    ctx.fillRect(0, sel.y + sel.h, canvas.width, canvas.height - sel.y - sel.h);
    ctx.fillRect(0, sel.y, sel.x, sel.h);
    ctx.fillRect(sel.x + sel.w, sel.y, canvas.width - sel.x - sel.w, sel.h);

    // marching-ants style border: dark base + white dashes
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
    ctx.setLineDash([]);
    ctx.strokeRect(sel.x + 0.5, sel.y + 0.5, sel.w - 1, sel.h - 1);
    ctx.strokeStyle = "#fff";
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(sel.x + 0.5, sel.y + 0.5, sel.w - 1, sel.h - 1);
    ctx.setLineDash([]);

    // corner handles — scale with the display so they stay ~9 CSS px on
    // phones where the canvas is shown smaller than its pixel size
    const hs = Math.max(8, Math.round(9 * this.pxPerCss));
    const c = this.corners();
    for (const key of ["tl", "tr", "bl", "br"]) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(c[key].x - hs / 2, c[key].y - hs / 2, hs, hs);
      ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
      ctx.strokeRect(c[key].x - hs / 2 + 0.5, c[key].y - hs / 2 + 0.5, hs - 1, hs - 1);
    }

    // head-position guides (official sample): two pink squares, upper-center
    // of the selection. Drawn on the crop canvas only, never exported.
    if (this.showFaceGuides) {
      ctx.strokeStyle = "#f9a8d4";
      ctx.lineWidth = 1;
      const outer = sel.w * 0.55;
      const inner = sel.w * 0.36;
      ctx.strokeRect(sel.x + (sel.w - outer) / 2, sel.y + sel.h * 0.20, outer, outer);
      ctx.strokeRect(sel.x + (sel.w - inner) / 2, sel.y + sel.h * 0.28, inner, inner);
    }
  }

  /* ---------- output ---------- */
  compose() {
    const out = document.createElement("canvas");
    out.width = this.targetW;
    out.height = this.targetH;
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, out.width, out.height);

    // map the selection back to source-image pixels
    const sx = this.sel.x / this.dispScale;
    const sy = this.sel.y / this.dispScale;
    const sw = this.sel.w / this.dispScale;
    const sh = this.sel.h / this.dispScale;
    drawScaled(ctx, this.img, sx, sy, sw, sh, 0, 0, this.targetW, this.imageAreaH);

    if (this.hasBand) this.drawBand(ctx);
    return out;
  }

  drawBand(ctx) {
    const top = this.imageAreaH;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, top, this.targetW, BAND_HEIGHT);
    ctx.fillStyle = "#000";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const name = (this.getName ? this.getName() : "").trim().toUpperCase();
    const date = this.getDate ? this.getDate() : "";
    const nameSize = this.getNameSize ? this.getNameSize() : 12;
    const dateSize = this.getDateSize ? this.getDateSize() : 10;

    if (name) {
      let size = nameSize;
      ctx.font = `bold ${size}px Arial, sans-serif`;
      while (ctx.measureText(name).width > this.targetW - 6 && size > 6) {
        size--;
        ctx.font = `bold ${size}px Arial, sans-serif`;
      }
      ctx.fillText(name, this.targetW / 2, top + 2 + nameSize / 2);
    }
    if (date) {
      ctx.font = `${dateSize}px Arial, sans-serif`;
      ctx.fillText(formatDate(date), this.targetW / 2, top + BAND_HEIGHT - 3 - dateSize / 2);
    }
  }

  scheduleUpdate() {
    clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => this.updateOutput(), 150);
  }

  async updateOutput() {
    if (!this.img) return;
    const seq = ++this.renderSeq;

    const blocked = this.checkBlocked ? this.checkBlocked() : false;

    const canvas = this.compose();
    const blob = await toJpegUnder(canvas, this.maxBytes);
    if (seq !== this.renderSeq) return; // a newer render superseded this one

    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.blobUrl = URL.createObjectURL(blob);
    this.preview.src = this.blobUrl;

    const kb = (blob.size / 1024).toFixed(1);
    const ok = blob.size < this.limitKB * 1024;
    this.sizeInfo.textContent =
      `${this.targetW}×${this.targetH} px · ${kb} KB ${ok ? `✓ within ${this.limitKB} KB limit` : `✗ over ${this.limitKB} KB!`}`;
    this.sizeInfo.className = `size-info ${ok ? "ok" : "bad"}`;

    if (blocked || !ok) {
      this.download.classList.add("disabled");
      this.download.removeAttribute("href");
    } else {
      this.download.classList.remove("disabled");
      this.download.href = this.blobUrl;
    }
  }
}

/* ---------- Photograph tool ---------- */
const photoTool = new ResizeTool({
  prefix: "photo",
  targetW: 150,
  targetH: 200,
  imageAreaH: 200 - BAND_HEIGHT,
  hasBand: true,
  maxBytes: 29 * 1024, // compression target, safely under the 30 KB limit
  limitKB: 30,
  showFaceGuides: true,
  autoSelect: "face",
});

const photoName = document.getElementById("photo-name");
const photoDate = document.getElementById("photo-date");
const photoDateWarn = document.getElementById("photo-datewarn");
const photoBlocker = document.getElementById("photo-blocker");
const photoNameSize = document.getElementById("photo-namesize");
const photoNameSizeVal = document.getElementById("photo-namesize-val");
const photoDateSize = document.getElementById("photo-datesize");
const photoDateSizeVal = document.getElementById("photo-datesize-val");

photoTool.getName = () => photoName.value;
photoTool.getDate = () => photoDate.value;
photoTool.getNameSize = () => Number(photoNameSize.value);
photoTool.getDateSize = () => Number(photoDateSize.value);

photoTool.checkBlocked = () => {
  const name = photoName.value.trim();
  const problems = [];
  if (!name) problems.push("enter your name");
  else if (name.toUpperCase() === "NAME") problems.push('replace "NAME" with your actual name');
  if (!photoDate.value) problems.push("enter the date the photo was taken");
  else if (photoDate.value > photoDate.max || photoDate.value < photoDate.min)
    problems.push("use a date within the last 6 months");
  if (problems.length) {
    photoBlocker.textContent =
      `To enable download: ${problems.join("; ")} — Kerala PSC rejects photos otherwise.`;
    photoBlocker.hidden = false;
    return true;
  }
  photoBlocker.hidden = true;
  return false;
};

/* Local-timezone YYYY-MM-DD (toISOString would use UTC and can be a day off) */
function isoLocal(d) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

const today = new Date();
const sixMonthsAgo = new Date();
sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
photoDate.max = isoLocal(today);
photoDate.min = isoLocal(sixMonthsAgo);
photoDate.value = isoLocal(today); // default: today

function checkPhotoDate() {
  if (photoDate.value && photoDate.value > photoDate.max) {
    photoDateWarn.textContent = "That date is in the future — please check it.";
    photoDateWarn.hidden = false;
  } else if (photoDate.value && photoDate.value < photoDate.min) {
    photoDateWarn.textContent = "The photo must have been taken within the last 6 months.";
    photoDateWarn.hidden = false;
  } else {
    photoDateWarn.hidden = true;
  }
}

photoName.addEventListener("input", () => photoTool.scheduleUpdate());
photoDate.addEventListener("input", () => {
  checkPhotoDate();
  photoTool.scheduleUpdate();
});
photoNameSize.addEventListener("input", () => {
  photoNameSizeVal.textContent = photoNameSize.value;
  photoTool.scheduleUpdate();
});
photoDateSize.addEventListener("input", () => {
  photoDateSizeVal.textContent = photoDateSize.value;
  photoTool.scheduleUpdate();
});

/* ---------- Signature tool ---------- */
const signTool = new ResizeTool({
  prefix: "sign",
  targetW: 150,
  targetH: 100,
  imageAreaH: 100,
  hasBand: false,
  maxBytes: 19 * 1024, // compression target, safely under the 20 KB limit
  limitKB: 20,
  showFaceGuides: false,
  autoSelect: "signature",
});

window.addEventListener("resize", () => {
  for (const tool of [photoTool, signTool]) {
    if (!tool.img) continue;
    tool.refreshScale();
    tool.draw();
  }
});

/* ---------- Tabs ---------- */
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => {
      t.classList.toggle("active", t === tab);
      t.setAttribute("aria-selected", t === tab ? "true" : "false");
    });
    document.querySelectorAll(".panel").forEach((p) => {
      p.classList.toggle("active", p.id === tab.dataset.target);
    });
  });
});
