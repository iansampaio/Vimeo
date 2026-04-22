/**
 * Internal mosaic tool — Vimeo + YouTube embeds at per-cell times.
 */

const STORAGE_KEY = "vimeo-mosaic-tool-v1";

/** YouTube API player instances for mosaic tiles (cell index → player). */
const ytMosaicPlayers = new Map();

function parseTimeToSeconds(str) {
  if (str == null || String(str).trim() === "") return 0;
  const s = String(str).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const m = s.match(/^(\d+):(\d{1,2})(?:\.(\d+))?$/);
  if (m) {
    const min = parseInt(m[1], 10);
    const sec = parseInt(m[2], 10);
    const frac = m[3] ? parseFloat("0." + m[3]) : 0;
    return min * 60 + sec + frac;
  }
  const m2 = s.match(/^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/);
  if (m2) {
    const h = parseInt(m2[1], 10);
    const min = parseInt(m2[2], 10);
    const sec = parseInt(m2[3], 10);
    const frac = m2[4] ? parseFloat("0." + m2[4]) : 0;
    return h * 3600 + min * 60 + sec + frac;
  }
  return NaN;
}

function formatSeconds(sec) {
  if (!Number.isFinite(sec)) return "";
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const whole = Math.floor(r);
  const fracPart = Math.round((r - whole) * 100);
  const frac = String(fracPart).padStart(2, "0");
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${frac}`;
  }
  return `${m}:${String(whole).padStart(2, "0")}.${frac}`;
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

/**
 * Vimeo accepts #t=20 (seconds) or #t=1m2s — not #t=20s (the trailing "s" breaks parsing).
 * @see https://help.vimeo.com/hc/en-us/articles/12425821012497
 */
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

function vimeoEmbedSrc({ id, h }, seconds, { controls = true, mosaicCell = null } = {}) {
  const params = new URLSearchParams({
    badge: "0",
    autopause: "0",
    muted: "1",
    title: "0",
    byline: "0",
    portrait: "0",
  });
  if (controls) {
    params.set("controls", "1");
  } else {
    params.set("controls", "0");
  }
  if (h) params.set("h", h);
  if (mosaicCell != null) params.set("player_id", `mosaic_${mosaicCell}`);
  const base = `https://player.vimeo.com/video/${id}?${params.toString()}`;
  return `${base}${vimeoTimeFragment(seconds)}`;
}

function youtubeEmbedSrc({ id }, seconds, { controls = true } = {}) {
  const start = Math.max(0, Math.floor(seconds));
  const params = new URLSearchParams({
    start: String(start),
    rel: "0",
    modestbranding: "1",
    playsinline: "1",
    controls: controls ? "1" : "0",
  });
  return `https://www.youtube.com/embed/${id}?${params.toString()}`;
}

function embedSrc(ref, seconds, opts) {
  if (!ref) return "";
  return ref.provider === "vimeo"
    ? vimeoEmbedSrc(ref, seconds, opts)
    : youtubeEmbedSrc(ref, seconds, opts);
}

/** Wait until Vimeo reports seek finished (frame matches timecode better than pausing immediately). */
function waitForVimeoSeeked(player) {
  return new Promise((resolve) => {
    const handler = () => {
      player.off("seeked", handler);
      resolve();
    };
    player.on("seeked", handler);
  });
}

