/* ========================================================================
   LOCAL MUSIC APP — FICHIER UNIQUE (Vanilla JS)
   - Helpers & Icônes
   - DB (IndexedDB)
   - State & Bootstrap
   - Player & MediaSession & Queue
   - Vues (Songs / Album / Playlist / Albums Grid / Playlists Grid / Artistes / Artiste Détail)
   - CRUD (Songs + Playlists)
   - Sélection multiple
   - Autocomplete Albums
   - Aside (Playlists / Albums / Artistes)
   - Gestes Mobile
   - Recherche (Intent + Vues)
   ======================================================================== */

/* =======================
   Icônes (lucide)
   ======================= */
function setIcon(el, name, size = 20) {
  if (!el || !window.lucide || !lucide.icons?.[name]) return;
  el.innerHTML = lucide.icons[name].toSvg({ width: size, height: size });
}
function hydrateIcons(root = document) {
  const els = root.querySelectorAll?.(".i[data-i]") || [];
  els.forEach((el) =>
    setIcon(el, el.dataset.i, el.classList.contains("big") ? 28 : 20)
  );
}

/* =======================
   Helpers
   ======================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const _norm = (s) => (s || "").toLowerCase().trim();

const fmt = (s) => {
  if (!isFinite(s)) return "0:00";
  const m = (s / 60) | 0;
  const r = Math.round(s % 60);
  return `${m}:${r.toString().padStart(2, "0")}`;
};
const readAsDataURL = (f) =>
  new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.readAsDataURL(f);
  });
const supportsFS = !!(window.showOpenFilePicker || window.showDirectoryPicker);
const isAudio = (n) => /\.(mp3|m4a|aac|flac|wav|ogg)$/i.test(n);

async function dominantColor(src) {
  if (!src) return [31, 31, 40];
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = src;
  await img.decode().catch(() => {});
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  c.width = c.height = 32;
  ctx.drawImage(img, 0, 0, 32, 32);
  const data = ctx.getImageData(0, 0, 32, 32).data;
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n++;
  }
  return [(r / n) | 0, (g / n) | 0, (b / n) | 0];
}
const rgb2hex = (r, g, b) =>
  "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");

async function applyThemeFromCover(url) {
  const [r, g, b] = await dominantColor(url);
  const main = $("#main");
  if (main)
    main.style.background = `linear-gradient(180deg, rgba(${r},${g},${b},.12), transparent 240px), var(--panel-2)`;
  const nd = $("#nowDialog");
  if (nd)
    nd.style.background = `linear-gradient(180deg, rgba(${r},${g},${b},.22), var(--panel-2))`;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", rgb2hex(r, g, b));
}
async function applySongsHeaderTheme() {
  const first = state.songs.find((s) => s.coverDataUrl)?.coverDataUrl || "";
  const [r, g, b] = await dominantColor(first);
  const sh = $("#songsHeader");
  if (sh)
    sh.style.background = `linear-gradient(180deg, rgba(${r},${g},${b},.55), transparent 180px)`;
}

/* =======================
   TABLE HEAD (standardisée)
   ======================= */
const STD_THEAD_HTML = `
  <tr>
    <th style="width:36px">#</th>
    <th>Titre</th>
    <th>Artiste</th>
    <th>Album</th>
    <th class="dur-col" style="width:90px">Durée</th>
    <th style="width:48px"></th>
    <th style="width:120px"></th>
  </tr>`;
function setStdThead(theadEl) {
  if (theadEl) theadEl.innerHTML = STD_THEAD_HTML;
}

/* =======================
   DB (IndexedDB)
   ======================= */
const DB_NAME = "local-music-db-v4";
const DB = {
  db: null,
  async open() {
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        try {
          const s = db.createObjectStore("songs", { keyPath: "id" });
          s.createIndex("by_album", "album");
        } catch {}
        try {
          db.createObjectStore("playlists", { keyPath: "id" });
        } catch {}
        try {
          db.createObjectStore("prefs", { keyPath: "k" });
        } catch {}
      };
      req.onsuccess = () => {
        this.db = req.result;
        res(this.db);
      };
      req.onerror = () => rej(req.error);
    });
  },
  tx(name, mode = "readonly") {
    return this.db.transaction(name, mode).objectStore(name);
  },
  get(name, key) {
    return new Promise((res, rej) => {
      const r = this.tx(name).get(key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  all(name) {
    return new Promise((res, rej) => {
      const r = this.tx(name).getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
  },
  put(name, val) {
    return new Promise((res, rej) => {
      const r = this.tx(name, "readwrite").put(val);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  },
  del(name, key) {
    return new Promise((res, rej) => {
      const r = this.tx(name, "readwrite").delete(key);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  },
};

/* =======================
   State
   ======================= */
const state = {
  scope: { type: "all" }, // all | fav | albumGrid | playlistGrid | artistGrid | albumDetail | playlistDetail | artistDetail | globalSearch
  songs: [],
  favorites: new Set(),
  queue: [],
  currentIndex: -1,
  shuffle: false,
  repeat: "off",
  currentPlaylistId: null,
  // multi-select
  selectMode: false,
  selection: new Set(),
};

let audio = new Audio();
audio.preload = "metadata";

/* =======================
   Queue helpers
   ======================= */
function _currentListForScope() {
  const q = ($("#search")?.value || "").toLowerCase();
  let list = state.songs.slice();
  if (state.scope.type === "playlistDetail") {
    const ids = state.scope.ids || [];
    list = ids
      .map((id) => state.songs.find((s) => s.id === id))
      .filter(Boolean);
  } else if (state.scope.type === "playlist") {
    const ids = state.scope.ids || [];
    list = list.filter((s) => ids.includes(s.id));
  } else if (state.scope.type === "fav") {
    list = list.filter((s) => state.favorites.has(s.id));
  } else if (state.scope.type === "albumDetail") {
    const n = (state.scope.name || "").toLowerCase();
    list = list.filter((s) => (s.album || "").toLowerCase() === n);
  } else if (state.scope.type === "artistDetail") {
    const n = (state.scope.name || "").toLowerCase();
    list = list.filter((s) => (s.artist || "").toLowerCase() === n);
  } else if (state.scope.type === "globalSearch") {
    list = (state.scope.songs || []).slice();
  }
  if (q)
    list = list.filter((s) =>
      (s.name + " " + (s.artist || "") + " " + (s.album || ""))
        .toLowerCase()
        .includes(q)
    );
  return list;
}
function rebuildQueue() {
  const list = _currentListForScope();
  state.queue = list.map((s) => s.id);
  if (state.shuffle) {
    for (let i = state.queue.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
    }
  }
}
window.rebuildQueue = rebuildQueue;

/* =======================
   Media Session
   ======================= */
function setMediaSession(song) {
  if (!("mediaSession" in navigator)) return;
  const artwork = song.coverDataUrl
    ? [
        { src: song.coverDataUrl, sizes: "96x96", type: "image/png" },
        { src: song.coverDataUrl, sizes: "256x256", type: "image/png" },
        { src: song.coverDataUrl, sizes: "312x312", type: "image/png" },
      ]
    : [];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.name || "—",
    artist: song.artist || "",
    album: song.album || "",
    artwork,
  });
  try {
    navigator.mediaSession.setActionHandler("play", () => play());
    navigator.mediaSession.setActionHandler("pause", () => pause());
    navigator.mediaSession.setActionHandler("previoustrack", () => prev());
    navigator.mediaSession.setActionHandler("nexttrack", () => next());
    navigator.mediaSession.setActionHandler("seekbackward", (d) => {
      audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10));
    });
    navigator.mediaSession.setActionHandler("seekforward", (d) => {
      audio.currentTime = Math.min(
        audio.duration || 0,
        audio.currentTime + (d.seekOffset || 10)
      );
    });
    navigator.mediaSession.setActionHandler("seekto", (d) => {
      if (d.fastSeek && "fastSeek" in audio) audio.fastSeek(d.seekTime);
      else audio.currentTime = d.seekTime;
    });
    navigator.mediaSession.setActionHandler("stop", () => {
      pause();
      audio.currentTime = 0;
    });
  } catch {}
}
function updatePositionState() {
  if (
    !("mediaSession" in navigator) ||
    !("setPositionState" in navigator.mediaSession)
  )
    return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration || 0,
      playbackRate: audio.playbackRate || 1,
      position: audio.currentTime || 0,
    });
  } catch {}
}

/* =======================
   Bootstrap
   ======================= */
(async function () {
  hydrateIcons(document);
  await DB.open();

  const favs = await DB.get("prefs", "favorites");
  if (favs) state.favorites = new Set(favs.val);

  state.songs = await DB.all("songs");

  renderPlaylists(); // aside playlists
  renderSideAlbums(); // aside albums
  renderSideArtists(); // aside artistes

  setScope({ type: "all" });
  bindUI();
  attachAlbumAutocomplete();
})();

/* =======================
   UI Bindings
   ======================= */
function bindUI() {
  $("#btnFavorites") &&
    ($("#btnFavorites").onclick = () => setScope({ type: "fav" }));
  $("#btnAlbums") && ($("#btnAlbums").onclick = showAlbums);
  $("#btnPlaylists") && ($("#btnPlaylists").onclick = showPlaylists);
  $("#btnArtists") && ($("#btnArtists").onclick = showArtists);
  const newPlBtn = document.getElementById("btnNewPlaylist");
  if (newPlBtn) newPlBtn.onclick = openNewPlaylistDialog;
  initProgressUI();

  $("#bulkSelectAll") && ($("#bulkSelectAll").onclick = selectAllVisible);
  $("#bulkDelete") && ($("#bulkDelete").onclick = deleteSelectedSongs);
  $("#bulkCancel") && ($("#bulkCancel").onclick = () => enterSelectMode(false));
  // new:
  $("#bulkAddToPlaylists") &&
    ($("#bulkAddToPlaylists").onclick = addSelectedToPlaylists);

  // Song dialog widgets
  $("#btnAddSong") && ($("#btnAddSong").onclick = () => songDialog.showModal());
  $("#songCover")?.addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (f) $("#songCoverPreview").src = await readAsDataURL(f);
  });
  $("#saveSong")?.addEventListener("click", saveSongFromForm);
  $("#btnEnterSelect") &&
    ($("#btnEnterSelect").onclick = () => enterSelectMode(true));

  // Player controls
  $("#volume") &&
    ($("#volume").oninput = (e) => {
      audio.volume = +e.target.value;
      e.target.style.setProperty(
        "--_val",
        Math.floor(+e.target.value * 100) + "%"
      );
    });
  $("#seek") &&
    ($("#seek").oninput = (e) => {
      const pos = +e.target.value / 1000;
      if (audio.duration) audio.currentTime = pos * audio.duration;
      e.target.style.setProperty("--_val", e.target.value / 10 + "%");
    });
  $("#btnShuffle") &&
    ($("#btnShuffle").onclick = () => {
      state.shuffle = !state.shuffle;
      document
        .querySelectorAll("#btnShuffle,#npShuffle")
        .forEach((b) => b?.classList.toggle("primary", state.shuffle));
      rebuildQueue();
    });
  $("#btnRepeat") &&
    ($("#btnRepeat").onclick = () => {
      state.repeat =
        state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
      const on = state.repeat !== "off";
      document
        .querySelectorAll("#btnRepeat,#npRepeat")
        .forEach((b) => b?.classList.toggle("primary", on));
    });
  $("#btnPrev") && ($("#btnPrev").onclick = prev);
  $("#btnNext") && ($("#btnNext").onclick = next);
  $("#btnPlay") && ($("#btnPlay").onclick = smartPlay);
  $("#btnExpand") &&
    ($("#btnExpand").onclick = () => $("#nowDialog")?.showModal());
  $("#btnLike") && ($("#btnLike").onclick = toggleLikeCurrent);

  // Big header play
  $("#songsPlayBig") &&
    ($("#songsPlayBig").onclick = () => {
      rebuildQueue();
      if (state.queue.length) playIndex(0);
    });

  // Fullscreen player mirror
  $("#npShuffle") && ($("#npShuffle").onclick = () => $("#btnShuffle").click());
  $("#npPrev") && ($("#npPrev").onclick = () => $("#btnPrev").click());
  $("#npNext") && ($("#npNext").onclick = () => $("#btnNext").click());
  $("#npRepeat") && ($("#npRepeat").onclick = () => $("#btnRepeat").click());
  $("#npPlay") && ($("#npPlay").onclick = () => $("#btnPlay").click());
  $("#npSeek") &&
    ($("#npSeek").oninput = (e) => {
      const p = +e.target.value / 1000;
      if (audio.duration) audio.currentTime = p * audio.duration;
      e.target.style.setProperty("--_val", e.target.value / 10 + "%");
    });

  // Audio events
  audio.addEventListener("timeupdate", () => {
    $("#cur") && ($("#cur").textContent = fmt(audio.currentTime));
    $("#dur") && ($("#dur").textContent = fmt(audio.duration || 0));
    if (audio.duration) {
      const val = Math.floor((audio.currentTime / audio.duration) * 1000);
      ["#seek", "#npSeek"].forEach((sel) => {
        const el = $(sel);
        if (el) {
          el.value = val;
          el.style.setProperty("--_val", val / 10 + "%");
        }
      });
    }
    $("#npCur") && ($("#npCur").textContent = fmt(audio.currentTime));
    $("#npDur") && ($("#npDur").textContent = fmt(audio.duration || 0));
    updatePositionState();
  });
  audio.addEventListener("play", () => {
    if ("mediaSession" in navigator)
      navigator.mediaSession.playbackState = "playing";
    updatePositionState();
  });
  audio.addEventListener("pause", () => {
    if ("mediaSession" in navigator)
      navigator.mediaSession.playbackState = "paused";
    updatePositionState();
  });
  audio.addEventListener("ended", () => {
    if (state.repeat === "one") playIndex(state.currentIndex);
    else next();
  });
  audio.addEventListener("loadedmetadata", () => {
    syncProgressFromAudio();
  });

  // Drawer mobile
  $("#btnToggleAside") && ($("#btnToggleAside").onclick = toggleAside);
  $("#drawerMask") && ($("#drawerMask").onclick = closeAside);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAside();
  });

  // Sélection multiple
  $("#btnEnterSelect") &&
    ($("#btnEnterSelect").onclick = () => enterSelectMode(true));
  $("#bulkSelectAll") && ($("#bulkSelectAll").onclick = selectAllVisible);
  $("#bulkDelete") && ($("#bulkDelete").onclick = deleteSelectedSongs);
  $("#bulkCancel") && ($("#bulkCancel").onclick = () => enterSelectMode(false));

  // Boutons play/pause UI sync
  document.querySelectorAll("#btnPlay,#npPlay").forEach((btn) =>
    btn.addEventListener("click", () => {
      document.querySelectorAll("#btnPlay,#npPlay").forEach((b) => {
        const isPlay = !!b.querySelector(".lucide-play");
        b.innerHTML = isPlay
          ? `<span><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pause"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg></span>`
          : `<span><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-play"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/></svg></span>`;
        b.title = isPlay ? "Pause" : "Lire";
      });
    })
  );
}

