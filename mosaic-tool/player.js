/**
 * Mosaic player — one transport; rectangular grid (no empty cells).
 * Grid size is rows × columns from inputs; resizing copies neighbor times (pad/trim).
 */

/** Player page state persisted in the main `index.html` experience. */
const STORAGE_KEY = "vimeo-mosaic-player-v1";

const ytPlayers = new Map();
let draggablePromise = null;
let playerSortable = null;

let videoRef = null;
/** @type {{ t: number }[]} */
let tiles = [{ t: 0 }];
/** >= 0 = tile index; -1 = none (clean screenshot, transport off) */
let selectedIndex = -1;
/** Last committed grid size (for reshaping when row/col inputs change). */
let committedGridCols = 3;
let committedGridRows = 2;
const MAX_GRID_COLS = 12;
const MAX_GRID_ROWS = 12;
const DEFAULT_TILE_RATIO = { w: 16, h: 9 };
const COMMON_TILE_RATIOS = [
  { w: 1, h: 1 },
  { w: 4, h: 3 },
  { w: 3, h: 2 },
  { w: 16, h: 10 },
  { w: 16, h: 9 },
  { w: 21, h: 9 },
  { w: 9, h: 16 },
];
let renderId = 0;
let lastKnownDurationSec = NaN;

let vimeoTransportCleanup = null;
/** After a real reorder, ignore the synthetic click so selection does not jump to the wrong tile. */
let blockTileSelectClickUntil = 0;
/** After `applyTileOrderFromDom`, skip one DOM snapshot so API races do not overwrite correct `tiles`. */
let skipNextDomSnapshot = false;

/**
 * CDN `lib/sortable.js` sets `window.Sortable` to webpack exports: `{ default: Sortable }`,
 * not the constructor itself (see runtime: onload with `hasWindowSortable:false`).
 */
function getShopifySortableCtor() {
  const s = window.Sortable;
  if (typeof s === "function") return s;
  if (s && typeof s.default === "function") return s.default;
  return null;
}

function loadDraggableAPI() {
  if (getShopifySortableCtor()) {
    return Promise.resolve();
  }
  if (!draggablePromise) {
    draggablePromise = new Promise((resolve, reject) => {
      const tag = document.createElement("script");
      tag.src = "https://cdn.jsdelivr.net/npm/@shopify/draggable@1.0.0-beta.12/lib/sortable.js";
      tag.onload = () => resolve();
      tag.onerror = () => {
        reject(new Error("Draggable API load failed"));
      };
      document.head.appendChild(tag);
    });
  }
  return draggablePromise;
}

function applyTileOrderFromDom(grid) {
  const oldTiles = tiles.slice();
  const oldSelected = selectedIndex;
  const orderedOldIndexes = Array.from(grid.querySelectorAll(".mosaic-cell")).map((cell) =>
    parseInt(cell.dataset.index, 10)
  );
  if (
    orderedOldIndexes.length !== oldTiles.length ||
    orderedOldIndexes.some((i) => !Number.isFinite(i) || i < 0 || i >= oldTiles.length)
  ) {
    return false;
  }
  tiles = orderedOldIndexes.map((i) => oldTiles[i]);
  selectedIndex = oldSelected >= 0 ? orderedOldIndexes.indexOf(oldSelected) : -1;
  saveState();
  return true;
}

async function enablePlayerTileReorder(grid) {
  if (playerSortable && typeof playerSortable.destroy === "function") {
    playerSortable.destroy();
    playerSortable = null;
  }
  try {
    await loadDraggableAPI();
    const SortableCtor = getShopifySortableCtor();
    if (!SortableCtor) {
      throw new Error("window.Sortable missing after script load");
    }
    playerSortable = new SortableCtor([grid], {
      draggable: ".mosaic-cell",
      handle: ".mosaic-cell-hit",
      /** Require ~10px move before drag starts so taps reliably become clicks (Draggable default is 0). */
      distance: 10,
      mirror: { constrainDimensions: true },
    });
    playerSortable.on("sortable:stop", (evt) => {
      const oldIndex = evt.oldIndex;
      const newIndex = evt.newIndex;
      const reordered = Number.isFinite(oldIndex) && Number.isFinite(newIndex) && oldIndex !== newIndex;
      if (reordered) {
        blockTileSelectClickUntil = Date.now() + 350;
      }
      if (!applyTileOrderFromDom(grid)) return;
      skipNextDomSnapshot = true;
      void (async () => {
        await render();
        if (reordered && videoRef) {
          await refreshAllTilePaints();
        }
      })().catch((e) => console.error(e));
    });
  } catch (e) {
    console.warn("Could not enable tile reorder", e);
  }
}

function parseVimeo(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  try {
    const u = raw.startsWith("http") ? new URL(raw) : new URL("https://" + raw);
    const path = u.pathname;
    let id = null;
    const vidMatch = path.match(/\/(?:video\/)?(\d+)/);
    if (vidMatch) id = vidMatch[1];
    const h = u.searchParams.get("h") || null;
    return id ? { provider: "vimeo", id, h } : null;
  } catch {
    const digits = raw.match(/(\d{6,})/);
    return digits ? { provider: "vimeo", id: digits[1], h: null } : null;
  }
}

function parseYouTube(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  try {
    const u = raw.startsWith("http") ? new URL(raw) : new URL("https://" + raw);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = u.pathname.slice(1).split("/")[0];
      return id && id.length >= 6 ? { provider: "youtube", id } : null;
    }
    if (host.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return { provider: "youtube", id: v };
      const embed = u.pathname.match(/\/embed\/([^/?]+)/);
      if (embed) return { provider: "youtube", id: embed[1] };
    }
    return null;
  } catch {
    return null;
  }
}

function parseVideoRef(input) {
  return parseVimeo(input) || parseYouTube(input);
}

function vimeoTimeFragment(seconds) {
  const t = Math.max(0, Math.floor(seconds));
  if (t === 0) return "";
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (h > 0) return `#t=${h}h${m}m${s}s`;
  if (m > 0) return `#t=${m}m${s}s`;
  return `#t=${t}`;
}

