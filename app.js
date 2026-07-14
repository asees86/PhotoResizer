"use strict";

const MAX_BYTES = 29 * 1024; // stay safely under the 30 KB limit
const BAND_HEIGHT = 35;      // white strip for name + date on the photo

/* Convert a canvas to a JPEG blob no larger than maxBytes by stepping
   quality down. Returns the last (smallest) blob if even the lowest
   quality overshoots — at 150px wide that practically never happens. */
async function toJpegUnder(canvas, maxBytes) {
  let blob = null;
  for (let q = 0.92; q >= 0.35; q -= 0.07) {
    blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", q));
    if (blob && blob.size <= maxBytes) return blob;
  }
  return blob;
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
  /* opts: prefix, targetW, targetH, imageAreaH, hasBand */
  constructor(opts) {
    Object.assign(this, opts);

    this.drop = document.getElementById(`${this.prefix}-drop`);
    this.file = document.getElementById(`${this.prefix}-file`);
    this.editor = document.getElementById(`${this.prefix}-editor`);
    this.canvas = document.getElementById(`${this.prefix}-canvas`);
    this.zoom = document.getElementById(`${this.prefix}-zoom`);
    this.changeBtn = document.getElementById(`${this.prefix}-change`);
    this.preview = document.getElementById(`${this.prefix}-preview`);
    this.previewActual = document.getElementById(`${this.prefix}-preview-actual`);
    this.sizeInfo = document.getElementById(`${this.prefix}-size`);
    this.download = document.getElementById(`${this.prefix}-download`);
    this.imgWarn = document.getElementById(`${this.prefix}-imgwarn`);

    this.ctx = this.canvas.getContext("2d");
    this.img = null;
    this.scale = 1;
    this.minScale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.blobUrl = null;
    this.updateTimer = null;
    this.renderSeq = 0;

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

    const fw = this.canvas.width, fh = this.canvas.height;
    this.minScale = Math.max(fw / img.width, fh / img.height);
    this.scale = this.minScale;
    // center the image in the frame
    this.offsetX = (fw - img.width * this.scale) / 2;
    this.offsetY = (fh - img.height * this.scale) / 2;

    this.zoom.min = this.minScale;
    this.zoom.max = this.minScale * 4;
    this.zoom.step = (this.minScale * 3) / 200;
    this.zoom.value = this.minScale;

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
  }

  /* ---------- cropper ---------- */
  bindCropper() {
    let dragging = false, lastX = 0, lastY = 0;

    // pointer coords -> canvas pixel coords (canvas may be CSS-scaled)
    const toCanvas = (e) => {
      const r = this.canvas.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) * (this.canvas.width / r.width),
        y: (e.clientY - r.top) * (this.canvas.height / r.height),
      };
    };

    this.canvas.addEventListener("pointerdown", (e) => {
      if (!this.img) return;
      dragging = true;
      const p = toCanvas(e);
      lastX = p.x;
      lastY = p.y;
      try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointers have no capture */ }
    });

    this.canvas.addEventListener("pointermove", (e) => {
      if (!dragging || !this.img) return;
      const p = toCanvas(e);
      this.offsetX += p.x - lastX;
      this.offsetY += p.y - lastY;
      lastX = p.x;
      lastY = p.y;
      this.clamp();
      this.draw();
      this.scheduleUpdate();
    });

    const endDrag = () => { dragging = false; };
    this.canvas.addEventListener("pointerup", endDrag);
    this.canvas.addEventListener("pointercancel", endDrag);

    this.canvas.addEventListener("wheel", (e) => {
      if (!this.img) return;
      e.preventDefault();
      const p = toCanvas(e);
      const factor = Math.pow(1.0015, -e.deltaY);
      this.zoomTo(this.scale * factor, p.x, p.y);
    }, { passive: false });

    this.zoom.addEventListener("input", () => {
      if (!this.img) return;
      this.zoomTo(parseFloat(this.zoom.value), this.canvas.width / 2, this.canvas.height / 2);
    });
  }

  zoomTo(newScale, cx, cy) {
    newScale = Math.min(Math.max(newScale, this.minScale), this.minScale * 4);
    const ratio = newScale / this.scale;
    this.offsetX = cx - (cx - this.offsetX) * ratio;
    this.offsetY = cy - (cy - this.offsetY) * ratio;
    this.scale = newScale;
    this.zoom.value = newScale;
    this.clamp();
    this.draw();
    this.scheduleUpdate();
  }

  clamp() {
    const fw = this.canvas.width, fh = this.canvas.height;
    const iw = this.img.width * this.scale;
    const ih = this.img.height * this.scale;
    this.offsetX = Math.min(0, Math.max(fw - iw, this.offsetX));
    this.offsetY = Math.min(0, Math.max(fh - ih, this.offsetY));
  }

  draw() {
    const { ctx, canvas, img } = this;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, this.offsetX, this.offsetY, img.width * this.scale, img.height * this.scale);
  }

  /* ---------- output ---------- */
  compose() {
    const out = document.createElement("canvas");
    out.width = this.targetW;
    out.height = this.targetH;
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, out.width, out.height);

    // map the crop frame back to source-image pixels
    const sx = -this.offsetX / this.scale;
    const sy = -this.offsetY / this.scale;
    const sw = this.canvas.width / this.scale;
    const sh = this.canvas.height / this.scale;
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

    if (name) {
      let size = 12;
      ctx.font = `bold ${size}px Arial, sans-serif`;
      while (ctx.measureText(name).width > this.targetW - 6 && size > 6) {
        size--;
        ctx.font = `bold ${size}px Arial, sans-serif`;
      }
      ctx.fillText(name, this.targetW / 2, top + 11);
    }
    if (date) {
      ctx.font = "10px Arial, sans-serif";
      ctx.fillText(formatDate(date), this.targetW / 2, top + 25);
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
    const blob = await toJpegUnder(canvas, MAX_BYTES);
    if (seq !== this.renderSeq) return; // a newer render superseded this one

    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.blobUrl = URL.createObjectURL(blob);
    this.preview.src = this.blobUrl;
    this.previewActual.src = this.blobUrl;

    const kb = (blob.size / 1024).toFixed(1);
    const ok = blob.size <= 30 * 1024;
    this.sizeInfo.textContent =
      `${this.targetW}×${this.targetH} px · ${kb} KB ${ok ? "✓ within 30 KB limit" : "✗ over 30 KB!"}`;
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
});