function nextFrameLayout() {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

let ytApiPromise = null;
let draggablePromise = null;
let mosaicSortable = null;

/** CDN bundle exposes `{ default: Sortable }` on `window.Sortable`. */
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

function getState() {
  const videoUrl = document.getElementById("video-url").value.trim();
  const rows = Math.max(1, parseInt(document.getElementById("rows").value, 10) || 2);
  const cols = Math.max(1, parseInt(document.getElementById("cols").value, 10) || 2);
  const hideControls = document.getElementById("hide-mosaic-controls").checked;
  const ref = parseVideoRef(videoUrl);
  const n = rows * cols;
  const times = [];
  for (let i = 0; i < n; i++) {
    const inp = document.getElementById(`time-${i}`);
    const v = inp ? inp.value : "0";
    times.push(parseTimeToSeconds(v));
  }
  return { videoUrl, rows, cols, hideControls, ref, times, n };
}

function saveState() {
  try {
    const s = getState();
    const payload = {
      videoUrl: s.videoUrl,
      rows: s.rows,
      cols: s.cols,
      hideControls: s.hideControls,
      times: s.times.map((t, i) => {
        const inp = document.getElementById(`time-${i}`);
        return inp ? inp.value : String(t);
      }),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (_) {}
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p.videoUrl) document.getElementById("video-url").value = p.videoUrl;
    if (p.rows) document.getElementById("rows").value = p.rows;
    if (p.cols) document.getElementById("cols").value = p.cols;
    if (typeof p.hideControls === "boolean") {
      document.getElementById("hide-mosaic-controls").checked = p.hideControls;
    }
    return p;
  } catch {
    return null;
  }
}

function buildMomentsTable(rows, cols, prevTimes) {
  const n = rows * cols;
  const tbody = document.querySelector("#moments-tbody");
  tbody.replaceChildren();
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const tr = document.createElement("tr");

    const td0 = document.createElement("td");
    td0.textContent = String(i);
    tr.appendChild(td0);

    const td1 = document.createElement("td");
    td1.textContent = `${r + 1}×${c + 1} (row ${r + 1}, col ${c + 1})`;
    tr.appendChild(td1);

    const td2 = document.createElement("td");
    const inp = document.createElement("input");
    inp.type = "text";
    inp.id = `time-${i}`;
    inp.placeholder = "mm:ss or seconds";
    const defaultT =
      prevTimes && prevTimes[i] !== undefined
        ? typeof prevTimes[i] === "number"
          ? formatSeconds(prevTimes[i])
          : String(prevTimes[i])
        : i === 0
          ? "0"
          : "";
    inp.value = defaultT;
    inp.addEventListener("change", saveState);
    td2.appendChild(inp);
    tr.appendChild(td2);

    const td3 = document.createElement("td");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-jump";
    btn.textContent = "Preview";
    btn.addEventListener("click", () => {
      document.getElementById("active-cell").value = String(i);
      previewAtCell(i);
    });
    td3.appendChild(btn);
    tr.appendChild(td3);

    tbody.appendChild(tr);
  }
}

async function seekVimeoIframeToTime(iframe, rawSeconds, { loadApi = true } = {}) {
  if (loadApi) await loadVimeoAPI();
  const target = Math.max(0, Number.isFinite(rawSeconds) ? rawSeconds : 0);
  const player = new window.Vimeo.Player(iframe);
  await player.ready();
  await player.setCurrentTime(target);
  if (target > 0.05) {
    await waitForVimeoSeeked(player);
  }
  await player.pause();
  return player.getCurrentTime();
}

async function seekVimeoMosaicCells(grid, times) {
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
      const target = Math.max(0, t);
      try {
        await seekVimeoIframeToTime(iframe, t, { loadApi: false });
      } catch (err) {
        console.warn("Vimeo seek failed for cell", i, err);
      }
    })
  );
}

async function mountYouTubeMosaicPlayers(grid, ref, times, hideControls, renderId) {
  await loadYouTubeAPI();
  await nextFrameLayout();
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
          new window.YT.Player(div.id, {
            width: w,
            height: h,
            videoId: ref.id,
            playerVars: {
              start,
              rel: 0,
              modestbranding: 1,
              playsinline: 1,
              controls: hideControls ? 0 : 1,
              fs: 1,
            },
            events: {
              onReady: (e) => {
                e.target.seekTo(start, true);
                e.target.pauseVideo();
                ytMosaicPlayers.set(i, e.target);
                resolve();
              },
            },
          });
        })
    )
  );
}

