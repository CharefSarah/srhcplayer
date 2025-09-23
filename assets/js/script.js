/* ==========================================================================
   SRHC PLAYER — JS unique (refactor)
   - Vues : Chansons, Albums, Playlists, Artistes
   - File system/IndexedDB
   - Lecteur audio + Media Session
   - Recherche factorisée
   - Gestes mobiles (swipe)
   - Sélection multiple
   ========================================================================== */

/* ======= Icônes (Lucide) ================================================= */
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

/* ======= Utils ============================================================ */
// Sélecteurs rapides
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

// Format mm:ss
const fmt = (sec) => {
  if (!isFinite(sec)) return "0:00";
  const m = (sec / 60) | 0;
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

// Fichier → dataURL
const readAsDataURL = (file) =>
  new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.readAsDataURL(file);
  });

// Capacités/regex audio
const supportsFS = !!(window.showOpenFilePicker || window.showDirectoryPicker);
const isAudio = (n) => /\.(mp3|m4a|aac|flac|wav|ogg)$/i.test(n);

// Couleur dominante (rapide)
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

// Thèmes dynamiques
async function applyThemeFromCover(url) {
  const [r, g, b] = await dominantColor(url);
  $("#main") &&
    ($(
      "#main"
    ).style.background = `linear-gradient(180deg, rgba(${r},${g},${b},.12), transparent 240px), var(--panel-2)`);
  const nd = $("#nowDialog");
  if (nd)
    nd.style.background = `linear-gradient(180deg, rgba(${r},${g},${b},.22), var(--panel-2))`;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", rgb2hex(r, g, b));
}
async function applySongsHeaderTheme() {
  const first = state.songs.find((s) => s.coverDataUrl)?.coverDataUrl || "";
  const [r, g, b] = await dominantColor(first);
  $("#songsHeader") &&
    ($(
      "#songsHeader"
    ).style.background = `linear-gradient(180deg, rgba(${r},${g},${b},.55), transparent 180px)`);
}

// Recherche : tokenisation simple
function searchMatch(song, q) {
  if (!q) return true;
  const hay = `${song.name} ${song.artist || ""} ${
    song.album || ""
  }`.toLowerCase();
  return hay.includes(q);
}

/* ======= DB (IndexedDB) =================================================== */
const DB_NAME = "local-music-db-v5"; // bump version (safe)
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        try {
          const s = db.createObjectStore("songs", { keyPath: "id" });
          s.createIndex("by_album", "album");
          s.createIndex("by_artist", "artist");
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

/* ======= State ============================================================ */
const state = {
  scope: { type: "all" }, // all | fav | albumGrid | albumDetail | playlistGrid | playlistDetail | artistGrid | artistDetail
  songs: [],
  favorites: new Set(),
  queue: [],
  currentIndex: -1,
  shuffle: false,
  repeat: "all", // ⚠️ par défaut, la playlist tourne en boucle
  currentPlaylistId: null,
  // Sélection multiple
  selectMode: false,
  selection: new Set(),
};

let audio = new Audio();
audio.preload = "metadata";

/* ======= Queue / List Helpers ============================================ */
// Retourne la liste courante selon le scope + recherche
function currentList() {
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
  }

  if (q) list = list.filter((s) => searchMatch(s, q));
  return list;
}

// Reconstruit la file d’attente à partir de la liste courante
function rebuildQueue() {
  const list = currentList();
  state.queue = list.map((s) => s.id);
  if (state.shuffle) shuffleArray(state.queue);
}
window.rebuildQueue = rebuildQueue;

// Shuffle in-place
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/* ======= Media Session ==================================================== */
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
    navigator.mediaSession.setActionHandler("play", play);
    navigator.mediaSession.setActionHandler("pause", pause);
    navigator.mediaSession.setActionHandler("previoustrack", prev);
    navigator.mediaSession.setActionHandler("nexttrack", next);
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

/* ======= Bootstrap ======================================================== */
(async function bootstrap() {
  hydrateIcons(document);
  await DB.open();
  const favs = await DB.get("prefs", "favorites");
  if (favs) state.favorites = new Set(favs.val);
  state.songs = await DB.all("songs");

  renderPlaylists(); // sidebar
  renderSideAlbums(); // sidebar
  renderSideArtists(); // sidebar (nouveau)
  setScope({ type: "all" });

  bindUI();
  attachAlbumAutocomplete();
  attachArtistAutocomplete();
  initGestures(); // Gestes mobile
})();