const photoName = document.getElementById("photo-name");
const photoDate = document.getElementById("photo-date");
const photoDateWarn = document.getElementById("photo-datewarn");
const photoBlocker = document.getElementById("photo-blocker");

photoTool.getName = () => photoName.value;
photoTool.getDate = () => photoDate.value;
photoTool.checkBlocked = () => {
  const missing = [];
  if (!photoName.value.trim()) missing.push("name");
  if (!photoDate.value) missing.push("date taken");
  if (missing.length) {
    photoBlocker.textContent = `Enter your ${missing.join(" and ")} to enable download — Kerala PSC rejects photos without them.`;
    photoBlocker.hidden = false;
    return true;
  }
  photoBlocker.hidden = true;
  return false;
};

photoDate.max = new Date().toISOString().slice(0, 10);

function checkPhotoDate() {
  if (!photoDate.value) { photoDateWarn.hidden = true; return; }
  const taken = new Date(photoDate.value);
  const now = new Date();
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
  if (taken > now) {
    photoDateWarn.textContent = "That date is in the future — please check it.";
    photoDateWarn.hidden = false;
  } else if (taken < sixMonthsAgo) {
    photoDateWarn.textContent = "Kerala PSC requires a photo taken within the last 6 months. This date is older.";
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

/* ---------- Signature tool ---------- */
new ResizeTool({
  prefix: "sign",
  targetW: 150,
  targetH: 100,
  imageAreaH: 100,
  hasBand: false,
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