async function renderMosaic() {
  const { ref, rows, cols, times, hideControls, n } = getState();
  ytMosaicPlayers.clear();
  const host = document.getElementById("mosaic-host");
  host.innerHTML = "";

  if (!ref) {
    host.innerHTML =
      '<p class="hint" style="margin:0;color:var(--muted)">Set a valid Vimeo or YouTube URL first.</p>';
    return;
  }

  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(times[i])) {
      host.innerHTML = `<p class="hint" style="margin:0;color:var(--danger)">Invalid time for cell ${i}.</p>`;
      return;
    }
  }

  const grid = document.createElement("div");
  grid.id = "mosaic-root";
  grid.className = "mosaic-grid";
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  const renderId = Date.now();

  for (let i = 0; i < n; i++) {
    const cell = document.createElement("div");
    cell.className = "mosaic-cell";
    cell.dataset.cellIndex = String(i);
    const dragHandle = document.createElement("button");
    dragHandle.type = "button";
    dragHandle.className = "mosaic-cell-drag-handle";
    dragHandle.title = "Drag tile to reorder";
    dragHandle.textContent = "↕";
    cell.appendChild(dragHandle);
    if (ref.provider === "youtube") {
      const mount = document.createElement("div");
      mount.id = `yt-mosaic-${renderId}-${i}`;
      mount.setAttribute("data-yt-mosaic", "1");
      mount.dataset.index = String(i);
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
      iframe.src = embedSrc(ref, times[i], { controls: !hideControls, mosaicCell: i });
      cell.appendChild(iframe);
    }
    grid.appendChild(cell);
  }

  host.appendChild(grid);

  if (ref.provider === "vimeo") {
    await seekVimeoMosaicCells(grid, times);
  } else {
    await mountYouTubeMosaicPlayers(grid, ref, times, hideControls, renderId);
  }

  await enableMosaicReorder(grid);
  saveState();
}

function updateTileOrderAfterSort(grid) {
  const { rows, cols, times } = getState();
  const orderedOldIndexes = Array.from(grid.querySelectorAll(".mosaic-cell")).map((cell) =>
    parseInt(cell.dataset.cellIndex, 10)
  );
  if (orderedOldIndexes.length !== times.length || orderedOldIndexes.some((i) => !Number.isFinite(i))) {
    return;
  }
  const nextTimes = orderedOldIndexes.map((oldIndex) => times[oldIndex]);
  buildMomentsTable(rows, cols, nextTimes.map(formatSeconds));
  Array.from(grid.querySelectorAll(".mosaic-cell")).forEach((cell, i) => {
    cell.dataset.cellIndex = String(i);
  });
  saveState();
}

async function enableMosaicReorder(grid) {
  if (mosaicSortable && typeof mosaicSortable.destroy === "function") {
    mosaicSortable.destroy();
    mosaicSortable = null;
  }
  try {
    await loadDraggableAPI();
    const SortableCtor = getShopifySortableCtor();
    if (!SortableCtor) {
      throw new Error("window.Sortable missing after script load");
    }
    mosaicSortable = new SortableCtor([grid], {
      draggable: ".mosaic-cell",
      handle: ".mosaic-cell-drag-handle",
      distance: 10,
      mirror: {
        constrainDimensions: true,
      },
    });
    mosaicSortable.on("sortable:stop", () => {
      updateTileOrderAfterSort(grid);
    });
  } catch (e) {
    console.warn("Could not enable drag reorder", e);
  }
}

async function previewAtCell(cellIndex) {
  const { ref, times, hideControls, n } = getState();
  if (!ref) {
    alert("Paste a Vimeo or YouTube URL first.");
    return;
  }
  const inp = document.getElementById(`time-${cellIndex}`);
  const sec = inp ? parseTimeToSeconds(inp.value) : times[cellIndex];
  if (!Number.isFinite(sec)) {
    alert("Invalid time for this cell.");
    return;
  }

  document.getElementById("active-cell").value = String(cellIndex);
  const grid = document.getElementById("mosaic-root");
  const cellCount = grid ? grid.querySelectorAll(".mosaic-cell").length : 0;
  if (!grid || cellCount !== n) {
    await renderMosaic();
    return;
  }

  const cells = grid.querySelectorAll(".mosaic-cell");
  const cell = cells[cellIndex];
  if (!cell) return;

  if (ref.provider === "vimeo") {
    const iframe = cell.querySelector("iframe");
    if (!iframe) return;
    iframe.src = embedSrc(ref, sec, { controls: !hideControls, mosaicCell: cellIndex });
    try {
      await seekVimeoIframeToTime(iframe, sec);
    } catch (e) {
      console.warn("preview seek failed", e);
    }
  } else {
    const p = ytMosaicPlayers.get(cellIndex);
    if (p && p.seekTo) {
      p.seekTo(Math.floor(Math.max(0, sec)), true);
      p.pauseVideo();
    } else {
      await renderMosaic();
    }
  }
}