function vimeoEmbedSrc({ id, h }, seconds, { mosaicCell = null } = {}) {
  const params = new URLSearchParams({
    badge: "0",
    autopause: "0",
    muted: "1",
    title: "0",
    byline: "0",
    portrait: "0",
    controls: "0",
  });
  if (h) params.set("h", h);
  if (mosaicCell != null) params.set("player_id", `player_${mosaicCell}`);
  const base = `https://player.vimeo.com/video/${id}?${params.toString()}`;
  return `${base}${vimeoTimeFragment(seconds)}`;
}

function youtubeEmbedSrc({ id }, seconds) {
  const start = Math.max(0, Math.floor(seconds));
  const params = new URLSearchParams({
    start: String(start),
    rel: "0",
    modestbranding: "1",
    playsinline: "1",
    controls: "0",
  });
  return `https://www.youtube.com/embed/${id}?${params.toString()}`;
}

function embedSrc(ref, seconds, opts) {
  if (!ref) return "";
  return ref.provider === "vimeo"
    ? vimeoEmbedSrc(ref, seconds, opts)
    : youtubeEmbedSrc(ref, seconds);
}

/** Some embeds never emit `seeked`; without a cap, `render()` never finishes and transport stays disabled. */
function waitForVimeoSeekedOrTimeout(player, ms = 3000) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      player.off("seeked", onSeeked);
      resolve();
    };
    const onSeeked = () => done();
    const timer = setTimeout(done, ms);
    player.on("seeked", onSeeked);
  });
}

function nextFrameLayout() {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

let ytApiPromise = null;
function loadYouTubeAPI() {
  if (window.YT && window.YT.Player) {
    return Promise.resolve();
  }
  if (!ytApiPromise) {
    ytApiPromise = new Promise((resolve) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof prev === "function") prev();
        resolve();
      };
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      const first = document.getElementsByTagName("script")[0];
      first.parentNode.insertBefore(tag, first);
    });
  }
  return ytApiPromise;
}

function loadVimeoAPI() {
  return new Promise((resolve, reject) => {
    if (window.Vimeo && window.Vimeo.Player) {
      resolve();
      return;
    }
    const tag = document.createElement("script");
    tag.src = "https://player.vimeo.com/api/player.js";
    tag.onload = () => resolve();
    tag.onerror = () => reject(new Error("Vimeo API load failed"));
    document.head.appendChild(tag);
  });
}

async function seekVimeoIframeToTime(iframe, rawSeconds, { loadApi = true } = {}) {
  if (loadApi) await loadVimeoAPI();
  const target = Math.max(0, Number.isFinite(rawSeconds) ? rawSeconds : 0);
  const player = new window.Vimeo.Player(iframe);
  await player.ready();
  await player.setCurrentTime(target);
  if (target > 0.05) {
    await waitForVimeoSeekedOrTimeout(player);
  }
  await player.pause();
  return player.getCurrentTime();
}

async function seekVimeoCells(grid, times) {
  try {
    await loadVimeoAPI();
  } catch (e) {
    console.warn("Vimeo Player API failed to load", e);
    return;
  }
  const iframes = grid.querySelectorAll("iframe");
  await Promise.all(
    Array.from(iframes).map(async (iframe, i) => {
      const t = Number.isFinite(times[i]) ? times[i] : 0;
      try {
        await seekVimeoIframeToTime(iframe, t, { loadApi: false });
      } catch (err) {
        console.warn("Vimeo seek failed for cell", i, err);
      }
    })
  );
}

function getGridCols() {
  const raw = parseInt(document.getElementById("grid-cols").value, 10);
  const n = Number.isFinite(raw) ? raw : 3;
  return Math.max(1, Math.min(MAX_GRID_COLS, n));
}

function getGridRows() {
  const raw = parseInt(document.getElementById("grid-rows").value, 10);
  const n = Number.isFinite(raw) ? raw : 2;
  return Math.max(1, Math.min(MAX_GRID_ROWS, n));
}

function clampRatioPart(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0.1, Math.min(99, n));
}

function getTileRatioWidth() {
  const el = document.getElementById("ratio-width");
  return clampRatioPart(el?.value, DEFAULT_TILE_RATIO.w);
}

function getTileRatioHeight() {
  const el = document.getElementById("ratio-height");
  return clampRatioPart(el?.value, DEFAULT_TILE_RATIO.h);
}

function getTileRatio() {
  return {
    w: getTileRatioWidth(),
    h: getTileRatioHeight(),
  };
}

function setTileRatioInputs(width, height) {
  const w = clampRatioPart(width, DEFAULT_TILE_RATIO.w);
  const h = clampRatioPart(height, DEFAULT_TILE_RATIO.h);
  const widthInput = document.getElementById("ratio-width");
  const heightInput = document.getElementById("ratio-height");
  if (widthInput) widthInput.value = String(w);
  if (heightInput) heightInput.value = String(h);
}

function applyMosaicTileAspectRatio(grid) {
  if (!grid) return;
  const ratio = getTileRatio();
  grid.style.setProperty("--tile-ratio-w", String(ratio.w));
  grid.style.setProperty("--tile-ratio-h", String(ratio.h));
}

function refreshMosaicTileAspectRatioOnly() {
  applyMosaicTileAspectRatio(document.getElementById("mosaic-root"));
  saveState();
}

function ratioDistance(a, b) {
  return Math.abs(a - b) / Math.max(a, b);
}

function toDetectedRatio(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ...DEFAULT_TILE_RATIO };
  }
  const source = width / height;
  let best = COMMON_TILE_RATIOS[0];
  let bestDistance = ratioDistance(source, best.w / best.h);
  for (let i = 1; i < COMMON_TILE_RATIOS.length; i++) {
    const candidate = COMMON_TILE_RATIOS[i];
    const dist = ratioDistance(source, candidate.w / candidate.h);
    if (dist < bestDistance) {
      best = candidate;
      bestDistance = dist;
    }
  }
  return { w: best.w, h: best.h };
}