/* ======= Bindings / UI Actions =========================================== */
function bindUI() {
  // Nav
  $("#btnFavorites") &&
    ($("#btnFavorites").onclick = () => setScope({ type: "fav" }));
  $("#btnAlbums") && ($("#btnAlbums").onclick = showAlbums);
  $("#btnPlaylists") && ($("#btnPlaylists").onclick = showPlaylists);
  $("#btnArtists") && ($("#btnArtists").onclick = showArtists); // NEW

  // Playlists
  $("#btnNewPlaylist") &&
    ($("#btnNewPlaylist").onclick = openNewPlaylistDialog);

  // Recherche (live)
  $("#search")?.addEventListener("input", () => {
    switch (state.scope.type) {
      case "albumDetail":
        renderAlbumDetail(state.scope.name);
        break;
      case "playlistDetail":
        renderPlaylistDetail(state.currentPlaylistId);
        break;
      case "artistDetail":
        renderArtistDetail(state.scope.name);
        break;
      case "albumGrid":
        renderAlbums();
        break;
      case "artistGrid":
        renderArtists();
        break;
      case "playlistGrid":
        renderPlaylistsGrid();
        break;
      default:
        renderSongs();
    }
  });

  // Dialogue Ajouter/Modifier chanson
  $("#btnAddSong") && ($("#btnAddSong").onclick = () => songDialog.showModal());
  $("#songCover")?.addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (f) $("#songCoverPreview").src = await readAsDataURL(f);
  });
  $("#saveSong")?.addEventListener("click", saveSongFromForm);

  // Player (volume/seek)
  $("#volume") &&
    ($("#volume").oninput = (e) => {
      audio.volume = +e.target.value;
      e.target.style.setProperty(
        "--_val",
        Math.floor(+e.target.value * 100) + "%"
      );
    });
  const onSeekInput = (e) => {
    const pos = +e.target.value / 1000;
    if (audio.duration) audio.currentTime = pos * audio.duration;
    e.target.style.setProperty("--_val", e.target.value / 10 + "%");
  };
  $("#seek") && ($("#seek").oninput = onSeekInput);
  $("#npSeek") && ($("#npSeek").oninput = onSeekInput);

  // Shuffle
  const toggleShuffle = () => {
    state.shuffle = !state.shuffle;
    ["#btnShuffle", "#npShuffle"].forEach((sel) =>
      $(sel)?.classList.toggle("primary", state.shuffle)
    );
    rebuildQueue();
  };
  $("#btnShuffle") && ($("#btnShuffle").onclick = toggleShuffle);
  $("#npShuffle") && ($("#npShuffle").onclick = toggleShuffle);

  // Repeat (off ⟷ one) — la boucle playlist est déjà gérée par state.repeat="all"
  const toggleRepeat = () => {
    state.repeat = state.repeat === "one" ? "all" : "one"; // "all" = boucle playlist; "one" = boucle piste
    const on = state.repeat === "one";
    ["#btnRepeat", "#npRepeat"].forEach((sel) =>
      $(sel)?.classList.toggle("primary", on)
    );
    ["#btnRepeat", "#npRepeat"].forEach((sel) =>
      $(sel)?.setAttribute(
        "title",
        on ? "Répéter : piste" : "Répéter : playlist"
      )
    );
  };
  $("#btnRepeat") && ($("#btnRepeat").onclick = toggleRepeat);
  $("#npRepeat") && ($("#npRepeat").onclick = toggleRepeat);

  // Transport
  $("#btnPrev") && ($("#btnPrev").onclick = prev);
  $("#btnNext") && ($("#btnNext").onclick = next);
  const syncPlayButtons = () => {
    document.querySelectorAll("#btnPlay,#npPlay").forEach((b) => {
      const showPause = !audio.paused;
      b.innerHTML = showPause
        ? `<span><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pause"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg></span>`
        : `<span><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-play"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/></svg></span>`;
      b.title = showPause ? "Pause" : "Lire";
    });
  };
  $("#btnPlay") && ($("#btnPlay").onclick = smartPlay);
  $("#npPlay") && ($("#npPlay").onclick = smartPlay);

  // Expand Now Playing
  $("#btnExpand") && ($("#btnExpand").onclick = () => nowDialog.showModal());
  $("#btnLike") && ($("#btnLike").onclick = toggleLikeCurrent);

  // Bouton “Lecture grande entête”
  $("#songsPlayBig") &&
    ($("#songsPlayBig").onclick = () => {
      rebuildQueue();
      if (state.queue.length)
        playIndex(state.currentIndex >= 0 ? state.currentIndex : 0);
    });

  // Audio events
  audio.addEventListener("timeupdate", () => {
    $("#cur") && ($("#cur").textContent = fmt(audio.currentTime));
    $("#dur") && ($("#dur").textContent = fmt(audio.duration || 0));
    $("#npCur") && ($("#npCur").textContent = fmt(audio.currentTime));
    $("#npDur") && ($("#npDur").textContent = fmt(audio.duration || 0));
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
    updatePositionState();
  });
  audio.addEventListener("play", () => {
    if ("mediaSession" in navigator)
      navigator.mediaSession.playbackState = "playing";
    syncPlayButtons();
    updatePositionState();
  });
  audio.addEventListener("pause", () => {
    if ("mediaSession" in navigator)
      navigator.mediaSession.playbackState = "paused";
    syncPlayButtons();
    updatePositionState();
  });
  audio.addEventListener("ended", () => {
    if (state.repeat === "one") {
      playIndex(state.currentIndex);
      return;
    }
    next(); // avec repeat="all", next() reboucle au début
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
}

/* ======= Drawer mobile ==================================================== */
function toggleAside() {
  document.body.classList.toggle("aside-open");
  const open = document.body.classList.contains("aside-open");
  $("#drawerMask") && ($("#drawerMask").hidden = !open);
  requestAnimationFrame(
    () => $("#drawerMask") && $("#drawerMask").classList.toggle("show", open)
  );
}
function closeAside() {
  document.body.classList.remove("aside-open");
  $("#drawerMask") && $("#drawerMask").classList.remove("show");
  setTimeout(() => $("#drawerMask") && ($("#drawerMask").hidden = true), 160);
}

/* ======= Routing (vues) =================================================== */
function setScope(scope) {
  state.scope = scope;

  // Masquer toutes les vues
  [
    "#viewSongs",
    "#viewAlbums",
    "#viewPlaylists",
    "#albumView",
    "#playlistView",
    "#viewArtists",
    "#artistView",
  ].forEach((sel) => $(sel) && ($(sel).style.display = "none"));

  // Afficher + render
  if (scope.type === "albumGrid") {
    $("#viewAlbums").style.display = "block";
    $("#currentScope") && ($("#currentScope").textContent = "Albums");
    renderAlbums();
  } else if (scope.type === "playlistGrid") {
    $("#viewPlaylists").style.display = "block";
    $("#currentScope") && ($("#currentScope").textContent = "Playlists");
    renderPlaylistsGrid();
  } else if (scope.type === "albumDetail") {
    $("#albumView").style.display = "block";
    $("#currentScope") &&
      ($("#currentScope").textContent = "Album – " + (scope.name || ""));
    function renderArtistDetail(name) {
      const artistAlbums = albums.filter((a) => a.artist === name);
      if (artistAlbums.length === 0) return;

      // Afficher le premier album directement
      renderAlbumDetail(artistAlbums[0].name);
    }
  } else if (scope.type === "artistGrid") {
    $("#viewArtists").style.display = "block";
    $("#currentScope") && ($("#currentScope").textContent = "Artistes");
    renderArtists();
  } else if (scope.type === "artistDetail") {
    $("#artistView").style.display = "block";
    $("#currentScope") &&
      ($("#currentScope").textContent = "Artiste – " + (scope.name || ""));
    renderArtistDetail(scope.name);
  } else {
    $("#viewSongs").style.display = "block";
    $("#currentScope") &&
      ($("#currentScope").textContent =
        scope.type === "fav" ? "Favoris" : "Musique");
    renderSongs();
  }
  rebuildQueue();
}
const showAlbums = () => setScope({ type: "albumGrid" });
const showPlaylists = () => setScope({ type: "playlistGrid" });
const showArtists = () => setScope({ type: "artistGrid" });

/* ======= Side (albums/artistes) ========================================== */
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
  const side = $("#sideArtists"); // optionnel dans l’aside
  if (!side) return;
  side.innerHTML = "";
  const map = groupArtists();
  let i = 0;
  for (const ar of map.values()) {
    if (i++ >= 8) break;
    const d = document.createElement("div");
    d.className = "cover-sm";
    d.title = ar.name;
    d.textContent = (ar.name || "—").slice(0, 2).toUpperCase(); // monogramme
    d.onclick = () => {
      showArtistDetail(ar.name);
      closeAside();
    };
    side.appendChild(d);
  }
}