/* =======================
   Drawer mobile
   ======================= */
function toggleAside() {
  document.body.classList.toggle("aside-open");
  const open = document.body.classList.contains("aside-open");
  if ($("#drawerMask")) $("#drawerMask").hidden = !open;
  requestAnimationFrame(
    () => $("#drawerMask") && $("#drawerMask").classList.toggle("show", open)
  );
}
function closeAside() {
  document.body.classList.remove("aside-open");
  $("#drawerMask") && $("#drawerMask").classList.remove("show");
  setTimeout(() => $("#drawerMask") && ($("#drawerMask").hidden = true), 160);
}

/* ========================================================================
   VUES — INFRA GÉNÉRIQUE (helpers de rendu)
   ======================================================================== */

// Construit la cellule "Titre" (cover + lignes)
function songTitleCellHTML(s, subPref = "album") {
  const cover = s.coverDataUrl ? `<img src="${s.coverDataUrl}" alt="">` : "🎵";
  const sub = subPref === "album" ? s.album || "Sans album" : s.artist || "—";
  return `
    <div class="song">
      <div class="thumb">${cover}</div>
      <div style="display:grid;min-width:0">
        <div style="font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
          ${s.name || "(sans titre)"}
        </div>
        <div class="muted" style="font-size:.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
          ${sub}
        </div>
      </div>
    </div>`;
}

// Construit une ligne <tr> harmonisée (desktop)
function buildSongRow(s, index) {
  const checked = state.selection.has(s.id) ? "checked" : "";
  const selCell = state.selectMode
    ? `<input type="checkbox" class="sel" ${checked} data-sel="${s.id}">`
    : index + 1;

  const likeBtn = state.selectMode
    ? ""
    : `<button class="btn icon" data-like="${s.id}">
         <span class="i" data-i="heart"></span>
       </button>`;

  const actions = state.selectMode
    ? ""
    : `
    <button class="btn icon" title="Ajouter à une playlist" data-addtopl="${s.id}">
      <span class="i" data-i="plus"></span>
    </button>
    <button class="btn icon" title="Modifier" data-edit="${s.id}">
      <span class="i" data-i="pen-line"></span>
    </button>
    <button class="btn icon inline-del" title="Supprimer" data-del="${s.id}">
      <span class="i" data-i="trash-2"></span>
    </button>`;

  const tr = document.createElement("tr");
  tr.className = "row";
  tr.dataset.id = s.id;
  tr.innerHTML = `
    <td>${selCell}</td>
    <td>${songTitleCellHTML(s, "album")}</td>
    <td>${s.artist || "—"}</td>
    <td>${s.album || "—"}</td>
    <td class="dur-cell"><span>${s.duration ? fmt(s.duration) : "—"}</span></td>
    <td>${likeBtn}</td>
    <td style="display:flex;gap:6px;justify-content:flex-end">${actions}</td>`;

  tr.onclick = (e) => {
    if (e.target.closest("button") || e.target.closest("input.sel")) return;
    if (!state.selectMode) playById(s.id);
  };

  return tr;
}

// Branche les handlers (like / add / edit / delete / select) sur un conteneur
function wireSongRowActions(scopeEl) {
  $$("input.sel", scopeEl).forEach((cb) => {
    cb.onchange = () => toggleSelect(cb.dataset.sel, cb.checked);
  });
  $$("[data-like]", scopeEl).forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      toggleLike(b.dataset.like, b);
    };
  });
  $$("[data-addtopl]", scopeEl).forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      openAddToPlaylistDialog(b.dataset.addtopl);
    };
  });
  $$("[data-edit]", scopeEl).forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      openEditSong(b.dataset.edit);
    };
  });
  $$("[data-del]", scopeEl).forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      deleteSong(b.dataset.del);
    };
  });
}

/* ========================================================================
   VUES — ROUTAGE
   ======================================================================== */