async function detectSourceAspectRatio(ref) {
  if (!ref) return { ...DEFAULT_TILE_RATIO };
  if (ref.provider !== "vimeo") {
    return { ...DEFAULT_TILE_RATIO };
  }
  let probe = null;
  let player = null;
  try {
    await loadVimeoAPI();
    probe = document.createElement("iframe");
    probe.src = embedSrc(ref, 0);
    probe.setAttribute("allow", "autoplay; fullscreen; picture-in-picture");
    probe.style.position = "fixed";
    probe.style.left = "-9999px";
    probe.style.top = "-9999px";
    probe.style.width = "1px";
    probe.style.height = "1px";
    probe.style.border = "0";
    document.body.appendChild(probe);
    player = new window.Vimeo.Player(probe);
    await player.ready();
    const width = await player.getVideoWidth();
    const height = await player.getVideoHeight();
    return toDetectedRatio(width, height);
  } catch (_) {
    return { ...DEFAULT_TILE_RATIO };
  } finally {
    try {
      if (player) await player.destroy();
    } catch (_) {}
    probe?.remove();
  }
}

/** Pad tiles so `tiles.length` is a multiple of `cols` (clone last tile). */
function ensureRectangularGridWithCols(cols) {
  const c = Math.max(1, Math.min(MAX_GRID_COLS, cols));
  if (tiles.length === 0) {
    tiles = [{ t: 0 }];
  }
  const rem = tiles.length % c;
  if (rem === 0) return;
  const last = tiles[tiles.length - 1];
  const pad = c - rem;
  for (let i = 0; i < pad; i++) {
    tiles.push({ t: last.t });
  }
}

/** Resize `tiles` in memory to match target rows/columns (uses `committedGridCols` as previous column count). */
function mutateTilesToMatchGridDimensions(newR, newC) {
  const oldC = committedGridCols;
  ensureRectangularGridWithCols(oldC);
  if (newC !== oldC) {
    reshapeTilesForNewColumnCount(oldC, newC);
  }
  let curR = tiles.length / newC;
  while (curR > newR) {
    tiles = tiles.slice(0, (curR - 1) * newC);
    curR--;
  }
  while (curR < newR) {
    for (let c = 0; c < newC; c++) {
      const above = tiles[(curR - 1) * newC + c];
      tiles.push({ t: above.t });
    }
    curR++;
  }
  committedGridCols = newC;
  committedGridRows = newR;
  if (selectedIndex >= tiles.length) {
    selectedIndex = Math.max(0, tiles.length - 1);
  }
}

/** Resize stored `tiles` to match row/column inputs (snapshot live times first if `videoRef`). */
async function applyGridSizeFromInputs() {
  const newR = getGridRows();
  const newC = getGridCols();
  if (!videoRef) {
    committedGridCols = newC;
    committedGridRows = newR;
    saveState();
    return;
  }
  await snapshotTileTimesIfDomMatches();
  mutateTilesToMatchGridDimensions(newR, newC);
  saveState();
  await render();
}

/** Reflow stored times when column count changes (row-major, pad with copies). */
function reshapeTilesForNewColumnCount(oldC, newC) {
  const o = Math.max(1, Math.min(MAX_GRID_COLS, oldC));
  const n = Math.max(1, Math.min(MAX_GRID_COLS, newC));
  if (o === n) return;
  const oldRows = Math.floor(tiles.length / o);
  if (oldRows * o !== tiles.length) return;
  const flat = [];
  for (let r = 0; r < oldRows; r++) {
    for (let c = 0; c < o; c++) {
      flat.push(tiles[r * o + c]);
    }
  }
  const newRows = Math.ceil(flat.length / n);
  const target = newRows * n;
  const next = flat.map((x) => ({ t: x.t }));
  while (next.length < target) {
    next.push({ t: next[next.length - 1].t });
  }
  tiles = next;
}

async function nudgeVimeoCellsPlayPause(grid) {
  try {
    await loadVimeoAPI();
  } catch {
    return;
  }
  /** Brief play after seek helps iframes commit a decoded frame; keep ~1–2 frames at 60fps. */
  const NUDGE_MS = 80;
  const iframes = grid.querySelectorAll(".mosaic-cell iframe");
  for (let i = 0; i < iframes.length; i++) {
    try {
      const pl = new window.Vimeo.Player(iframes[i]);
      await pl.ready();
      await pl.play();
      await new Promise((r) => setTimeout(r, NUDGE_MS));
      await pl.pause();
    } catch (_) {}
  }
}

async function nudgeYouTubeCellsPlayPause(times) {
  const NUDGE_MS = 80;
  for (let i = 0; i < tiles.length; i++) {
    const p = ytPlayers.get(i);
    if (!p) continue;
    const t = Number.isFinite(times[i]) ? times[i] : 0;
    try {
      p.seekTo(Math.max(0, t), true);
      p.playVideo();
      await new Promise((r) => setTimeout(r, NUDGE_MS));
      p.pauseVideo();
    } catch (_) {}
  }
}

function setGlobalRefreshProgressActive(on) {
  const el = document.getElementById("global-refresh-progress");
  if (!el) return;
  el.classList.toggle("is-active", !!on);
  el.setAttribute("aria-busy", on ? "true" : "false");
}

function setTileRefreshProgressActive(grid, index) {
  if (!grid) return;
  grid.querySelectorAll(".mosaic-cell").forEach((cell, i) => {
    const strip = cell.querySelector(".tile-progress");
    if (!strip) return;
    strip.classList.toggle("tile-progress--active", Number.isFinite(index) && i === index);
  });
}