// Grouper Albums / Artistes
function groupAlbums() {
  const map = new Map();
  state.songs.forEach((s) => {
    const k = s.album || "Sans album";
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
    const k = s.artist || "Inconnu";
    if (!map.has(k))
      map.set(k, { name: k, count: 0, cover: s.coverDataUrl || "" });
    const a = map.get(k);
    a.count++;
    if (!a.cover && s.coverDataUrl) a.cover = s.coverDataUrl;
  });
  return new Map([...map.entries()].sort((a, b) => b[1].count - a[1].count));
}

/* ======= Albums (grid + detail) ========================================== */
function renderAlbums() {
  const grid = $("#albumGrid");
  if (!grid) return;
  grid.innerHTML = "";
  const q = ($("#search")?.value || "").toLowerCase();
  const map = groupAlbums();
  [...map.values()]
    .filter(
      (al) =>
        !q ||
        al.name.toLowerCase().includes(q) ||
        (al.artist || "").toLowerCase().includes(q)
    )
    .forEach((al) => {
      const div = document.createElement("div");
      div.className = "card";
      div.innerHTML = `<img class="cv" src="${
        al.cover || ""
      }" alt=""><div class="ttl">${al.name}</div><div class="sub">${
        al.count
      } titres</div>`;
      div.onclick = () => showAlbumDetail(al.name);
      grid.appendChild(div);
    });
}
async function renderAlbumDetail(name) {
  const list = state.songs
    .filter((s) => (s.album || "").toLowerCase() === (name || "").toLowerCase())
    .filter((s) => searchMatch(s, ($("#search")?.value || "").toLowerCase()));
  const art = list[0]?.artist || "—";
  const cover = list.find((s) => s.coverDataUrl)?.coverDataUrl || "";
  $("#albumTitle") && ($("#albumTitle").textContent = name);
  $("#albumSub") &&
    ($("#albumSub").textContent = `${art} • ${list.length} titre(s) • ${fmt(
      list.reduce((a, s) => a + (s.duration || 0), 0)
    )}`);
  $("#albumCover") && ($("#albumCover").src = cover);
  const [r, g, b] = await dominantColor(cover);
  $("#albumHero") &&
    ($(
      "#albumHero"
    ).style.background = `linear-gradient(180deg, rgba(${r},${g},${b},.45), transparent 420px)`);

  renderSongTable("#albumTbody", list);

  // ✅ Aligner header/body : on masque Artiste + Album pour la vue Album
  const tbl = document.querySelector("#albumView table");
  if (tbl) tbl.classList.add("cols--no-artist", "cols--no-album");

  $("#albumPlay") && ($("#albumPlay").onclick = () => queueAndPlay(list));
  $("#albumShuffle") &&
    ($("#albumShuffle").onclick = () => queueAndShuffle(list));
}