function setScope(scope) {
  state.scope = scope;
  // Hide all known views
  [
    "#viewSongs",
    "#viewAlbums",
    "#viewPlaylists",
    "#viewArtists",
    "#albumView",
    "#playlistView",
    "#artistView",
  ].forEach((sel) => {
    const el = $(sel);
    if (el) el.style.display = "none";
  });

  // Also hide search view if present
  const sv = $("#searchView");
  if (sv) sv.style.display = "none";

  if (scope.type === "albumGrid") {
    $("#viewAlbums") && ($("#viewAlbums").style.display = "block");
    $("#currentScope") && ($("#currentScope").textContent = "Albums");
    renderAlbums();
  } else if (scope.type === "playlistGrid") {
    $("#viewPlaylists") && ($("#viewPlaylists").style.display = "block");
    $("#currentScope") && ($("#currentScope").textContent = "Playlists");
    renderPlaylistsGrid();
  } else if (scope.type === "artistGrid") {
    $("#viewArtists") && ($("#viewArtists").style.display = "block");
    $("#currentScope") && ($("#currentScope").textContent = "Artistes");
    renderArtists();
  } else if (scope.type === "albumDetail") {
    $("#albumView") && ($("#albumView").style.display = "block");
    $("#currentScope") &&
      ($("#currentScope").textContent = "Album – " + (scope.name || ""));
    renderAlbumDetail(scope.name);
  } else if (scope.type === "playlistDetail") {
    $("#playlistView") && ($("#playlistView").style.display = "block");
    $("#currentScope") &&
      ($("#currentScope").textContent = "Playlist – " + (scope.name || ""));
    renderPlaylistDetail(state.currentPlaylistId);
  } else if (scope.type === "artistDetail") {
    $("#artistView") && ($("#artistView").style.display = "block");
    $("#currentScope") &&
      ($("#currentScope").textContent = "Artiste – " + (scope.name || ""));
    renderArtistDetail(scope.name);
  } else if (scope.type === "globalSearch") {
    // géré par renderGlobalSearchResults
  } else {
    $("#viewSongs") && ($("#viewSongs").style.display = "block");
    $("#currentScope") &&
      ($("#currentScope").textContent =
        scope.type === "fav" ? "Favoris" : "Musique");
    renderSongs();
  }
  rebuildQueue();
}
function showAlbums() {
  setScope({ type: "albumGrid" });
}
function showPlaylists() {
  setScope({ type: "playlistGrid" });
}
function showArtists() {
  setScope({ type: "artistGrid" });
}
function showAlbumDetail(name) {
  setScope({ type: "albumDetail", name });
}
async function showPlaylistDetail(id) {
  state.currentPlaylistId = id;
  const pl = await DB.get("playlists", id);
  const name = pl?.name || "—";
  setScope({ type: "playlistDetail", id, name, ids: pl?.ids || [] });
}
function showArtistDetail(name) {
  setScope({ type: "artistDetail", name });
}

/* ========================================================================
   VUES — ASIDE (albums / artistes) & GRILLES
   ======================================================================== */
function groupAlbums() {
  const map = new Map();
  state.songs.forEach((s) => {
    const k = (s.album || "Sans album").trim();
    if (!map.has(k))
      map.set(k, {
        name: k,
        count: 0,
        cover: s.coverDataUrl || "",
        artist: s.artist || "",
      });
    const a = map.get(k);
    a.count++;
    if (!a.cover && s.coverDataUrl) a.cover = s.coverDataUrl;
  });
  return new Map([...map.entries()].sort((a, b) => b[1].count - a[1].count));
}
function groupArtists() {
  const map = new Map();
  state.songs.forEach((s) => {
    const k = (s.artist || "—").trim();
    if (!k) return;
    if (!map.has(k))
      map.set(k, { name: k, count: 0, cover: s.coverDataUrl || "" });
    const a = map.get(k);
    a.count++;
    if (!a.cover && s.coverDataUrl) a.cover = s.coverDataUrl;
  });
  return new Map([...map.entries()].sort((a, b) => b[1].count - a[1].count));
}

function renderSideAlbums() {
  const side = $("#sideAlbums");
  if (!side) return;
  side.innerHTML = "";
  const map = groupAlbums();
  let i = 0;
  for (const al of map.values()) {
    if (i++ >= 8) break;
    const d = document.createElement("div");
    d.className = "cover-sm";
    d.title = al.name;
    d.innerHTML = `<img src="${al.cover || ""}" alt="">`;
    d.onclick = () => {
      showAlbumDetail(al.name);
      closeAside();
    };
    side.appendChild(d);
  }
}
function renderSideArtists() {
  const side = $("#sideArtists");
  if (!side) return;
  side.innerHTML = "";
  const map = groupArtists();
  let i = 0;
  for (const ar of map.values()) {
    if (i++ >= 8) break;
    const d = document.createElement("div");
    d.className = "cover-sm";
    d.title = ar.name;
    d.innerHTML = `<img src="${ar.cover || ""}" alt="">`;
    d.onclick = () => {
      showArtistDetail(ar.name);
      closeAside();
    };
    side.appendChild(d);
  }
}
function renderAlbums() {
  const grid = $("#albumGrid");
  if (!grid) return;
  grid.innerHTML = "";
  const map = groupAlbums();
  [...map.values()].forEach((al) => {
    const div = document.createElement("div");
    div.className = "card";
    div.innerHTML = `<img class="cv" src="${al.cover || ""}" alt="">
      <div class="ttl">${al.name}</div><div class="sub">${
      al.count
    } titres</div>`;
    div.onclick = () => showAlbumDetail(al.name);
    grid.appendChild(div);
  });
}
function renderArtists() {
  const grid = $("#artistGrid");
  if (!grid) return;
  grid.innerHTML = "";
  const map = groupArtists();
  [...map.values()].forEach((ar) => {
    const div = document.createElement("div");
    div.className = "card";
    div.innerHTML = `<img class="cv" src="${ar.cover || ""}" alt="">
      <div class="ttl">${ar.name}</div>
      <div class="sub">${ar.count} titre(s)</div>`;
    div.onclick = () => showArtistDetail(ar.name);
    grid.appendChild(div);
  });
}

/* ========================================================================
   VUE — LISTE DES TITRES (Musique)
   ======================================================================== */
async function renderSongs() {
  let list = state.songs.slice();

  if (state.scope.type === "playlist") {
    const ids = state.scope.ids || [];
    list = list.filter((s) => ids.includes(s.id));
  }
  if (state.scope.type === "fav")
    list = list.filter((s) => state.favorites.has(s.id));

  const q = ($("#search")?.value || "").toLowerCase();
  if (q)
    list = list.filter((s) =>
      (s.name + " " + (s.artist || "") + " " + (s.album || ""))
        .toLowerCase()
        .includes(q)
    );

  $("#songsSubtitle") &&
    ($("#songsSubtitle").textContent = `${list.length} titre${
      list.length > 1 ? "s" : ""
    }`);
  applySongsHeaderTheme();

  // Desktop table
  setStdThead($("#songsThead"));
  const tbody = $("#songTbody");
  if (tbody) {
    tbody.innerHTML = "";
    list.forEach((s, i) => tbody.appendChild(buildSongRow(s, i)));
    hydrateIcons(tbody);
    wireSongRowActions(tbody);
  }

  // Mobile list
  const ml = $("#songListMobile");
  if (ml) {
    ml.innerHTML = "";
    list.forEach((s) => {
      const div = document.createElement("div");
      div.className = "item";
      div.dataset.id = s.id;
      div.innerHTML = `
        <div class="cover">${
          s.coverDataUrl ? `<img src="${s.coverDataUrl}" alt="">` : "🎵"
        }</div>
        <div class="meta">
          <div class="t">${s.name || "(sans titre)"}</div>
          <div class="a">${s.artist || "—"}</div>
          <div class="d">${s.duration ? fmt(s.duration) : "—"}</div>
        </div>
        <div class="actions">
          ${
            state.selectMode
              ? ""
              : `
          <button class="kebab" title="Favori" data-like="${s.id}"><span class="i" data-i="heart"></span></button>
          <button class="kebab" title="Ajouter" data-addtopl="${s.id}"><span class="i" data-i="plus"></span></button>
          <button class="kebab danger" title="Supprimer" data-del="${s.id}"><span class="i" data-i="trash-2"></span></button>`
          }
        </div>`;
      div.onclick = (e) => {
        if (e.target.closest(".actions")) return;
        if (!state.selectMode) playById(s.id);
      };
      ml.appendChild(div);
    });
    hydrateIcons(ml);
    wireSongRowActions(ml);
  }
}

/* ========================================================================
   VUE — DÉTAIL ALBUM (harmonisée)
   ======================================================================== */