/** Full seek + play + pause on every tile (e.g. manual refresh after reload). */
async function refreshAllTilePaints() {
  if (!videoRef) return;
  await snapshotTileTimesIfDomMatches();
  const grid = document.getElementById("mosaic-root");
  if (!grid || grid.querySelectorAll(".mosaic-cell").length !== tiles.length) return;
  const times = getTimes();
  const NUDGE_MS = 80;
  setGlobalRefreshProgressActive(true);
  try {
    if (videoRef.provider === "vimeo") {
      try {
        await loadVimeoAPI();
      } catch {
        return;
      }
      const iframes = grid.querySelectorAll(".mosaic-cell iframe");
      for (let i = 0; i < iframes.length; i++) {
        setTileRefreshProgressActive(grid, i);
        const iframe = iframes[i];
        try {
          const pl = new window.Vimeo.Player(iframe);
          await pl.ready();
          const t = Number.isFinite(times[i]) ? times[i] : 0;
          await pl.setCurrentTime(t);
          await waitForVimeoSeekedOrTimeout(pl, 600);
          await pl.play();
          await new Promise((r) => setTimeout(r, NUDGE_MS));
          await pl.pause();
        } catch (_) {}
      }
    } else {
      for (let i = 0; i < tiles.length; i++) {
        setTileRefreshProgressActive(grid, i);
        const p = ytPlayers.get(i);
        if (!p) continue;
        const t = Number.isFinite(times[i]) ? times[i] : 0;
        try {
          p.seekTo(Math.max(0, t), true);
          p.playVideo();
          await new Promise((r) => setTimeout(r, NUDGE_MS));
          p.pauseVideo();
        } catch (_) {}
      }
    }
    await pauseAllExcept(selectedIndex >= 0 ? selectedIndex : -1);
    bindTransportToSelection();
    saveState();
  } finally {
    setTileRefreshProgressActive(grid, null);
    setGlobalRefreshProgressActive(false);
  }
}

function getGridGapPx() {
  const el = document.getElementById("grid-gap");
  if (!el) return 6;
  const raw = parseInt(String(el.value).trim(), 10);
  const n = Number.isFinite(raw) ? raw : 6;
  return Math.max(0, Math.min(64, n));
}

function normalizeHexColor(value) {
  const raw = String(value || "").trim();
  const withHash = raw.startsWith("#") ? raw : `#${raw}`;
  const match = withHash.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return null;
  const hex = match[1];
  if (hex.length === 3) {
    return `#${hex
      .split("")
      .map((ch) => ch + ch)
      .join("")
      .toUpperCase()}`;
  }
  return `#${hex.toUpperCase()}`;
}

function setGridBackgroundInputs(color) {
  const normalized = normalizeHexColor(color) || "#000000";
  const colorEl = document.getElementById("grid-bg");
  const hexEl = document.getElementById("grid-bg-hex");
  if (colorEl) colorEl.value = normalized;
  if (hexEl) hexEl.value = normalized;
}

function getGridBackground() {
  const colorEl = document.getElementById("grid-bg");
  const hexEl = document.getElementById("grid-bg-hex");
  const hexValue = normalizeHexColor(hexEl?.value);
  if (hexValue) return hexValue;
  const pickerValue = normalizeHexColor(colorEl?.value);
  return pickerValue || "#000000";
}

function applyMosaicGridVisuals(grid) {
  if (!grid) return;
  grid.style.gap = `${getGridGapPx()}px`;
  grid.style.backgroundColor = getGridBackground();
}

function refreshMosaicGridVisualsOnly() {
  applyMosaicGridVisuals(document.getElementById("mosaic-root"));
  saveState();
}

async function removeSelectedTile() {
  if (!videoRef || selectedIndex < 0) return;
  await snapshotTileTimesIfDomMatches();
  tiles.splice(selectedIndex, 1);
  if (tiles.length === 0) {
    tiles = [{ t: 0 }];
    selectedIndex = 0;
  } else if (selectedIndex >= tiles.length) {
    selectedIndex = tiles.length - 1;
  }
  ensureRectangularGridWithCols(getGridCols());
  saveState();
  await render();
}

function getTimes() {
  return tiles.map((x) => x.t);
}