/* ======= Playlists (grid + detail) ======================================= */
async function renderPlaylistsGrid() {
  const grid = $("#playlistGrid");
  if (!grid) return;
  const q = ($("#search")?.value || "").toLowerCase();
  grid.innerHTML = "";
  const pls = await DB.all("playlists");
  pls
    .filter((pl) => !q || (pl.name || "").toLowerCase().includes(q))
    .forEach((pl) => {
      const count = pl.ids?.length || 0;
      const cover = pl.image || "";
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `<img class="cv" src="${cover}" alt=""><div class="ttl">${pl.name}</div><div class="sub">${count} titre(s)</div>`;
      card.onclick = () => showPlaylistDetail(pl.id);
      grid.appendChild(card);
    });
}
async function showPlaylistDetail(id) {
  state.currentPlaylistId = id;
  const pl = await DB.get("playlists", id);
  const name = pl?.name || "—";
  state.scope = { type: "playlistDetail", id, name, ids: pl?.ids || [] };
  ["#viewSongs", "#viewAlbums", "#viewPlaylists", "#albumView"].forEach(
    (sel) => $(sel) && ($(sel).style.display = "none")
  );
  $("#playlistView") && ($("#playlistView").style.display = "block");
  $("#currentScope") && ($("#currentScope").textContent = "Playlist – " + name);
  await renderPlaylistDetail(id);
}
async function renderPlaylistDetail(id) {
  const pl = await DB.get("playlists", id);
  if (!pl) {
    setScope({ type: "all" });
    return;
  }
  const ids = pl.ids || [];
  const list = ids
    .map((sid) => state.songs.find((s) => s.id === sid))
    .filter(Boolean)
    .filter((s) => searchMatch(s, ($("#search")?.value || "").toLowerCase()));
  const cover =
    pl.image || list.find((s) => s.coverDataUrl)?.coverDataUrl || "";
  $("#playlistTitle") && ($("#playlistTitle").textContent = pl.name || "—");
  const totalDur = list.reduce((a, s) => a + (s?.duration || 0), 0);
  $("#playlistSub") &&
    ($("#playlistSub").textContent = `${list.length} titre(s) • ${fmt(
      totalDur
    )}`);
  $("#playlistCover") && ($("#playlistCover").src = cover);
  const [r, g, b] = await dominantColor(cover);
  $("#playlistHero") &&
    ($(
      "#playlistHero"
    ).style.background = `linear-gradient(180deg, rgba(${r},${g},${b},.45), transparent 420px)`);
  renderSongTable("#playlistTbody", list);

  // ✅ Playlist : on montre toutes les colonnes
  const tbl = document.querySelector("#playlistView table");
  if (tbl) tbl.classList.remove("cols--no-artist", "cols--no-album");

  $("#playlistPlay") && ($("#playlistPlay").onclick = () => queueAndPlay(list));
  $("#playlistShuffle") &&
    ($("#playlistShuffle").onclick = () => queueAndShuffle(list));
}