async function renderAlbumDetail(name) {
  const all = state.songs.filter(
    (s) => (s.album || "").toLowerCase() === (name || "").toLowerCase()
  );

  const q = ($("#search")?.value || "").toLowerCase().trim();
  const list = q
    ? all.filter((s) =>
        (s.name + " " + (s.artist || "") + " " + (s.album || ""))
          .toLowerCase()
          .includes(q)
      )
    : all;

  const art = all[0]?.artist || "—";
  const cover = all.find((s) => s.coverDataUrl)?.coverDataUrl || "";

  $("#albumTitle") && ($("#albumTitle").textContent = name || "—");
  $("#albumSub") &&
    ($("#albumSub").textContent = `${art} • ${list.length} titre(s) • ${fmt(
      list.reduce((a, s) => a + (s.duration || 0), 0)
    )}`);
  $("#albumCover") && ($("#albumCover").src = cover);

  const [r, g, b] = await dominantColor(cover);
  const hero = $("#albumHero");
  if (hero)
    hero.style.background = `linear-gradient(180deg, rgba(${r},${g},${b},.45), transparent 420px)`;

  setStdThead($("#albumThead"));
  const tbody = $("#albumTbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  list.forEach((s, i) => tbody.appendChild(buildSongRow(s, i)));
  hydrateIcons(tbody);
  wireSongRowActions(tbody);

  $("#albumPlay") &&
    ($("#albumPlay").onclick = () => {
      state.queue = list.map((s) => s.id);
      state.currentIndex = -1;
      playIndex(0);
    });
  $("#albumShuffle") &&
    ($("#albumShuffle").onclick = () => {
      state.queue = list.map((s) => s.id);
      for (let i = state.queue.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
      }
      playIndex(0);
    });
}

/* ========================================================================
   VUE — DÉTAIL ARTISTE (harmonisée)
   ======================================================================== */
async function renderArtistDetail(name) {
  const all = state.songs.filter(
    (s) => (s.artist || "").toLowerCase() === (name || "").toLowerCase()
  );

  const q = ($("#search")?.value || "").toLowerCase().trim();
  const list = q
    ? all.filter((s) =>
        (s.name + " " + (s.artist || "") + " " + (s.album || ""))
          .toLowerCase()
          .includes(q)
      )
    : all;

  const cover = list.find((s) => s.coverDataUrl)?.coverDataUrl || "";
  $("#artistTitle") && ($("#artistTitle").textContent = name || "—");
  const totalDur = list.reduce((a, s) => a + (s.duration || 0), 0);
  $("#artistSub") &&
    ($("#artistSub").textContent = `${list.length} titre(s) • ${fmt(
      totalDur
    )}`);
  $("#artistCover") && ($("#artistCover").src = cover);

  const [r, g, b] = await dominantColor(cover);
  const hero = $("#artistHero");
  if (hero)
    hero.style.background = `linear-gradient(180deg, rgba(${r},${g},${b},.45), transparent 420px)`;

  setStdThead($("#artistThead"));
  const tbody = $("#artistTbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  list.forEach((s, i) => tbody.appendChild(buildSongRow(s, i)));
  hydrateIcons(tbody);
  wireSongRowActions(tbody);

  $("#artistPlay") &&
    ($("#artistPlay").onclick = () => {
      state.queue = list.map((s) => s.id);
      state.currentIndex = -1;
      playIndex(0);
    });
  $("#artistShuffle") &&
    ($("#artistShuffle").onclick = () => {
      state.queue = list.map((s) => s.id);
      for (let i = state.queue.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
      }
      playIndex(0);
    });

  // Albums de l’artiste (grille)
  const albumMap = new Map();
  all.forEach((s) => {
    const aln = (s.album || "Sans album").trim();
    if (!albumMap.has(aln))
      albumMap.set(aln, { name: aln, count: 0, cover: s.coverDataUrl || "" });
    const a = albumMap.get(aln);
    a.count++;
    if (!a.cover && s.coverDataUrl) a.cover = s.coverDataUrl;
  });

  const grid = $("#artistAlbumsGrid");
  if (grid) {
    grid.innerHTML = "";
    [...albumMap.values()]
      .sort((a, b) => b.count - a.count)
      .forEach((al) => {
        const card = document.createElement("div");
        card.className = "card";
        card.innerHTML = `<img class="cv" src="${al.cover || ""}" alt="">
          <div class="ttl">${al.name}</div><div class="sub">${
          al.count
        } titre(s)</div>`;
        card.onclick = () => showAlbumDetail(al.name);
        grid.appendChild(card);
      });
  }

  state.scope = { type: "artistDetail", name };
  rebuildQueue();
}

/* ========================================================================
   VUE — GRILLE PLAYLISTS + DÉTAIL PLAYLIST
   ======================================================================== */
async function renderPlaylistsGrid() {
  const grid = $("#playlistGrid");
  if (!grid) return;
  grid.innerHTML = "";
  const pls = await DB.all("playlists");
  pls.forEach((pl) => {
    const count = pl.ids?.length || 0;
    const cover = pl.image || "";
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<img class="cv" src="${cover}" alt="">
      <div class="ttl">${pl.name}</div>
      <div class="sub">${count} titre(s)</div>`;
    card.onclick = () => showPlaylistDetail(pl.id);
    grid.appendChild(card);
  });
}
async function renderPlaylistDetail(id) {
  const pl = await DB.get("playlists", id);
  if (!pl) {
    setScope({ type: "all" });
    return;
  }
  const ids = pl.ids || [];
  const all = ids
    .map((sid) => state.songs.find((s) => s.id === sid))
    .filter(Boolean);

  // Filtre recherche
  const q = ($("#search")?.value || "").toLowerCase().trim();
  const list = q
    ? all.filter((s) =>
        (s.name + " " + (s.artist || "") + " " + (s.album || ""))
          .toLowerCase()
          .includes(q)
      )
    : all;

  const cover =
    pl.image || list.find((s) => s?.coverDataUrl)?.coverDataUrl || "";

  $("#playlistTitle") && ($("#playlistTitle").textContent = pl.name || "—");
  const totalDur = list.reduce((a, s) => a + (s?.duration || 0), 0);
  $("#playlistSub") &&
    ($("#playlistSub").textContent = `${list.length} titre(s) • ${fmt(
      totalDur
    )}`);
  $("#playlistCover") && ($("#playlistCover").src = cover);

  const [r, g, b] = await dominantColor(cover);
  const hero = $("#playlistHero");
  if (hero)
    hero.style.background = `linear-gradient(180deg, rgba(${r},${g},${b},.45), transparent 420px)`;

  setStdThead($("#playlistThead"));
  const tbody = $("#playlistTbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  list.forEach((s, i) => tbody.appendChild(buildSongRow(s, i)));
  hydrateIcons(tbody);
  wireSongRowActions(tbody);

  $("#playlistPlay") &&
    ($("#playlistPlay").onclick = () => {
      state.queue = list.map((s) => s.id);
      state.currentIndex = -1;
      playIndex(0);
    });
  $("#playlistShuffle") &&
    ($("#playlistShuffle").onclick = () => {
      state.queue = list.map((s) => s.id);
      for (let i = state.queue.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
      }
      playIndex(0);
    });
}

/* ========================================================================
   PLAYER
   ======================================================================== */
function smartPlay() {
  if (!audio.src || audio.src === window.location.href) {
    if (!state.queue.length) rebuildQueue();
    if (state.queue.length) {
      const index = state.currentIndex >= 0 ? state.currentIndex : 0;
      playIndex(index);
      return;
    }
    alert("Aucune chanson. Importe des fichiers ou clique un morceau.");
    return;
  }
  if (audio.paused) play();
  else pause();
}
async function play() {
  try {
    await audio.play();
  } catch (err) {
    console.warn("play() rejeté:", err);
    alert("Lecture impossible. Choisis un morceau ou ajoute un fichier audio.");
  }
}
function pause() {
  audio.pause();
}
async function playById(id) {
  if (!state.queue.includes(id)) {
    if (state.scope.type === "albumDetail") {
      const list = state.songs.filter(
        (s) => (s.album || "").toLowerCase() === state.scope.name.toLowerCase()
      );
      state.queue = list.map((s) => s.id);
    } else if (state.scope.type === "playlistDetail") {
      const ids = state.scope.ids || [];
      state.queue = ids.slice();
    } else if (state.scope.type === "artistDetail") {
      const list = state.songs.filter(
        (s) => (s.artist || "").toLowerCase() === state.scope.name.toLowerCase()
      );
      state.queue = list.map((s) => s.id);
    } else if (state.scope.type === "globalSearch") {
      state.queue = (state.scope.songs || []).map((s) => s.id);
    } else {
      rebuildQueue();
    }
  }
  const idx = state.queue.indexOf(id);
  if (idx !== -1) await playIndex(idx);
  else {
    state.queue = [id, ...state.queue];
    await playIndex(0);
  }
}
async function playIndex(qi) {
  const id = state.queue[qi];
  const s = state.songs.find((x) => x.id === id);
  if (!s) return;
  state.currentIndex = qi;
  let src;
  try {
    if (s.handle) {
      const ok = await ensurePermission(s.handle);
      if (!ok) throw new Error("permission-denied");
      const f = await s.handle.getFile();
      src = URL.createObjectURL(f);
      s.duration = s.duration || (await durationFromFile(f));
    } else if (s.blob) {
      src = URL.createObjectURL(s.blob);
    } else if (s.blobUrl) {
      src = s.blobUrl;
    }
  } catch (e) {
    console.warn("accès fichier", e);
  }
  if (!src) {
    alert(
      "Fichier introuvable. Réimporte ou modifie la chanson pour la relier."
    );
    return;
  }
  audio.src = src;
  updateNowUI(s);
  setMediaSession(s);
  applyThemeFromCover(s.coverDataUrl || "");
  // seed waveform with current track meta
  const sName = (s.name || "") + "|" + (s.album || "") + "|" + (s.artist || "");
  const wave = document.querySelector("#npSeekBar .bars");
  if (wave) buildWaveBars(wave, 40, sName);

  play();
}
function next() {
  if (!state.queue.length) return;
  let i = state.currentIndex + 1;
  if (i >= state.queue.length) {
    if (state.repeat === "all") i = 0;
    else {
      pause();
      return;
    }
  }
  playIndex(i);
}
function prev() {
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  let i = state.currentIndex - 1;
  if (i < 0) i = 0;
  playIndex(i);
}
function updateNowUI(s) {
  $("#nowTitle") && ($("#nowTitle").textContent = s.name || "—");
  $("#nowArtist") && ($("#nowArtist").textContent = s.artist || "—");
  $("#nowCover") && ($("#nowCover").src = s.coverDataUrl || "");
  $("#btnLike") &&
    $("#btnLike").classList.toggle("primary", state.favorites.has(s.id));
  $("#npTitle") && ($("#npTitle").textContent = s.name || "—");
  $("#npArtist") && ($("#npArtist").textContent = s.artist || "—");
  $("#npCover") && ($("#npCover").src = s.coverDataUrl || "");
}
function durationFromFile(file) {
  return new Promise((res) => {
    const a = new Audio();
    a.preload = "metadata";
    a.src = URL.createObjectURL(file);
    a.onloadedmetadata = () => {
      res(a.duration || 0);
      URL.revokeObjectURL(a.src);
    };
    a.onerror = () => res(0);
  });
}
async function ensurePermission(h) {
  if (!h || !h.queryPermission) return false;
  const o = { mode: "read" };
  let p = await h.queryPermission(o);
  if (p === "granted") return true;
  if (p === "prompt") {
    p = await h.requestPermission(o);
    return p === "granted";
  }
  return false;
}

/* ========================================================================
   IMPORT (File System Access API + fallback <input type="file">)
   ======================================================================== */
async function pickFiles() {
  if (!supportsFS) {
    alert("Navigateur sans sélecteur moderne. Utilise Fallback.");
    return;
  }
  const handles = await window.showOpenFilePicker({
    multiple: true,
    types: [
      {
        description: "Audio",
        accept: {
          "audio/*": [".mp3", ".m4a", ".aac", ".flac", ".wav", ".ogg"],
        },
      },
    ],
  });
  await importHandles(handles);
}
async function pickFolder() {
  if (!window.showDirectoryPicker) {
    alert("Sélection de dossier non supportée.");
    return;
  }
  const dir = await window.showDirectoryPicker();
  const files = [];
  for await (const [n, h] of dir.entries()) {
    if (h.kind === "file" && isAudio(n)) files.push(h);
    if (h.kind === "directory") {
      for await (const [n2, h2] of h.entries())
        if (h2.kind === "file" && isAudio(n2)) files.push(h2);
    }
  }
  await importHandles(files);
}
async function importHandles(handles) {
  let added = 0;
  for (const h of handles) {
    const f = await h.getFile();
    const id = `${f.name}|${f.size}`;
    if (state.songs.find((s) => s.id === id)) continue;
    const s = {
      id,
      name: f.name.replace(/\.[^.]+$/, ""),
      artist: "",
      album: "",
      size: f.size,
      type: f.type || "audio",
      handle: h,
      duration: await durationFromFile(f),
    };
    state.songs.push(s);
    await DB.put("songs", s);
    added++;
  }
  if (added) {
    postImport();
    alert(`${added} fichier(s) ajoutés.`);
  }
}
async function importFilesFromInput(list) {
  let added = 0;
  for (const f of list) {
    const id = `${f.name}|${f.size}|blob`;
    if (state.songs.find((s) => s.id === id)) continue;
    const s = {
      id,
      name: f.name.replace(/\.[^.]+$/, ""),
      artist: "",
      album: "",
      size: f.size,
      type: f.type || "audio",
      blob: f,
      duration: await durationFromFile(f),
    };
    state.songs.push(s);
    await DB.put("songs", s);
    added++;
  }
  if (added) {
    postImport();
    alert("Import terminé (fallback).");
  }
}
function postImport() {
  renderPlaylists();
  renderSideAlbums();
  renderSideArtists();
  if (state.scope.type === "albumGrid") renderAlbums();
  else if (state.scope.type === "artistGrid") renderArtists();
  else if (state.scope.type === "playlistGrid") renderPlaylistsGrid();
  else if (state.scope.type === "playlistDetail")
    renderPlaylistDetail(state.currentPlaylistId);
  else if (state.scope.type === "artistDetail")
    renderArtistDetail(state.scope.name);
  else renderSongs();
  attachAlbumAutocomplete();
}

/* ========================================================================
   CRUD — CHANSONS
   ======================================================================== */
async function saveSongFromForm() {
  const title = $("#songTitle")?.value.trim() || "";
  const artist = $("#songArtist")?.value.trim() || "";
  const album = $("#songAlbum")?.value.trim() || "";
  const fAudio = $("#songFile")?.files?.[0];
  const fCover = $("#songCover")?.files?.[0];

  if (!title && !fAudio) {
    alert("Ajoute au moins un fichier audio ou un titre.");
    return;
  }

  let song;
  if (fAudio) {
    const id = `${fAudio.name}|${fAudio.size}|manual`;
    const exists = state.songs.find((s) => s.id === id);
    const dur = await durationFromFile(fAudio);
    const coverDataUrl = fCover
      ? await readAsDataURL(fCover)
      : exists?.coverDataUrl || "";
    if (exists) {
      Object.assign(exists, {
        name: title || exists.name,
        artist,
        album,
        duration: dur || exists.duration,
        coverDataUrl,
        blob: fAudio,
        handle: undefined,
        size: fAudio.size,
        type: fAudio.type || "audio",
      });
      song = exists;
    } else {
      song = {
        id,
        name: title || fAudio.name.replace(/\.[^.]+$/, ""),
        artist,
        album,
        duration: dur,
        blob: fAudio,
        coverDataUrl,
        size: fAudio.size,
        type: fAudio.type || "audio",
      };
      state.songs.push(song);
    }
    await DB.put("songs", song);
  } else {
    const id = $("#songDialog")?.dataset?.editingId;
    if (!id) {
      alert("Pas de fichier audio lié.");
      return;
    }
    song = state.songs.find((s) => s.id === id);
    if (!song) {
      alert("Chanson introuvable.");
      return;
    }
    if (fCover) song.coverDataUrl = await readAsDataURL(fCover);
    song.name = title || song.name;
    song.artist = artist;
    song.album = album;
    await DB.put("songs", song);
  }
  songDialog?.close?.();
  postImport();
}
async function openEditSong(id) {
  const s = state.songs.find((x) => x.id === id);
  if (!s) return;
  $("#songDialog").dataset.editingId = id;
  $("#songTitle").value = s.name || "";
  $("#songArtist").value = s.artist || "";
  $("#songAlbum").value = s.album || "";
  $("#songCoverPreview").src = s.coverDataUrl || "";
  $("#songFile").value = "";
  attachAlbumAutocomplete();
  songDialog.showModal();
}
async function deleteSong(id) {
  if (!confirm("Supprimer cette chanson ?")) return;
  await DB.del("songs", id);
  state.songs = state.songs.filter((s) => s.id !== id);

  // enlever des playlists
  const pls = await DB.all("playlists");
  await Promise.all(
    pls.map(async (pl) => {
      if (pl.ids?.length) {
        const before = pl.ids.length;
        pl.ids = pl.ids.filter((sid) => sid !== id);
        if (pl.ids.length !== before) await DB.put("playlists", pl);
      }
    })
  );

  postImport();
}

/* ========================================================================
   FAVORIS
   ======================================================================== */
async function toggleLike(id, btn) {
  if (state.favorites.has(id)) state.favorites.delete(id);
  else state.favorites.add(id);
  await DB.put("prefs", { k: "favorites", val: [...state.favorites] });
  if (btn) btn.classList.toggle("primary", state.favorites.has(id));
}
async function toggleLikeCurrent() {
  const id = state.queue[state.currentIndex];
  if (!id) return;
  await toggleLike(id);
  $("#btnLike") &&
    $("#btnLike").classList.toggle("primary", state.favorites.has(id));
}

/* ========================================================================
   PLAYLISTS — ASIDE LIST + CRUD + ADD
   ======================================================================== */
async function renderPlaylists() {
  const wrap = $("#playlists");
  if (!wrap) return;
  wrap.innerHTML = "";
  const pls = await DB.all("playlists");
  pls.forEach((pl) => {
    const a = document.createElement("div");
    a.className = "playlist-item";
    a.innerHTML = `<div class="pl-cover">${
      pl.image ? `<img src="${pl.image}" alt="image">` : "🎧"
    }</div>
      <div><div class="pl-title">${pl.name}</div>
      <div class="muted" style="font-size:.85rem">${
        pl.ids?.length || 0
      } titre(s)</div></div>
      <div style="display:flex;gap:6px">
        <button class="btn icon" data-openpl="${pl.id}" title="Ouvrir">
          <span class="i" data-i="folder-open"></span>
        </button>
        <button class="btn icon" data-editpl="${pl.id}" title="Modifier">
          <span class="i" data-i="pen-line"></span>
        </button>
        <button class="btn icon" data-delpl="${pl.id}" title="Supprimer">
          <span class="i" data-i="trash-2"></span>
        </button>
      </div>`;
    a.onclick = (e) => {
      if (e.target.closest("button")) return;
      showPlaylistDetail(pl.id);
    };
    wrap.appendChild(a);
  });
  hydrateIcons(wrap);
  $$("button[data-openpl]", wrap).forEach(
    (b) =>
      (b.onclick = async () => {
        await showPlaylistDetail(b.dataset.openpl);
        closeAside();
      })
  );
  $$("button[data-editpl]", wrap).forEach(
    (b) => (b.onclick = () => openEditPlaylistDialog(b.dataset.editpl))
  );
  $$("button[data-delpl]", wrap).forEach(
    (b) => (b.onclick = () => deletePlaylist(b.dataset.delpl))
  );
}

function openNewPlaylistDialog() {
  $("#plDialogTitle") &&
    ($("#plDialogTitle").textContent = "Nouvelle playlist");
  $("#plName") && ($("#plName").value = "");
  $("#plCoverPreview") && ($("#plCoverPreview").src = "");
  $("#plCoverInput") && ($("#plCoverInput").value = "");
  $("#plCoverInput") &&
    ($("#plCoverInput").onchange = async (e) => {
      const f = e.target.files[0];
      if (f) $("#plCoverPreview").src = await readAsDataURL(f);
    });
  $("#plSave") &&
    ($("#plSave").onclick = async () => {
      const id = crypto.randomUUID();
      const name = $("#plName")?.value.trim() || "Ma playlist";
      const image = $("#plCoverPreview")?.src || "";
      await DB.put("playlists", { id, name, image, ids: [] });
      plDialog.close();
      renderPlaylists();
      if (state.scope.type === "playlistGrid") renderPlaylistsGrid();
    });
  plDialog.showModal();
}
async function openEditPlaylistDialog(id) {
  const pl = await DB.get("playlists", id);
  if (!pl) return;
  $("#plDialogTitle") &&
    ($("#plDialogTitle").textContent = "Modifier la playlist");
  $("#plName") && ($("#plName").value = pl.name);
  $("#plCoverPreview") && ($("#plCoverPreview").src = pl.image || "");
  $("#plCoverInput") && ($("#plCoverInput").value = "");
  $("#plCoverInput") &&
    ($("#plCoverInput").onchange = async (e) => {
      const f = e.target.files[0];
      if (f) $("#plCoverPreview").src = await readAsDataURL(f);
    });
  $("#plSave") &&
    ($("#plSave").onclick = async () => {
      pl.name = $("#plName").value.trim() || pl.name;
      pl.image = $("#plCoverPreview").src || "";
      await DB.put("playlists", pl);
      plDialog.close();
      renderPlaylists();
      if (
        state.scope.type === "playlistDetail" &&
        state.currentPlaylistId === pl.id
      ) {
        $("#currentScope") &&
          ($("#currentScope").textContent = "Playlist – " + pl.name);
        renderPlaylistDetail(pl.id);
      }
      if (state.scope.type === "playlistGrid") renderPlaylistsGrid();
    });
  plDialog.showModal();
}
async function deletePlaylist(id) {
  if (!confirm("Supprimer cette playlist ?")) return;
  await DB.del("playlists", id);
  if (state.scope.type === "playlistDetail" && state.currentPlaylistId === id)
    setScope({ type: "all" });
  renderPlaylists();
  if (state.scope.type === "playlistGrid") renderPlaylistsGrid();
}
async function openAddToPlaylistDialog(songIds) {
  const body = $("#plAddBody");
  if (!body) return;

  const idsToUpdate = Array.isArray(songIds) ? songIds : [songIds];
  body.innerHTML = `
    <div style="display:grid;gap:10px;max-height:50vh;overflow:auto">
      <div class="muted" style="margin-bottom:4px">Playlists</div>
      <div id="plAddList" style="display:grid;gap:10px"></div>
    </div>
  `;

  const listEl = body.querySelector("#plAddList");
  const playlists = await DB.all("playlists");
  if (!playlists.length) {
    if (confirm("Aucune playlist. En créer une ?")) openNewPlaylistDialog();
    return;
  }

  // on pré-coche si AU MOINS un des morceaux est déjà dans la playlist
  const initialChecked = new Map(); // plId -> boolean
  playlists.forEach((pl) => {
    const hasAny = (pl.ids || []).some((sid) => idsToUpdate.includes(sid));
    initialChecked.set(pl.id, hasAny);

    const line = document.createElement("label");
    line.style.display = "flex";
    line.style.alignItems = "center";
    line.style.gap = "10px";
    line.innerHTML = `
      <input type="checkbox" name="plAdd" value="${pl.id}" ${
      hasAny ? "checked" : ""
    }/>
      <div class="pl-cover" style="width:40px;height:40px">
        ${pl.image ? `<img src="${pl.image}" alt="">` : "🎧"}
      </div>
      <div style="min-width:0">
        <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${
          pl.name
        }</div>
        <div class="muted" style="font-size:.85rem">${
          pl.ids?.length || 0
        } titre(s)</div>
      </div>
    `;
    listEl.appendChild(line);
  });

  plAddDialog.showModal();

  $("#plAddConfirm") &&
    ($("#plAddConfirm").onclick = async () => {
      const checkedNow = new Set(
        [...body.querySelectorAll('input[name="plAdd"]:checked')].map(
          (x) => x.value
        )
      );

      // pour chaque playlist, on applique le diff
      for (const pl of playlists) {
        const wasChecked = initialChecked.get(pl.id);
        const isChecked = checkedNow.has(pl.id);
        pl.ids = pl.ids || [];

        if (isChecked && !wasChecked) {
          // AJOUTER les morceaux sélectionnés manquants
          for (const sid of idsToUpdate) {
            if (!pl.ids.includes(sid)) pl.ids.push(sid);
          }
          await DB.put("playlists", pl);
        } else if (!isChecked && wasChecked) {
          // RETIRER les morceaux sélectionnés
          const toRemove = new Set(idsToUpdate);
          const before = pl.ids.length;
          pl.ids = pl.ids.filter((sid) => !toRemove.has(sid));
          if (pl.ids.length !== before) await DB.put("playlists", pl);
        }
        // si wasChecked === isChecked → aucun changement à appliquer
      }

      plAddDialog.close();
      renderPlaylists();

      // rafraîchir la vue si on est déjà sur une playlist concernée
      if (state.scope.type === "playlistDetail") {
        const affected = playlists.some(
          (p) => p.id === state.currentPlaylistId
        );
        if (affected) renderPlaylistDetail(state.currentPlaylistId);
      }
    });
}

/* ========================================================================
   SÉLECTION MULTIPLE
   ======================================================================== */
function enterSelectMode(on = true) {
  state.selectMode = on;
  state.selection.clear();
  if (state.scope.type === "albumDetail") renderAlbumDetail(state.scope.name);
  else if (state.scope.type === "playlistDetail")
    renderPlaylistDetail(state.currentPlaylistId);
  else if (state.scope.type === "albumGrid") renderAlbums();
  else if (state.scope.type === "playlistGrid") renderPlaylistsGrid();
  else renderSongs();
  updateBulkBar();
}
function toggleSelect(id, checked) {
  if (checked) state.selection.add(id);
  else state.selection.delete(id);
  updateBulkBar();
}
function selectAllVisible() {
  const ids = _currentListForScope().map((s) => s.id);
  ids.forEach((id) => state.selection.add(id));
  updateBulkBar();
  if (state.scope.type === "albumDetail") renderAlbumDetail(state.scope.name);
  else if (state.scope.type === "playlistDetail")
    renderPlaylistDetail(state.currentPlaylistId);
  else renderSongs();
}
async function deleteSelectedSongs() {
  if (!state.selection.size) {
    alert("Sélection vide.");
    return;
  }
  if (!confirm(`Supprimer ${state.selection.size} titre(s) ?`)) return;

  const toDel = new Set(state.selection);
  state.songs = state.songs.filter((s) => !toDel.has(s.id));
  await Promise.all([...toDel].map((id) => DB.del("songs", id)));
  const pls = await DB.all("playlists");
  await Promise.all(
    pls.map(async (pl) => {
      if (pl.ids?.length) {
        const before = pl.ids.length;
        pl.ids = pl.ids.filter((id) => !toDel.has(id));
        if (pl.ids.length !== before) await DB.put("playlists", pl);
      }
    })
  );
  state.selection.clear();
  state.selectMode = false;
  postImport();
  alert("Suppression effectuée.");
}

async function addSelectedToPlaylists() {
  if (!state.selection.size) {
    alert("Sélection vide.");
    return;
  }
  // ouvrir la même modale avec un tableau d'IDs
  openAddToPlaylistDialog([...state.selection]);
}

function updateBulkBar() {
  const bar = $("#bulkBar");
  if (!bar) return;
  bar.hidden = !state.selectMode;
  $("#bulkCount") && ($("#bulkCount").textContent = state.selection.size);
}

/* ========================================================================
   AUTOCOMPLETE ALBUMS
   ======================================================================== */

/** Retourne la liste unique (triée) des noms d’albums présents dans l’état. */
function getAlbumNames() {
  const set = new Set();
  state.songs.forEach((s) => {
    const a = (s.album || "").trim();
    if (a) set.add(a);
  });
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Branche l’autocomplete <datalist> sur #songAlbum. */
function attachAlbumAutocomplete() {
  const input = $("#songAlbum");
  if (!input) return;
  let dl = $("#albumOptions");
  if (!dl) {
    dl = document.createElement("datalist");
    dl.id = "albumOptions";
    document.body.appendChild(dl);
  }
  const options = getAlbumNames();
  dl.innerHTML = options
    .map((name) => `<option value="${name}"></option>`)
    .join("");
  input.setAttribute("list", "albumOptions");
}

/* ========================================================================
   UI : SYNCHRO BOUTONS LECTURE / SHUFFLE / REPEAT
   (petite couche UI pour les icônes, indépendante de bindUI)
   ======================================================================== */

/** Toggle visuel du bouton play/pause (header + plein écran) */
document.querySelectorAll("#btnPlay,#npPlay").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll("#btnPlay,#npPlay").forEach((b) => {
      const isPlay = !!b.querySelector(".lucide-play");
      b.innerHTML = isPlay
        ? `<span><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pause"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg></span>`
        : `<span><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-play"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/></svg></span>`;
      b.title = isPlay ? "Pause" : "Lire";
    });
  })
);