async function captureTimeToActiveCell() {
  const { ref } = getState();
  if (!ref) return;
  const ac = parseInt(document.getElementById("active-cell").value, 10);
  if (!Number.isFinite(ac) || ac < 0) return;

  const grid = document.getElementById("mosaic-root");
  const cells = grid?.querySelectorAll(".mosaic-cell");
  const cell = cells?.[ac];
  if (!cell) {
    alert("Render the grid first (Render / refresh grid), then scrub a tile and capture.");
    return;
  }

  let t = null;
  if (ref.provider === "vimeo") {
    const iframe = cell.querySelector("iframe");
    if (!iframe) return;
    try {
      await loadVimeoAPI();
      const player = new window.Vimeo.Player(iframe);
      await player.ready();
      t = await player.getCurrentTime();
    } catch (_) {
      t = null;
    }
  } else {
    const p = ytMosaicPlayers.get(ac);
    if (p && typeof p.getCurrentTime === "function") {
      t = p.getCurrentTime();
    }
  }

  if (t == null || !Number.isFinite(t)) {
    alert("Could not read current time from that tile — render the grid and try again.");
    return;
  }
  const inp = document.getElementById(`time-${ac}`);
  if (inp) {
    inp.value = formatSeconds(t);
    saveState();
  }
}

function toggleUiHidden() {
  document.body.classList.toggle("ui-hidden");
}

function init() {
  const saved = loadState();
  const rows = saved && saved.rows ? saved.rows : 2;
  const cols = saved && saved.cols ? saved.cols : 2;
  document.getElementById("rows").value = rows;
  document.getElementById("cols").value = cols;

  let prevTimes = null;
  if (saved && saved.times && saved.times.length === rows * cols) {
    prevTimes = saved.times;
  }
  buildMomentsTable(rows, cols, prevTimes);

  document.getElementById("apply-grid").addEventListener("click", () => {
    const r = Math.max(1, parseInt(document.getElementById("rows").value, 10) || 2);
    const c = Math.max(1, parseInt(document.getElementById("cols").value, 10) || 2);
    const old = getState().times;
    const oldN = old.length;
    const n = r * c;
    const next = [];
    for (let i = 0; i < n; i++) {
      next.push(i < oldN ? old[i] : 0);
    }
    buildMomentsTable(r, c, next.map(formatSeconds));
    saveState();
    renderMosaic().catch((e) => console.error(e));
  });

  document.getElementById("render-mosaic").addEventListener("click", () => {
    renderMosaic().catch((e) => console.error(e));
  });

  document.getElementById("capture-time").addEventListener("click", () => captureTimeToActiveCell());

  document.getElementById("toggle-chrome").addEventListener("click", () => {
    toggleUiHidden();
  });

  document.getElementById("show-ui-float").addEventListener("click", () => {
    document.body.classList.remove("ui-hidden");
  });

  const videoUrlInput = document.getElementById("video-url");
  videoUrlInput.addEventListener("change", saveState);
  videoUrlInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    saveState();
    renderMosaic().catch((err) => console.error(err));
  });
  document.getElementById("rows").addEventListener("change", saveState);
  document.getElementById("cols").addEventListener("change", saveState);
  document.getElementById("hide-mosaic-controls").addEventListener("change", () => {
    saveState();
    if (document.getElementById("mosaic-root")) {
      renderMosaic().catch((e) => console.error(e));
    }
  });

  document.getElementById("active-cell").addEventListener("change", () => {
    const i = parseInt(document.getElementById("active-cell").value, 10);
    if (Number.isFinite(i)) previewAtCell(i);
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    if (e.key === "h" || e.key === "H") {
      e.preventDefault();
      toggleUiHidden();
    }
  });

  if (saved && saved.videoUrl) {
    renderMosaic().catch((e) => console.error(e));
  }
}

document.addEventListener("DOMContentLoaded", init);