/* ======= Artistes (grid + detail) ======================================== */
function renderArtists() {
  const grid = $("#artistGrid");
  if (!grid) return;
  const q = ($("#search")?.value || "").toLowerCase();
  grid.innerHTML = "";
  const map = groupArtists();
  [...map.values()]
    .filter((ar) => !q || ar.name.toLowerCase().includes(q))
    .forEach((ar) => {
      const div = document.createElement("div");
      div.className = "card";
      // Monogramme si pas de cover
      const ph = `<div class="cv cv-mono">${(ar.name || "—")
        .slice(0, 2)
        .toUpperCase()}</div>`;
      div.innerHTML = `${
        ar.cover ? `<img class="cv" src="${ar.cover}" alt="">` : ph
      }
        <div class="ttl">${ar.name}</div>
        <div class="sub">${ar.count} titre(s)</div>`;
      div.onclick = () => showArtistDetail(ar.name);
      grid.appendChild(div);
    });
}
function showArtistDetail(name) {
  state.scope = { type: "artistDetail", name };
  [
    "#viewSongs",
    "#viewAlbums",
    "#viewPlaylists",
    "#albumView",
    "#playlistView",
  ].forEach((sel) => $(sel) && ($(sel).style.display = "none"));
  $("#artistView") && ($("#artistView").style.display = "block");
  $("#currentScope") && ($("#currentScope").textContent = "Artiste – " + name);
  renderArtistDetail(name);
}
async function renderArtistDetail(name) {
  const q = ($("#search")?.value || "").toLowerCase();

  // 🎯 Filtrer les chansons de cet artiste
  const list = state.songs
    .filter(
      (s) => (s.artist || "").toLowerCase() === (name || "").toLowerCase()
    )
    .filter((s) => searchMatch(s, q));

  // ✅ Grouper par album
  const albums = new Map();
  for (const s of list) {
    const al = s.album || "Sans album";
    if (!albums.has(al)) albums.set(al, []);
    albums.get(al).push(s);
  }

  // 🎨 Header artiste
  const firstCover = list.find((s) => s.coverDataUrl)?.coverDataUrl || "";
  const [r, g, b] = await dominantColor(firstCover);

  $("#artistTitle") && ($("#artistTitle").textContent = name || "—");
  $("#artistSub") &&
    ($("#artistSub").textContent = `${list.length} titre(s) • ${fmt(
      list.reduce((a, s) => a + (s.duration || 0), 0)
    )}`);
  $("#artistCover") && ($("#artistCover").src = firstCover);
  $("#artistHero") &&
    ($(
      "#artistHero"
    ).style.background = `linear-gradient(180deg, rgba(${r},${g},${b},.45), transparent 420px)`);

  // 🎯 Contenu : afficher chaque album
  const tbody = $("#artistTbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  for (const [albumName, songs] of albums.entries()) {
    // 🎵 Ligne de titre d'album
    const trHead = document.createElement("tr");
    trHead.innerHTML = `
      <td colspan="8" style="font-weight:800; font-size:1.1rem; padding-top:1em;">
        ${albumName}
      </td>`;
    tbody.appendChild(trHead);

    // 🎵 Lignes des chansons
    songs.forEach((song, i) => {
      const tr = makeSongRow(song, i);
      tbody.appendChild(tr);
    });
  }

  wireSongTableActions(tbody);

  // ✅ Colonnes : on cache juste "Artiste" (puisqu'on est déjà dans la vue artiste)
  const tbl = document.querySelector("#artistView table");
  if (tbl) {
    tbl.classList.add("cols--no-artist");
    tbl.classList.remove("cols--no-album");
  }

  // 🎧 Actions play/shuffle
  $("#artistPlay") && ($("#artistPlay").onclick = () => queueAndPlay(list));
  $("#artistShuffle") &&
    ($("#artistShuffle").onclick = () => queueAndShuffle(list));
}

/* ======= Grille/Liste Chansons (desktop + mobile) ======================== */
// Fabrique une ligne <tr> + câblage actions, pour un morceau
function makeSongRow(song, indexForTable) {
  const tr = document.createElement("tr");
  tr.className = "row";
  tr.dataset.id = song.id;
  const checked = state.selection.has(song.id) ? "checked" : "";
  tr.innerHTML = `
    <td>${
      state.selectMode
        ? `<input type="checkbox" class="sel" ${checked} data-sel="${song.id}">`
        : indexForTable + 1
    }</td>
    <td>
      <div class="song">
        <div class="thumb">${
          song.coverDataUrl ? `<img src="${song.coverDataUrl}" alt="">` : "🎵"
        }</div>
        <div style="display:grid">
          <div style="font-weight:800;max-width:48vw;white-space:nowrap;text-overflow:ellipsis;overflow:hidden">${
            song.name || "(sans titre)"
          }</div>
          <div class="muted" style="font-size:.85rem">${
            song.album || "Sans album"
          }</div>
        </div>
      </div>
    </td>
 <td>
  ${
    song.artist
      ? `<button class="link artist-link" data-artist="${song.artist}">${song.artist}</button>`
      : "—"
  }
</td>

    <td>${song.album || "—"}</td>
    <td class="dur-cell"><span>${
      song.duration ? fmt(song.duration) : "—"
    }</span></td>
    <td>
      ${
        state.selectMode
          ? ""
          : `<button class="btn icon" data-like="${song.id}"><span>
        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-heart"><path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"/></svg>
      </span></button>`
      }
    </td>
    <td style="display:flex;gap:6px;justify-content:flex-end">
      ${
        state.selectMode
          ? ""
          : `
        <button class="btn icon" title="Ajouter à une playlist" data-addtopl="${song.id}"><span>
          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
        </span></button>
        <button class="btn icon" title="Modifier" data-edit="${song.id}"><span>
          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pen-line"><path d="M13 21h8"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>
        </span></button>
        <button class="btn icon inline-del" title="Supprimer" data-del="${song.id}"><span>
          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash-2"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </span></button>`
      }
    </td>`;
  tr.onclick = (e) => {
    if (e.target.closest("button") || e.target.closest("input.sel")) return;
    if (!state.selectMode) playById(song.id);
  };
  return tr;
}

// Câbler les actions d’une table
function wireSongTableActions(container) {
  $$("input.sel", container).forEach((cb) => {
    cb.onchange = () => toggleSelect(cb.dataset.sel, cb.checked);
  });
  $$("[data-like]", container).forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        toggleLike(b.dataset.like, b);
      })
  );
  $$("[data-addtopl]", container).forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        openAddToPlaylistDialog(b.dataset.addtopl);
      })
  );
  $$("[data-edit]", container).forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        openEditSong(b.dataset.edit);
      })
  );
  $$("[data-del]", container).forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        deleteSong(b.dataset.del);
      })
  );

  $$("button[data-artist]", container).forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        const name = b.dataset.artist;
        if (name) showArtistDetail(name);
      })
  );

  hydrateIcons(container);
}

// Rendu table + liste mobile
function renderSongTable(tbodySel, list) {
  // Desktop table
  const tbody = $(tbodySel);
  if (tbody) {
    tbody.innerHTML = "";
    list.forEach((s, i) => tbody.appendChild(makeSongRow(s, i)));
    wireSongTableActions(tbody);
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
          <button class="kebab" title="Favori" data-like="${
            s.id
          }"><span>❤</span></button>
          <button class="kebab" title="Ajouter" data-addtopl="${
            s.id
          }"><span>＋</span></button>
          <button class="kebab danger" title="Supprimer" data-del="${
            s.id
          }"><span>🗑</span></button>
        </div>`;
      div.onclick = (e) => {
        if (!e.target.closest(".actions") && !state.selectMode) playById(s.id);
      };
      ml.appendChild(div);
    });
    wireSongTableActions(ml);
  }

  // Sous-titre et header theme
  $("#songsSubtitle") &&
    ($("#songsSubtitle").textContent = `${list.length} titre${
      list.length > 1 ? "s" : ""
    }`);
  applySongsHeaderTheme();
}