/** Handlers centralisés (remplacent ceux éventuellement posés dans bindUI) */
if ($("#btnShuffle")) {
  $("#btnShuffle").onclick = () => {
    state.shuffle = !state.shuffle;
    document
      .querySelectorAll("#btnShuffle,#npShuffle")
      .forEach((b) => b?.classList.toggle("primary", state.shuffle));
    rebuildQueue();
  };
}
if ($("#btnRepeat")) {
  $("#btnRepeat").onclick = () => {
    state.repeat =
      state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
    const on = state.repeat !== "off";
    document
      .querySelectorAll("#btnRepeat,#npRepeat")
      .forEach((b) => b?.classList.toggle("primary", on));
    $("#btnRepeat").title = "Répéter: " + state.repeat;
  };
}

/* ========================================================================
   GESTURES (mobile) – swipe next/prev, swipe up pour ouvrir le player
   ======================================================================== */
(function bindGestures() {
  const zone = document.getElementById("main");
  if (!zone) return;

  let sx = 0,
    sy = 0,
    t0 = 0;

  zone.addEventListener(
    "touchstart",
    (e) => {
      const t = e.touches?.[0];
      if (!t) return;
      sx = t.clientX;
      sy = t.clientY;
      t0 = Date.now();
    },
    { passive: true }
  );

  zone.addEventListener(
    "touchend",
    (e) => {
      const t = e.changedTouches?.[0];
      if (!t) return;
      const dx = t.clientX - sx;
      const dy = t.clientY - sy;
      const dt = Date.now() - t0;

      const ax = Math.abs(dx);
      const ay = Math.abs(dy);

      // Swipe horizontal rapide -> next/prev
      if (dt < 800 && ax > 60 && ax > ay) {
        if (dx < 0) next();
        else prev();
        return;
      }

      // Swipe vers le haut -> ouvrir le player plein écran
      if (dt < 800 && dy < -80 && ay > ax) {
        const nd = document.getElementById("nowDialog");
        nd?.showModal?.();
      }
    },
    { passive: true }
  );
})();