function saveState() {
  try {
    const ratio = getTileRatio();
    const payload = {
      videoUrl: document.getElementById("video-url").value.trim(),
      rows: getGridRows(),
      cols: getGridCols(),
      ratioWidth: ratio.w,
      ratioHeight: ratio.h,
      gridGap: getGridGapPx(),
      gridBg: getGridBackground(),
      tiles: tiles.map((x) => x.t),
      selectedIndex,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (_) {}
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function updateSelectionUi() {
  const grid = document.getElementById("mosaic-root");
  if (!grid) return;
  grid.querySelectorAll(".mosaic-cell").forEach((cell, i) => {
    const sel = selectedIndex >= 0 && i === selectedIndex;
    cell.classList.toggle("mosaic-cell--selected", sel);
    cell.querySelector(".mosaic-cell-hit")?.classList.toggle("mosaic-cell-hit--selected", sel);
  });
}

function updateSelectedTileCurrentLabel(sec) {
  const grid = document.getElementById("mosaic-root");
  if (!grid) return;
  const el = grid.querySelector(".mosaic-cell-hit--selected .tile-current-time");
  if (!el) return;
  el.textContent = formatClock(sec);
}

function formatClock(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const pad = (n) => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

/** e.g. 129 → "2min 09sec" */
function formatHumanDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const whole = Math.round(sec);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  if (m === 0) return `${s}sec`;
  return `${m}min ${String(s).padStart(2, "0")}sec`;
}

function setDurationBadge(seconds) {
  const el = document.getElementById("duration-badge");
  if (!el) return;
  el.textContent = formatHumanDuration(seconds);
}

function setTransportEnabled(on) {
  document.getElementById("play-pause").disabled = !on;
  document.getElementById("seek-bar").disabled = !on;
}

/** Layout controls when no video or no tile selected; playback when a tile is selected. */
function updateTransportPanelVisibility() {
  const layout = document.getElementById("transport-panel-layout");
  const playback = document.getElementById("transport-panel-playback");
  if (!layout || !playback) return;
  const showLayout = !videoRef || selectedIndex < 0;
  const showPlayback = !!(videoRef && selectedIndex >= 0);
  layout.classList.toggle("transport-panel--hidden", !showLayout);
  playback.classList.toggle("transport-panel--hidden", !showPlayback);
}

function updatePlayButton(playing) {
  const btn = document.getElementById("play-pause");
  btn.textContent = playing ? "⏸" : "▶";
  btn.setAttribute("aria-label", playing ? "Pause" : "Play");
}

function clearTransportListeners() {
  if (typeof vimeoTransportCleanup === "function") {
    vimeoTransportCleanup();
    vimeoTransportCleanup = null;
  }
}

let ytTimeTimer = null;
function clearYtTimer() {
  if (ytTimeTimer) {
    clearInterval(ytTimeTimer);
    ytTimeTimer = null;
  }
}

function bindTransportToSelection() {
  clearTransportListeners();
  clearYtTimer();

  const bindAt = renderId;

  const seekBar = document.getElementById("seek-bar");
  const timeLabel = document.getElementById("time-label");

  if (!videoRef) {
    setTransportEnabled(false);
    seekBar.max = "0";
    seekBar.value = "0";
    timeLabel.textContent = "—";
    setDurationBadge(NaN);
    updatePlayButton(false);
    updateTransportPanelVisibility();
    return;
  }

  if (selectedIndex < 0) {
    setTransportEnabled(false);
    seekBar.max = "0";
    seekBar.value = "0";
    timeLabel.textContent = "—";
    if (Number.isFinite(lastKnownDurationSec) && lastKnownDurationSec > 0) {
      setDurationBadge(lastKnownDurationSec);
    }
    updatePlayButton(false);
    updateTransportPanelVisibility();
    return;
  }

  const grid = document.getElementById("mosaic-root");
  const cells = grid?.querySelectorAll(".mosaic-cell");
  const cell = cells?.length ? cells.item(selectedIndex) : null;
  if (!cell) {
    setTransportEnabled(false);
    updateTransportPanelVisibility();
    return;
  }

  setTransportEnabled(true);
  updatePlayButton(false);

  const syncLabel = (cur, dur) => {
    if (Number.isFinite(dur) && dur > 0) {
      lastKnownDurationSec = dur;
      setDurationBadge(dur);
    } else {
      setDurationBadge(lastKnownDurationSec);
    }
    timeLabel.textContent = formatClock(Number.isFinite(cur) ? cur : 0);
    updateSelectedTileCurrentLabel(cur);
  };

  if (videoRef.provider === "vimeo") {
    const iframe = cell.querySelector("iframe");
    if (!iframe) {
      setTransportEnabled(false);
      updateTransportPanelVisibility();
      return;
    }
    loadVimeoAPI()
      .then(() => new window.Vimeo.Player(iframe))
      .then((player) => player.ready().then(() => player))
      .then((player) => {
        if (bindAt !== renderId) return null;
        return Promise.all([player.getDuration(), player.getCurrentTime(), player.getPaused()]).then(
          ([dur, cur, paused]) => {
            if (bindAt !== renderId) return;
            const d = Number.isFinite(dur) && dur > 0 ? dur : 0;
            seekBar.max = String(Math.max(0.1, d));
            seekBar.value = String(Math.min(d, Math.max(0, cur)));
            syncLabel(cur, d);
            updatePlayButton(!paused);

            const onTime = (e) => {
              const t = e.seconds;
              if (!seekBar.matches(":active")) {
                seekBar.value = String(t);
              }
              syncLabel(t, d);
            };
            player.on("timeupdate", onTime);

            const onPlay = () => updatePlayButton(true);
            const onPause = () => updatePlayButton(false);
            player.on("play", onPlay);
            player.on("pause", onPause);

            vimeoTransportCleanup = () => {
              player.off("timeupdate", onTime);
              player.off("play", onPlay);
              player.off("pause", onPause);
            };
            updateTransportPanelVisibility();
          }
        );
      })
      .catch((err) => {
        console.warn("Vimeo transport bind failed", err);
        if (bindAt !== renderId) return;
        setTransportEnabled(true);
        seekBar.max = "3600";
        seekBar.value = "0";
        timeLabel.textContent = "0:00";
        setDurationBadge(lastKnownDurationSec);
        updatePlayButton(false);
        updateTransportPanelVisibility();
      });
  } else {
    const p = ytPlayers.get(selectedIndex);
    if (!p || !p.getDuration) {
      setTransportEnabled(false);
      updateTransportPanelVisibility();
      return;
    }
    const dur = p.getDuration();
    const cur = p.getCurrentTime();
    const d = Number.isFinite(dur) && dur > 0 ? dur : 0;
    seekBar.max = String(Math.max(0.1, d));
    seekBar.value = String(Math.min(d, Math.max(0, cur)));
    syncLabel(cur, d);
    const YT = window.YT;
    const playing = YT && YT.PlayerState && p.getPlayerState && p.getPlayerState() === YT.PlayerState.PLAYING;
    updatePlayButton(!!playing);

    ytTimeTimer = setInterval(() => {
      try {
        const t = p.getCurrentTime();
        const duration = p.getDuration();
        if (!seekBar.matches(":active")) {
          seekBar.value = String(t);
        }
        syncLabel(t, duration);
      } catch (_) {}
    }, 250);

    vimeoTransportCleanup = () => {
      clearYtTimer();
    };
    updateTransportPanelVisibility();
  }
}

async function pauseAllExcept(exceptIndex) {
  if (!videoRef) return;
  const grid = document.getElementById("mosaic-root");
  if (!grid) return;

  if (videoRef.provider === "vimeo") {
    try {
      await loadVimeoAPI();
    } catch {
      return;
    }
    const iframes = grid.querySelectorAll(".mosaic-cell iframe");
    await Promise.all(
      Array.from(iframes).map(async (iframe, i) => {
        if (i === exceptIndex) return;
        try {
          const pl = new window.Vimeo.Player(iframe);
          await pl.pause();
        } catch (_) {}
      })
    );
  } else {
    ytPlayers.forEach((p, i) => {
      if (i !== exceptIndex && p && p.pauseVideo) {
        try {
          p.pauseVideo();
        } catch (_) {}
      }
    });
  }
}

async function selectCell(index) {
  if (index < 0 || index >= tiles.length) return;
  await pauseAllExcept(-1);
  selectedIndex = index;
  updateSelectionUi();
  saveState();
  bindTransportToSelection();
}

async function deselectTile() {
  if (!videoRef) return;
  await snapshotTileTimesIfDomMatches();
  await pauseAllExcept(-1);
  selectedIndex = -1;
  updateSelectionUi();
  saveState();
  bindTransportToSelection();
}

async function mountYouTubePlayers(grid, ref, times, idStamp) {
  await loadYouTubeAPI();
  await nextFrameLayout();
  ytPlayers.clear();
  const mounts = grid.querySelectorAll("[data-yt-mosaic]");
  const first = mounts[0];
  const rect = first?.parentElement?.getBoundingClientRect();
  const w = Math.max(200, Math.floor(rect?.width || 320));
  const h = Math.max(112, Math.floor(rect?.height || 180));
  await Promise.all(
    Array.from(mounts).map(
      (div) =>
        new Promise((resolve) => {
          const i = parseInt(div.dataset.index, 10);
          const start = Math.floor(Math.max(0, Number.isFinite(times[i]) ? times[i] : 0));
          const loc = window.location;
          const originParam =
            loc.protocol === "http:" || loc.protocol === "https:" ? { origin: loc.origin } : {};
          new window.YT.Player(div.id, {
            width: w,
            height: h,
            videoId: ref.id,
            playerVars: {
              start,
              rel: 0,
              modestbranding: 1,
              playsinline: 1,
              controls: 0,
              fs: 0,
              enablejsapi: 1,
              ...originParam,
            },
            events: {
              onReady: (e) => {
                e.target.seekTo(start, true);
                e.target.pauseVideo();
                ytPlayers.set(i, e.target);
                resolve();
              },
            },
          });
        })
    )
  );
}

/**
 * Persist each tile's actual playback time into `tiles` before tearing the grid down.
 * Keeps scrubbed positions when duplicating or re-rendering (e.g. column count).
 */
async function snapshotTileTimesIfDomMatches() {
  if (!videoRef) return;
  const grid = document.getElementById("mosaic-root");
  if (!grid) return;
  const cells = grid.querySelectorAll(".mosaic-cell");
  if (cells.length !== tiles.length) return;

  if (videoRef.provider === "vimeo") {
    try {
      await loadVimeoAPI();
    } catch {
      return;
    }
    await Promise.all(
      Array.from(cells).map(async (cell, i) => {
        const iframe = cell.querySelector("iframe");
        if (!iframe) return;
        try {
          const player = new window.Vimeo.Player(iframe);
          await player.ready();
          const cur = await player.getCurrentTime();
          if (Number.isFinite(cur)) tiles[i] = { t: cur };
        } catch (_) {}
      })
    );
  } else {
    /** After Sortable reorders `.mosaic-cell` nodes, slot `i` holds the mount/player from creation index `dataset.index`, not `ytPlayers.get(i)`. */
    for (let i = 0; i < tiles.length; i++) {
      const cell = cells.item(i);
      const mount = cell?.querySelector("[data-yt-mosaic]");
      const pi = mount?.dataset?.index != null ? parseInt(mount.dataset.index, 10) : NaN;
      const p = ytPlayers.get(Number.isFinite(pi) ? pi : i);
      if (!p || typeof p.getCurrentTime !== "function") continue;
      try {
        const cur = p.getCurrentTime();
        if (Number.isFinite(cur)) tiles[i] = { t: cur };
      } catch (_) {}
    }
  }
}

async function render() {
  const host = document.getElementById("mosaic-host");
  const cols = getGridCols();

  if (videoRef) {
    const doSnapshot = !skipNextDomSnapshot;
    skipNextDomSnapshot = false;
    if (doSnapshot) {
      await snapshotTileTimesIfDomMatches();
    }
    ensureRectangularGridWithCols(getGridCols());
  } else {
    skipNextDomSnapshot = false;
  }

  if (selectedIndex >= 0 && selectedIndex >= tiles.length) {
    selectedIndex = Math.max(0, tiles.length - 1);
  }

  const times = getTimes();
  const n = tiles.length;
  const myId = ++renderId;

  clearTransportListeners();
  clearYtTimer();
  ytPlayers.clear();
  if (playerSortable && typeof playerSortable.destroy === "function") {
    try {
      playerSortable.destroy();
    } catch (_) {}
    playerSortable = null;
  }
  host.innerHTML = "";

  if (!videoRef) {
    host.innerHTML =
      '<p class="hint" style="margin:0;color:var(--muted)">Load a valid Vimeo or YouTube URL to begin.</p>';
    setTransportEnabled(false);
    setDurationBadge(NaN);
    updateTransportPanelVisibility();
    return;
  }

  const grid = document.createElement("div");
  grid.id = "mosaic-root";
  grid.className = "mosaic-grid";
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  const stamp = Date.now();

  for (let i = 0; i < n; i++) {
    const cell = document.createElement("div");
    cell.className = "mosaic-cell";
    cell.dataset.index = String(i);
    if (selectedIndex >= 0 && i === selectedIndex) {
      cell.classList.add("mosaic-cell--selected");
    }

    if (videoRef.provider === "youtube") {
      const mount = document.createElement("div");
      mount.id = `yt-player-${stamp}-${i}`;
      mount.setAttribute("data-yt-mosaic", "1");
      mount.dataset.index = String(i);
      mount.style.position = "absolute";
      mount.style.inset = "0";
      mount.style.width = "100%";
      mount.style.height = "100%";
      cell.appendChild(mount);
    } else {
      const iframe = document.createElement("iframe");
      iframe.setAttribute("allowfullscreen", "");
      iframe.setAttribute(
        "allow",
        "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      );
      iframe.src = embedSrc(videoRef, times[i], { mosaicCell: i });
      cell.appendChild(iframe);
    }

    const tileProg = document.createElement("div");
    tileProg.className = "tile-progress";
    tileProg.innerHTML = '<div class="tile-progress-indeterminate"></div>';
    cell.appendChild(tileProg);

    const hit = document.createElement("div");
    hit.className = "mosaic-cell-hit";
    hit.title = "Select this tile";
    if (selectedIndex >= 0 && i === selectedIndex) {
      hit.classList.add("mosaic-cell-hit--selected");
    }
    const current = document.createElement("div");
    current.className = "tile-current-time";
    current.textContent = formatClock(times[i]);
    hit.appendChild(current);
    cell.appendChild(hit);

    grid.appendChild(cell);
  }

  grid.addEventListener(
    "click",
    (e) => {
      if (Date.now() < blockTileSelectClickUntil) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const hit = e.target.closest(".mosaic-cell-hit");
      if (!hit || !grid.contains(hit)) return;
      const cell = hit.closest(".mosaic-cell");
      if (!cell || !grid.contains(cell)) return;
      const cellList = grid.querySelectorAll(".mosaic-cell");
      const idx = Array.prototype.indexOf.call(cellList, cell);
      if (idx < 0) return;
      e.preventDefault();
      e.stopPropagation();
      selectCell(idx).catch((err) => console.error(err));
    },
    false
  );

  host.appendChild(grid);
  applyMosaicGridVisuals(grid);
  applyMosaicTileAspectRatio(grid);

  if (videoRef.provider === "vimeo") {
    await seekVimeoCells(grid, times);
    await nudgeVimeoCellsPlayPause(grid);
  } else {
    await mountYouTubePlayers(grid, videoRef, times, stamp);
    await nudgeYouTubeCellsPlayPause(times);
  }

  if (myId !== renderId) return;

  await enablePlayerTileReorder(grid);
  await pauseAllExcept(selectedIndex >= 0 ? selectedIndex : -1);
  bindTransportToSelection();
  saveState();
}

async function getSelectedCurrentTime() {
  if (!videoRef || selectedIndex < 0) return NaN;
  const grid = document.getElementById("mosaic-root");
  const cells = grid?.querySelectorAll(".mosaic-cell");
  const cell = cells?.length ? cells.item(selectedIndex) : null;
  if (!cell) return NaN;

  if (videoRef.provider === "vimeo") {
    const iframe = cell.querySelector("iframe");
    if (!iframe) return NaN;
    try {
      await loadVimeoAPI();
      const player = new window.Vimeo.Player(iframe);
      await player.ready();
      return await player.getCurrentTime();
    } catch {
      return NaN;
    }
  }
  const p = ytPlayers.get(selectedIndex);
  if (p && typeof p.getCurrentTime === "function") {
    return p.getCurrentTime();
  }
  return NaN;
}

async function togglePlayPause() {
  if (!videoRef || selectedIndex < 0) return;
  await pauseAllExcept(selectedIndex);

  const grid = document.getElementById("mosaic-root");
  const cells = grid?.querySelectorAll(".mosaic-cell");
  const cell = cells?.length ? cells.item(selectedIndex) : null;
  if (!cell) return;

  if (videoRef.provider === "vimeo") {
    const iframe = cell.querySelector("iframe");
    if (!iframe) return;
    try {
      await loadVimeoAPI();
      const player = new window.Vimeo.Player(iframe);
      const paused = await player.getPaused();
      if (paused) await player.play();
      else await player.pause();
      updatePlayButton(await player.getPaused().then((p) => !p));
    } catch (e) {
      console.warn(e);
    }
  } else {
    const p = ytPlayers.get(selectedIndex);
    if (!p) return;
    const st = p.getPlayerState();
    if (st === window.YT.PlayerState.PLAYING) {
      p.pauseVideo();
      updatePlayButton(false);
    } else {
      p.playVideo();
      updatePlayButton(true);
    }
  }
}

async function seekSelected(value) {
  if (!videoRef || selectedIndex < 0) return;
  const sec = parseFloat(value);
  if (!Number.isFinite(sec)) return;

  const grid = document.getElementById("mosaic-root");
  const cells = grid?.querySelectorAll(".mosaic-cell");
  const cell = cells?.length ? cells.item(selectedIndex) : null;
  if (!cell) return;

  if (videoRef.provider === "vimeo") {
    const iframe = cell.querySelector("iframe");
    if (!iframe) return;
    try {
      await loadVimeoAPI();
      const player = new window.Vimeo.Player(iframe);
      await player.setCurrentTime(Math.max(0, sec));
    } catch (e) {
      console.warn(e);
    }
  } else {
    const p = ytPlayers.get(selectedIndex);
    if (p && p.seekTo) p.seekTo(sec, true);
  }
}

function wireTransportControls() {
  document.getElementById("play-pause").addEventListener("click", () => {
    togglePlayPause().catch((e) => console.error(e));
  });

  const seekBar = document.getElementById("seek-bar");
  seekBar.addEventListener("input", () => {
    seekSelected(seekBar.value).catch((e) => console.error(e));
    const timeLabel = document.getElementById("time-label");
    const t = parseFloat(seekBar.value);
    timeLabel.textContent = formatClock(Number.isFinite(t) ? t : 0);
  });
}

function wireDeselectInteractions() {
  const host = document.getElementById("mosaic-host");
  if (host) {
    host.addEventListener("click", (e) => {
      if (selectedIndex < 0 || !videoRef) return;
      if (e.target.closest(".mosaic-cell-hit")) return;
      deselectTile().catch(() => {});
    });
  }

  document.body.addEventListener("click", (e) => {
    if (selectedIndex < 0 || !videoRef) return;
    if (e.target.closest("#mosaic-host")) return;
    if (e.target.closest(".chrome")) return;
    if (e.target.closest("#help-dialog")) return;
    if (e.target.closest("#help-open")) return;
    if (e.target.closest("#show-ui-float")) return;
    deselectTile().catch(() => {});
  });
}

async function loadVideoFromInput() {
  const url = document.getElementById("video-url").value.trim();
  const ref = parseVideoRef(url);
  if (!ref) {
    alert("Paste a valid Vimeo or YouTube URL.");
    return;
  }
  lastKnownDurationSec = NaN;
  videoRef = ref;
  selectedIndex = -1;
  committedGridCols = getGridCols();
  committedGridRows = getGridRows();
  const detectedRatio = await detectSourceAspectRatio(ref);
  setTileRatioInputs(detectedRatio.w, detectedRatio.h);
  const n = committedGridRows * committedGridCols;
  tiles = Array.from({ length: n }, () => ({ t: 0 }));
  saveState();
  await render();
}

function toggleUiHidden() {
  document.body.classList.toggle("ui-hidden");
}

function wireHelpDialog() {
  const dialog = document.getElementById("help-dialog");
  const openBtn = document.getElementById("help-open");
  const closeBtn = document.getElementById("help-close");
  if (!dialog || !openBtn) return;
  openBtn.addEventListener("click", () => {
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    }
  });
  closeBtn?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
}

function init() {
  const saved = loadState();
  if (saved) {
    if (saved.videoUrl) document.getElementById("video-url").value = saved.videoUrl;
    if (saved.cols) document.getElementById("grid-cols").value = String(saved.cols);
    if (saved.rows) {
      document.getElementById("grid-rows").value = String(saved.rows);
    } else if (saved.cols && Array.isArray(saved.tiles) && saved.tiles.length > 0) {
      const c = parseInt(String(saved.cols), 10) || getGridCols();
      const r = Math.min(MAX_GRID_ROWS, Math.max(1, Math.ceil(saved.tiles.length / c)));
      document.getElementById("grid-rows").value = String(r);
    }
    if (saved.gridGap != null) document.getElementById("grid-gap").value = String(saved.gridGap);
    if (saved.gridBg) setGridBackgroundInputs(saved.gridBg);
    if (saved.ratioWidth != null || saved.ratioHeight != null) {
      setTileRatioInputs(saved.ratioWidth, saved.ratioHeight);
    }
    if (Array.isArray(saved.tiles) && saved.tiles.length > 0) {
      tiles = saved.tiles.map((t) => ({ t: Number(t) || 0 }));
    }
    if (saved.selectedIndex === -1) {
      selectedIndex = -1;
    } else if (
      Number.isFinite(saved.selectedIndex) &&
      saved.selectedIndex >= 0 &&
      saved.selectedIndex < tiles.length
    ) {
      selectedIndex = saved.selectedIndex;
    }
  }

  videoRef = parseVideoRef(document.getElementById("video-url").value.trim());
  committedGridCols = getGridCols();
  committedGridRows = getGridRows();

  if (videoRef) {
    mutateTilesToMatchGridDimensions(getGridRows(), getGridCols());
  }

  document.getElementById("load-video").addEventListener("click", () => {
    loadVideoFromInput().catch((e) => console.error(e));
  });

  document.getElementById("refresh-frames").addEventListener("click", () => {
    refreshAllTilePaints().catch((e) => console.error(e));
  });

  const onGridDimsChange = () => {
    applyGridSizeFromInputs().catch((e) => console.error(e));
  };
  document.getElementById("grid-cols").addEventListener("change", onGridDimsChange);
  document.getElementById("grid-rows").addEventListener("change", onGridDimsChange);
  document.getElementById("ratio-width").addEventListener("change", () => {
    refreshMosaicTileAspectRatioOnly();
  });
  document.getElementById("ratio-height").addEventListener("change", () => {
    refreshMosaicTileAspectRatioOnly();
  });

  document.getElementById("grid-gap").addEventListener("input", () => {
    refreshMosaicGridVisualsOnly();
  });
  document.getElementById("grid-gap").addEventListener("change", () => {
    saveState();
  });
  document.getElementById("grid-bg").addEventListener("input", () => {
    setGridBackgroundInputs(document.getElementById("grid-bg").value);
    refreshMosaicGridVisualsOnly();
  });
  document.getElementById("grid-bg-hex").addEventListener("input", () => {
    const normalized = normalizeHexColor(document.getElementById("grid-bg-hex").value);
    if (normalized) {
      setGridBackgroundInputs(normalized);
      refreshMosaicGridVisualsOnly();
    }
  });
  document.getElementById("grid-bg-hex").addEventListener("change", () => {
    setGridBackgroundInputs(getGridBackground());
    refreshMosaicGridVisualsOnly();
  });

  document.getElementById("toggle-chrome").addEventListener("click", () => toggleUiHidden());
  document.getElementById("show-ui-float").addEventListener("click", () => {
    document.body.classList.remove("ui-hidden");
  });

  wireHelpDialog();
  wireTransportControls();
  wireDeselectInteractions();
  setGridBackgroundInputs(getGridBackground());

  document.addEventListener("keydown", (e) => {
    const helpDialog = document.getElementById("help-dialog");
    if (helpDialog?.open) {
      if (e.key === "Escape") {
        e.preventDefault();
        helpDialog.close();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (document.activeElement && typeof document.activeElement.blur === "function") {
        document.activeElement.blur();
      }
      deselectTile().catch(() => {});
      return;
    }
    if (e.target.matches("input, textarea, select")) return;
    if (e.key === "?" || (e.shiftKey && e.key === "/")) {
      e.preventDefault();
      if (typeof helpDialog?.showModal === "function") {
        helpDialog.showModal();
      }
      return;
    }
    if (e.key === "h" || e.key === "H") {
      e.preventDefault();
      toggleUiHidden();
    }
    if (e.key === " ") {
      if (selectedIndex < 0) return;
      e.preventDefault();
      togglePlayPause().catch(() => {});
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      removeSelectedTile().catch(() => {});
    }
  });

  if (videoRef) {
    render().catch((e) => console.error(e));
  } else {
    document.getElementById("mosaic-host").innerHTML =
      '<p class="hint" style="margin:0;color:var(--muted)">Load a valid Vimeo or YouTube URL to begin.</p>';
    setTransportEnabled(false);
    setDurationBadge(NaN);
    updateTransportPanelVisibility();
  }

  if (selectedIndex >= 0 && selectedIndex >= tiles.length) {
    selectedIndex = Math.max(0, tiles.length - 1);
  }

  updateTransportPanelVisibility();
}

document.addEventListener("DOMContentLoaded", init);