// Vue “Tous les morceaux”
function renderSongs() {
  const list = currentList();
  renderSongTable("#songTbody", list);

  // ✅ Vue “tous” : montrer toutes les colonnes
  document.querySelectorAll("#viewSongs table").forEach((t) => {
    t.classList.remove("cols--no-artist", "cols--no-album");
  });
}

/* ======= Helpers Queue/Play ============================================== */
function queueAndPlay(list) {
  state.queue = list.map((s) => s.id);
  state.currentIndex = -1;
  playIndex(0);
}
function queueAndShuffle(list) {
  state.queue = list.map((s) => s.id);
  shuffleArray(state.queue);
  playIndex(0);
}

/* ======= Player =========================================================== */
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
  audio.paused ? play() : pause();
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
  play();
}
function next() {
  if (!state.queue.length) return;
  let i = state.currentIndex + 1;
  if (i >= state.queue.length) {
    // Avec repeat="all", on reboucle au début
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

/* ======= Import =========================================================== */
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
  switch (state.scope.type) {
    case "albumGrid":
      renderAlbums();
      break;
    case "playlistGrid":
      renderPlaylistsGrid();
      break;
    case "playlistDetail":
      renderPlaylistDetail(state.currentPlaylistId);
      break;
    case "artistGrid":
      renderArtists();
      break;
    case "albumDetail":
      renderAlbumDetail(state.scope.name);
      break;
    case "artistDetail":
      renderArtistDetail(state.scope.name);
      break;
    default:
      renderSongs();
  }
  attachAlbumAutocomplete();
  attachArtistAutocomplete();
}

/* ======= CRUD chanson ===================================================== */
async function saveSongFromForm() {
  const title = $("#songTitle").value.trim();
  const artist = $("#songArtist").value.trim();
  const album = $("#songAlbum").value.trim();
  const fAudio = $("#songFile").files[0];
  const fCover = $("#songCover").files[0];

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
    const id = $("#songDialog").dataset.editingId;
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
  songDialog.close();
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
  attachArtistAutocomplete();
  songDialog.showModal();
}
async function deleteSong(id) {
  if (!confirm("Supprimer cette chanson ?")) return;
  await DB.del("songs", id);
  state.songs = state.songs.filter((s) => s.id !== id);

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

/* ======= Favoris ========================================================== */
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

/* ======= Playlists (sidebar + CRUD) ====================================== */
async function renderPlaylists() {
  const wrap = $("#playlists");
  if (!wrap) return;
  wrap.innerHTML = "";
  const pls = await DB.all("playlists");
  pls.forEach((pl) => {
    const a = document.createElement("div");
    a.className = "playlist-item";
    a.innerHTML = `
      <div class="pl-cover">${
        pl.image ? `<img src="${pl.image}" alt="image">` : "🎧"
      }</div>
      <div>
        <div class="pl-title">${pl.name}</div>
        <div class="muted" style="font-size:.85rem">${
          pl.ids?.length || 0
        } titre(s)</div>
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn icon" data-openpl="${
          pl.id
        }" title="Ouvrir"><span>📂</span></button>
        <button class="btn icon" data-editpl="${
          pl.id
        }" title="Modifier"><span>✎</span></button>
        <button class="btn icon" data-delpl="${
          pl.id
        }" title="Supprimer"><span>🗑</span></button>
      </div>`;
    a.onclick = (e) => {
      if (!e.target.closest("button")) showPlaylistDetail(pl.id);
    };
    wrap.appendChild(a);
  });
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
async function openAddToPlaylistDialog(songId) {
  const body = $("#plAddBody");
  if (!body) return;
  body.innerHTML = "";
  const pls = await DB.all("playlists");
  if (!pls.length) {
    if (confirm("Aucune playlist. En créer une ?")) openNewPlaylistDialog();
    return;
  }

  // ✅ correction : checkboxes au lieu de radios (plusieurs playlists possibles)
  pls.forEach((pl) => {
    const line = document.createElement("label");
    line.style.cssText = "display:flex;align-items:center;gap:10px";
    line.innerHTML = `<input type="checkbox" name="plAdd" value="${pl.id}" />
      <div class="pl-cover" style="width:40px;height:40px">${
        pl.image ? `<img src="${pl.image}">` : "🎧"
      }</div>
      <div>${pl.name}</div>`;
    body.appendChild(line);
  });

  plAddDialog.showModal();
  $("#plAddConfirm") &&
    ($("#plAddConfirm").onclick = async () => {
      const chosen = [...body.querySelectorAll('input[name="plAdd"]:checked')];
      if (!chosen.length) {
        alert("Choisis au moins une playlist.");
        return;
      }
      for (const chk of chosen) {
        const pl = await DB.get("playlists", chk.value);
        pl.ids = pl.ids || [];
        if (!pl.ids.includes(songId)) pl.ids.push(songId);
        await DB.put("playlists", pl);
      }
      plAddDialog.close();
      renderPlaylists();
      if (state.scope.type === "playlistDetail")
        renderPlaylistDetail(state.currentPlaylistId);
    });
}

/* ======= Sélection multiple ============================================== */
function enterSelectMode(on = true) {
  state.selectMode = on;
  state.selection.clear();
  switch (state.scope.type) {
    case "albumDetail":
      renderAlbumDetail(state.scope.name);
      break;
    case "playlistDetail":
      renderPlaylistDetail(state.currentPlaylistId);
      break;
    case "artistDetail":
      renderArtistDetail(state.scope.name);
      break;
    case "albumGrid":
      renderAlbums();
      break;
    case "playlistGrid":
      renderPlaylistsGrid();
      break;
    case "artistGrid":
      renderArtists();
      break;
    default:
      renderSongs();
  }
  updateBulkBar();
}
function toggleSelect(id, checked) {
  if (checked) state.selection.add(id);
  else state.selection.delete(id);
  updateBulkBar();
}
function selectAllVisible() {
  const ids = currentList().map((s) => s.id);
  ids.forEach((id) => state.selection.add(id));
  updateBulkBar();
  switch (state.scope.type) {
    case "albumDetail":
      renderAlbumDetail(state.scope.name);
      break;
    case "playlistDetail":
      renderPlaylistDetail(state.currentPlaylistId);
      break;
    case "artistDetail":
      renderArtistDetail(state.scope.name);
      break;
    default:
      renderSongs();
  }
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
function updateBulkBar() {
  const bar = $("#bulkBar");
  if (!bar) return;
  bar.hidden = !state.selectMode;
  $("#bulkCount") && ($("#bulkCount").textContent = state.selection.size);
}

/* ======= Autocomplete (Albums & Artistes réutilisables) ================== */
function getAlbumNames() {
  const set = new Set();
  state.songs.forEach((s) => {
    const a = (s.album || "").trim();
    if (a) set.add(a);
  });
  return [...set].sort((a, b) => a.localeCompare(b));
}
function getArtistNames() {
  const set = new Set();
  state.songs.forEach((s) => {
    const a = (s.artist || "").trim();
    if (a) set.add(a);
  });
  return [...set].sort((a, b) => a.localeCompare(b));
}
function ensureDatalist(id) {
  let dl = $(id);
  if (!dl) {
    dl = document.createElement("datalist");
    dl.id = id.replace(/^#/, "");
    document.body.appendChild(dl);
  }
  return dl;
}
function attachAlbumAutocomplete() {
  const input = $("#songAlbum");
  if (!input) return;
  const dl = ensureDatalist("#albumOptions");
  dl.innerHTML = getAlbumNames()
    .map((n) => `<option value="${n}"></option>`)
    .join("");
  input.setAttribute("list", "albumOptions");
}
function attachArtistAutocomplete() {
  const input = $("#songArtist");
  if (!input) return;
  const dl = ensureDatalist("#artistOptions");
  dl.innerHTML = getArtistNames()
    .map((n) => `<option value="${n}"></option>`)
    .join("");
  input.setAttribute("list", "artistOptions");
}

/* ======= Edit Artist (dialog helpers optionnels) ========================= */
async function openEditArtistDialog(artistName) {
  const imgMap = await getArtistImagesMap();
  $("#artistDialog")?.setAttribute("data-artist", artistName);
  $("#artistDialogTitle") &&
    ($("#artistDialogTitle").textContent =
      "Image de l’artiste — " + artistName);
  $("#artistImagePreview") &&
    ($("#artistImagePreview").src = imgMap[artistName] || "");
  $("#artistImageInput") && ($("#artistImageInput").value = "");
  artistDialog?.showModal?.();
}

/* ======= Gestes mobiles (swipe) ========================================== */
function initGestures() {
  const area = $("#npCover") || $("#nowCover") || document;
  let sx = 0,
    sy = 0,
    dx = 0,
    dy = 0,
    active = false;

  const onStart = (x, y) => {
    sx = x;
    sy = y;
    dx = dy = 0;
    active = true;
  };
  const onMove = (x, y) => {
    if (!active) return;
    dx = x - sx;
    dy = y - sy;
  };
  const onEnd = () => {
    if (!active) return;
    const ax = Math.abs(dx),
      ay = Math.abs(dy);
    const TH = 60;
    if (ax > ay && ax > TH) {
      dx < 0 ? next() : prev();
    } else if (ay > TH) {
      dy < 0 ? nowDialog?.showModal?.() : nowDialog?.close?.();
    }
    active = false;
  };

  area.addEventListener(
    "touchstart",
    (e) => onStart(e.touches[0].clientX, e.touches[0].clientY),
    { passive: true }
  );
  area.addEventListener(
    "touchmove",
    (e) => onMove(e.touches[0].clientX, e.touches[0].clientY),
    { passive: true }
  );
  area.addEventListener("touchend", onEnd);

  let mDown = false;
  area.addEventListener("mousedown", (e) => {
    mDown = true;
    onStart(e.clientX, e.clientY);
  });
  area.addEventListener("mousemove", (e) => {
    if (mDown) onMove(e.clientX, e.clientY);
  });
  area.addEventListener("mouseup", () => {
    if (mDown) {
      onEnd();
      mDown = false;
    }
  });
}

/* ======= Mini-lecteur (Document Picture-in-Picture) ====================== */
let miniWin = null;

async function openMiniPlayer() {
  if (!("documentPictureInPicture" in window)) {
    alert(
      "Mini-lecteur non supporté par ce navigateur.\n(Chrome/Edge récents)"
    );
    return;
  }
  if (miniWin && !miniWin.closed) {
    miniWin.focus();
    return;
  }

  const win = await documentPictureInPicture.requestWindow({
    width: 360,
    height: 120,
  });
  miniWin = win;

  const doc = win.document;
  doc.title = "SRHC Mini Player";
  doc.body.style.cssText = `
    margin:0; font:14px/1.2 system-ui, sans-serif; color:#fff; background:#111;
    display:flex; gap:10px; align-items:center; padding:10px;`;
  doc.body.innerHTML = `
    <img id="mCover" style="width:80px;height:80px;object-fit:cover;border-radius:10px;background:#222"/>
    <div style="flex:1;min-width:0">
      <div id="mTitle" style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>
      <div id="mArtist" style="opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>
      <input id="mSeek" type="range" min="0" max="1000" value="0" style="width:100%">
      <div style="display:flex;gap:8px;align-items:center">
        <button id="mPrev">⏮</button>
        <button id="mPlay">▶️</button>
        <button id="mNext">⏭</button>
        <div id="mTimes" style="margin-left:auto;opacity:.7"></div>
      </div>
    </div>`;

  // Wire des boutons
  doc.getElementById("mPrev").onclick = () => prev();
  doc.getElementById("mNext").onclick = () => next();
  doc.getElementById("mPlay").onclick = () => smartPlay();
  doc.getElementById("mSeek").oninput = (e) => {
    const pos = +e.target.value / 1000;
    if (audio.duration) audio.currentTime = pos * audio.duration;
  };

  // Sync UI
  const sync = () => {
    const id = state.queue[state.currentIndex];
    const s = state.songs.find((x) => x.id === id);
    if (s) {
      doc.getElementById("mTitle").textContent = s.name || "—";
      doc.getElementById("mArtist").textContent = s.artist || "—";
      doc.getElementById("mCover").src = s.coverDataUrl || "";
    }
    doc.getElementById("mPlay").textContent = audio.paused ? "▶️" : "⏸";
    const seek = doc.getElementById("mSeek");
    if (audio.duration) {
      const val = Math.floor((audio.currentTime / audio.duration) * 1000);
      seek.value = val;
    } else seek.value = 0;
    doc.getElementById("mTimes").textContent = `${fmt(
      audio.currentTime
    )} / ${fmt(audio.duration || 0)}`;
  };
  sync();

  const onTime = () => {
    if (miniWin && !miniWin.closed) sync();
  };
  audio.addEventListener("timeupdate", onTime);
  audio.addEventListener("play", onTime);
  audio.addEventListener("pause", onTime);
  win.addEventListener("pagehide", () => {
    audio.removeEventListener("timeupdate", onTime);
    audio.removeEventListener("play", onTime);
    audio.removeEventListener("pause", onTime);
    miniWin = null;
  });

  const _updateNowUI = updateNowUI;
  updateNowUI = function (s) {
    _updateNowUI(s);
    if (miniWin && !miniWin.closed) sync();
  };
}
document.getElementById("btnMini")?.addEventListener("click", openMiniPlayer);

function showAlbumDetail(name) {
  state.scope = { type: "albumDetail", name };
  [
    "#viewSongs",
    "#viewAlbums",
    "#viewPlaylists",
    "#playlistView",
    "#artistView",
  ].forEach((sel) => $(sel) && ($(sel).style.display = "none"));
  $("#albumView") && ($("#albumView").style.display = "block");
  $("#currentScope") && ($("#currentScope").textContent = "Album – " + name);
  renderAlbumDetail(name);
}

/* ======= FIN ============================================================== */
hydrateIcons(document);