/* ========================================================================
   SEARCH (intent + vues)
   - Intent exact : album → ouvre la vue Album directement
   - Intent exact : artiste → vue artiste (album vedette + titres + autres albums)
   - Sinon         : vue résultats mixtes (albums, playlists par NOM uniquement, titres)
   ======================================================================== */

/** Retire la vue de recherche si elle existe. */
const killSearchView = () => {
  const n = $("#searchView");
  if (n) n.remove();
};

/** Un seul match (exact > startsWith > includes) pour trancher une intention. */
function uniqueByPrefix(values, q) {
  const n = _norm(q);
  if (!n) return null;
  const exact = values.filter((v) => _norm(v) === n);
  if (exact.length === 1) return exact[0];
  const starts = values.filter((v) => _norm(v).startsWith(n));
  if (starts.length === 1) return starts[0];
  const inc = values.filter((v) => _norm(v).includes(n));
  if (inc.length === 1) return inc[0];
  return null;
}

/** Détermine l’intention (song → album, album, artist). */
function resolveSearchIntent(q) {
  const n = _norm(q);
  if (!n) return { type: null };

  const albums = [
    ...new Set(state.songs.map((s) => s.album || "").filter(Boolean)),
  ];
  const artists = [
    ...new Set(state.songs.map((s) => s.artist || "").filter(Boolean)),
  ];
  const titles = [
    ...new Set(state.songs.map((s) => s.name || "").filter(Boolean)),
  ];

  // 1) Titre (va vers son album)
  const tHit = uniqueByPrefix(titles, n);
  if (tHit) {
    const song = state.songs.find((s) => _norm(s.name) === _norm(tHit));
    if (song?.album) return { type: "album", payload: song.album };
  }

  // 2) Album
  const aHit = uniqueByPrefix(albums, n);
  if (aHit) return { type: "album", payload: aHit };

  // 3) Artiste
  const arHit = uniqueByPrefix(artists, n);
  if (arHit) return { type: "artist", payload: arHit };

  return { type: null };
}

/** Vue artiste “riche” historique (gardée en backup). */
async function renderArtistSearchResults(artistName) {
  // Masque toutes les autres vues
  [
    "#viewSongs",
    "#viewAlbums",
    "#viewPlaylists",
    "#albumView",
    "#playlistView",
  ].forEach((sel) => {
    const el = $(sel);
    if (el) el.style.display = "none";
  });

  // Prépare le conteneur
  let v = $("#searchView");
  if (!v) {
    v = document.createElement("div");
    v.id = "searchView";
    v.style.padding = "16px";
    const anchor = $("#main") || document.body;
    anchor.appendChild(v);
  }
  v.style.display = "block";
  v.innerHTML = `
    <h2 style="margin:0 0 12px 0">${artistName}</h2>
    <div id="artistHero" class="card" style="padding:16px">
      <div style="display:flex;gap:16px;align-items:center">
        <img id="artistHeroCover" style="width:140px;height:140px;object-fit:cover;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.3)"/>
        <div style="flex:1;min-width:0">
          <div class="muted">Album</div>
          <div id="artistHeroTitle" style="font-size:2rem;font-weight:800"></div>
          <div id="artistHeroSub" class="muted" style="margin-top:4px"></div>
          <button id="artistHeroPlay" class="btn primary" style="margin-top:16px">Lire</button>
        </div>
      </div>
    </div>
    <div style="margin-top:14px">
      <table class="tbl">
        <thead>
          <tr>
            <th style="width:36px">#</th>
            <th>Titre</th>
            <th style="width:120px">Durée</th>
            <th style="width:80px"></th>
            <th style="width:120px"></th>
          </tr>
        </thead>
        <tbody id="artistHeroTbody"></tbody>
      </table>
    </div>
    <div id="artistMore" style="margin-top:28px">
      <h3 style="margin:0 0 8px 0">Autres albums de ${artistName}</h3>
      <div id="artistAlbumsGrid" class="grid"></div>
    </div>
  `;

  const aNorm = _norm(artistName);
  const allByArtist = state.songs.filter((s) => _norm(s.artist) === aNorm);

  // Index des albums de l’artiste
  const albumMap = new Map();
  allByArtist.forEach((s) => {
    const name = (s.album || "Sans album").trim();
    if (!albumMap.has(name))
      albumMap.set(name, {
        name,
        count: 0,
        cover: s.coverDataUrl || "",
        tracks: [],
      });
    const a = albumMap.get(name);
    a.count++;
    if (!a.cover && s.coverDataUrl) a.cover = s.coverDataUrl;
    a.tracks.push(s);
  });

  if (!albumMap.size) {
    v.innerHTML = `<p>Aucun titre trouvé pour ${artistName}.</p>`;
    return;
  }

  const albums = [...albumMap.values()].sort((x, y) => y.count - x.count);
  const featured = albums[0];

  // Hero
  $("#artistHeroTitle").textContent = featured.name;
  const totalDur = featured.tracks.reduce((a, s) => a + (s.duration || 0), 0);
  $("#artistHeroSub").textContent = `${artistName} • ${
    featured.tracks.length
  } titre(s) • ${fmt(totalDur)}`;
  $("#artistHeroCover").src = featured.cover || "";
  const [r, g, b] = await dominantColor(featured.cover || "");
  $(
    "#artistHero"
  ).style.background = `linear-gradient(180deg, rgba(${r},${g},${b},.35), var(--panel-2))`;

  // Table titres
  const tb = $("#artistHeroTbody");
  tb.innerHTML = "";
  featured.tracks.forEach((s, i) => {
    const tr = document.createElement("tr");
    tr.className = "row";
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>
        <div class="song">
          <div class="thumb">${
            s.coverDataUrl ? `<img src="${s.coverDataUrl}">` : "🎵"
          }</div>
          <div style="display:grid;min-width:0">
            <div style="font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${
              s.name || "(sans titre)"
            }</div>
            <div class="muted" style="font-size:.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${
              s.artist || "—"
            }</div>
          </div>
        </div>
      </td>
      <td class="dur-cell"><span>${
        s.duration ? fmt(s.duration) : "—"
      }</span></td>
      <td><button class="btn icon" data-like="${
        s.id
      }"><span class="i" data-i="heart"></span></button></td>
      <td style="display:flex;gap:6px;justify-content:flex-end">
        <button class="btn icon" data-addtopl="${
          s.id
        }"><span class="i" data-i="plus"></span></button>
        <button class="btn icon inline-del" data-del="${
          s.id
        }"><span class="i" data-i="trash-2"></span></button>
      </td>`;
    tr.onclick = (e) => {
      if (e.target.closest("button")) return;
      playById(s.id);
    };
    tb.appendChild(tr);
  });
  hydrateIcons(tb);
  $$("[data-like]", tb).forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        toggleLike(b.dataset.like, b);
      })
  );
  $$("[data-addtopl]", tb).forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        openAddToPlaylistDialog(b.dataset.addtopl);
      })
  );
  $$("[data-del]", tb).forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        deleteSong(b.dataset.del);
      })
  );

  $("#artistHeroPlay").onclick = () => {
    state.queue = featured.tracks.map((s) => s.id);
    state.currentIndex = -1;
    playIndex(0);
  };

  // Autres albums
  const grid = $("#artistAlbumsGrid");
  grid.innerHTML = "";
  const others = albums.slice(1);
  if (!others.length) $("#artistMore").style.display = "none";
  others.forEach((al) => {
    const card = document.createElement("div");
    card.className = "card";
    card.style.cursor = "pointer";
    card.innerHTML = `<img class="cv" src="${
      al.cover || ""
    }"><div class="ttl">${al.name}</div><div class="sub">${
      al.count
    } titre(s)</div>`;
    card.onclick = () => showAlbumDetail(al.name);
    grid.appendChild(card);
  });

  // Queue contextuelle pour la vue d’artiste
  state.scope = {
    type: "globalSearch",
    q: artistName,
    songs: allByArtist.slice(),
  };
  rebuildQueue();
}

/** Vue globale de résultats (albums / playlists par NOM / titres). */
async function renderGlobalSearchResults(qRaw) {
  const q = _norm(qRaw);

  // Masque les autres vues
  [
    "#viewSongs",
    "#viewAlbums",
    "#viewPlaylists",
    "#albumView",
    "#playlistView",
  ].forEach((sel) => {
    const el = $(sel);
    if (el) el.style.display = "none";
  });

  // Conteneur
  let v = $("#searchView");
  if (!v) {
    v = document.createElement("div");
    v.id = "searchView";
    v.style.padding = "16px";
    const anchor = $("#main") || document.body;
    anchor.appendChild(v);
  }
  v.style.display = "block";
  v.innerHTML = `
    <h2 id="searchTitle" style="margin:0 0 12px 0">Résultats</h2>
    <div id="searchAlbums"><h3 style="margin:16px 0 8px 0">Albums</h3><div id="searchAlbumGrid" class="grid"></div></div>
    <div id="searchPlaylists"><h3 style="margin:16px 0 8px 0">Playlists</h3><div id="searchPlGrid" class="grid"></div></div>
    <div id="searchSongs"><h3 style="margin:16px 0 8px 0">Titres</h3><div id="searchSongList"></div></div>
  `;

  // Scoring simple pour mieux remonter les bons titres
  const scoreSong = (s, q) => {
    const t = _norm(s.name),
      ar = _norm(s.artist),
      al = _norm(s.album);
    let sc = 0;
    if (t === q) sc += 100;
    else if (t.startsWith(q)) sc += 70;
    else if (t.includes(q)) sc += 50;
    if (ar === q) sc += 45;
    else if (ar.startsWith(q)) sc += 35;
    else if (ar.includes(q)) sc += 25;
    if (al === q) sc += 20;
    else if (al.startsWith(q)) sc += 12;
    else if (al.includes(q)) sc += 8;
    return sc;
  };

  const match = (s) =>
    (_norm(s.name) + " " + _norm(s.artist) + " " + _norm(s.album)).includes(q);

  let songs = q ? state.songs.filter(match) : state.songs.slice();
  if (q)
    songs.sort(
      (a, b) =>
        scoreSong(b, q) - scoreSong(a, q) ||
        (a.name || "").localeCompare(b.name || "")
    );

  // Albums issus de la sélection de titres filtrés
  const albumMap = new Map();
  songs.forEach((s) => {
    const name = (s.album || "").trim();
    if (!name) return;
    if (!albumMap.has(name))
      albumMap.set(name, { name, count: 0, cover: s.coverDataUrl || "" });
    const a = albumMap.get(name);
    a.count++;
    if (!a.cover && s.coverDataUrl) a.cover = s.coverDataUrl;
  });
  const albums = [...albumMap.values()].sort((a, b) => b.count - a.count);

  // Playlists : on NE montre que celles dont le NOM matche (pas de bruit si l’artiste matche)
  const pls = await DB.all("playlists");
  const playlists = pls.filter((pl) => _norm(pl.name).includes(q));

  $("#searchTitle").textContent = q ? `Résultats pour “${q}”` : "Résultats";

  // Albums grid
  const ag = $("#searchAlbumGrid");
  ag.innerHTML = "";
  $("#searchAlbums").style.display = albums.length ? "block" : "none";
  albums.forEach((al) => {
    const div = document.createElement("div");
    div.className = "card";
    div.style.cursor = "pointer";
    div.innerHTML = `<img class="cv" src="${al.cover || ""}"><div class="ttl">${
      al.name
    }</div><div class="sub">${al.count} titre(s)</div>`;
    div.onclick = () => showAlbumDetail(al.name);
    ag.appendChild(div);
  });

  // Playlists grid (nom uniquement)
  const pg = $("#searchPlGrid");
  pg.innerHTML = "";
  $("#searchPlaylists").style.display = playlists.length ? "block" : "none";
  playlists.forEach((pl) => {
    const count = pl.ids?.length || 0;
    const cover = pl.image || "";
    const card = document.createElement("div");
    card.className = "card";
    card.style.cursor = "pointer";
    card.innerHTML = `<img class="cv" src="${cover}"><div class="ttl">${pl.name}</div><div class="sub">${count} titre(s)</div>`;
    card.onclick = () => showPlaylistDetail(pl.id);
    pg.appendChild(card);
  });

  // Titres list
  const sl = $("#searchSongList");
  sl.innerHTML = "";
  $("#searchSongs").style.display = songs.length ? "block" : "none";
  songs.forEach((s) => {
    const row = document.createElement("div");
    row.className = "item";
    row.style.display = "grid";
    row.style.gridTemplateColumns = "40px 1fr auto";
    row.style.gap = "10px";
    row.style.alignItems = "center";
    row.style.padding = "6px 4px";
    row.innerHTML = `
      <div class="cover">${
        s.coverDataUrl
          ? `<img src="${s.coverDataUrl}" style="width:40px;height:40px;object-fit:cover;border-radius:6px">`
          : "🎵"
      }</div>
      <div class="meta" style="min-width:0">
        <div class="t" style="font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
          ${s.name || "(sans titre)"}
        </div>
        <div class="a muted" style="font-size:.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
          ${s.artist || "—"} · ${s.album || "Sans album"}
        </div>
      </div>
      <div class="d muted" style="font-variant-numeric:tabular-nums">
        ${s.duration ? fmt(s.duration) : "—"}
      </div>`;
    row.onclick = () => playById(s.id);
    sl.appendChild(row);
  });

  hydrateIcons(v);
  state.scope = { type: "globalSearch", q, songs: songs.map((s) => s) };
  rebuildQueue();
}

/** Listener principal de la barre de recherche (#search) */
$("#search")?.addEventListener("input", async () => {
  const q = $("#search").value.trim();

  // Vide → retour aux vues normales
  if (!q) {
    killSearchView();
    if (state.scope.type === "albumDetail") renderAlbumDetail(state.scope.name);
    else if (state.scope.type === "playlistDetail")
      renderPlaylistDetail(state.currentPlaylistId);
    else if (state.scope.type === "albumGrid") {
      $("#viewAlbums").style.display = "block";
      renderAlbums();
    } else if (state.scope.type === "playlistGrid") {
      $("#viewPlaylists").style.display = "block";
      renderPlaylistsGrid();
    } else {
      $("#viewSongs").style.display = "block";
      renderSongs();
    }
    return;
  }

  // Intention
  const intent = resolveSearchIntent(q);

  // ALBUM identifié → bascule directe vers la vue Album
  if (intent.type === "album") {
    killSearchView();
    setScope({ type: "albumDetail", name: intent.payload });
    return;
  }

  // ARTISTE identifié → **router vers la vue Artiste harmonisée**
  if (intent.type === "artist") {
    killSearchView();
    setScope({ type: "artistDetail", name: intent.payload });
    return;
  }

  // Sinon : résultats mixtes
  await renderGlobalSearchResults(q);
});
/* =======================
   Progress UI (pill + wave)
   ======================= */

function pctFromEvent(el, clientX) {
  const r = el.getBoundingClientRect();
  let p = (clientX - r.left) / r.width;
  return Math.min(1, Math.max(0, p || 0));
}

/** Init une barre (id) à contrôler l’audio.currentTime */
function wireProgress(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.setAttribute("role", "slider");
  el.setAttribute("aria-valuemin", "0");
  el.setAttribute("aria-valuemax", "1000");
  el.setAttribute("aria-valuenow", "0");
  el.tabIndex = 0;

  let dragging = false;

  const seekToPct = (p) => {
    if (!audio.duration) return;
    const t = p * audio.duration;
    audio.currentTime = t;
    updateProgressVisual(el, p);
  };

  el.addEventListener("pointerdown", (e) => {
    dragging = true;
    el.setPointerCapture(e.pointerId);
    el.setAttribute("aria-grabbed", "true");
    seekToPct(pctFromEvent(el, e.clientX));
  });
  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    seekToPct(pctFromEvent(el, e.clientX));
  });
  el.addEventListener("pointerup", () => {
    dragging = false;
    el.removeAttribute("aria-grabbed");
  });

  // clavier
  el.addEventListener("keydown", (e) => {
    if (!audio.duration) return;
    const step = 5; // 0.5% of slider
    if (["ArrowRight", "ArrowUp"].includes(e.key)) {
      e.preventDefault();
      const p = Math.min(1000, (+el.getAttribute("aria-valuenow") || 0) + step);
      seekToPct(p / 1000);
    } else if (["ArrowLeft", "ArrowDown"].includes(e.key)) {
      e.preventDefault();
      const p = Math.max(0, (+el.getAttribute("aria-valuenow") || 0) - step);
      seekToPct(p / 1000);
    }
  });
}

/** Met à jour l’aspect visuel (pill + wave) */
function updateProgressVisual(el, p) {
  const perc100 = Math.round(p * 1000);
  el.style.setProperty("--_val", perc100 / 10 + "%");
  el.setAttribute("aria-valuenow", String(perc100));

  // knob (pill)
  const knob = el.querySelector(".knob");
  if (knob) {
    const w = el.clientWidth || 1;
    knob.style.setProperty("--_x", w * p - knob.offsetWidth / 2 + "px");
  }

  // wave bars
  if (el.dataset.variant === "wave") {
    const bars = el.querySelectorAll(".bar");
    const upto = Math.floor(bars.length * p);
    bars.forEach((b, i) => {
      b.classList.toggle("played", i <= upto);
    });
  }
}

/** Construit N barres avec hauteurs pseudo-aléatoires stables (seed = nom piste + album) */
function buildWaveBars(container, n = 40, seedStr = "") {
  if (!container) return;
  container.style.setProperty("--n", n);
  container.innerHTML = "";
  let seed = 0;
  for (let i = 0; i < seedStr.length; i++)
    seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;

  function rnd() {
    seed = (1103515245 * seed + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  }
  for (let i = 0; i < n; i++) {
    const d = document.createElement("div");
    d.className = "bar";
    const hMin = 10,
      hMax = 64;
    const h = hMin + Math.pow(rnd(), 1.8) * (hMax - hMin); // plus de petites barres
    d.style.height = h.toFixed(0) + "px";
    container.appendChild(d);
  }
}

/** À appeler une fois au boot */
function initProgressUI() {
  // Crée les 40 barres dans le plein écran si manquantes
  const np = document.getElementById("npSeekBar");
  if (np && !np.querySelector(".bars")) {
    const wrap = document.createElement("div");
    wrap.className = "bars";
    np.appendChild(wrap);
  }

  // Wire les 2 barres
  wireProgress("seekBar");
  wireProgress("npSeekBar");
}

/** Met à jour les 2 barres depuis l’audio (appelé sur timeupdate + onloadmetadata) */
function syncProgressFromAudio() {
  const p = audio.duration ? audio.currentTime / audio.duration : 0;
  const ids = ["seekBar", "npSeekBar"];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) updateProgressVisual(el, p);
  });
}
$("#bulkCancel") && ($("#bulkCancel").onclick = () => enterSelectMode(false));

function updateBulkBar() {
  const bar = $("#bulkBar");
  if (!bar) return;
  bar.hidden = !state.selectMode;
  $("#bulkCount") && ($("#bulkCount").textContent = state.selection.size);
}

hydrateIcons(document);
