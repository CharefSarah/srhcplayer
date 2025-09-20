/* ======= Icônes ======= */
function setIcon(el, name, size = 20) {
  if (!el || !window.lucide || !lucide.icons[name]) return;
  el.innerHTML = lucide.icons[name].toSvg({ width: size, height: size });
}
function hydrateIcons(root = document) {
  const els = root.querySelectorAll?.(".i[data-i]") || [];
  els.forEach((el) =>
    setIcon(el, el.dataset.i, el.classList.contains("big") ? 28 : 20)
  );
}

/* ======= Utils ======= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
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
  $(
    "#main"
  ).style.background = `linear-gradient(180deg, rgba(${r},${g},${b},.12), transparent 240px), var(--panel-2)`;
  const nd = $("#nowDialog");
  if (nd)
    nd.style.background = `linear-gradient(180deg, rgba(${r},${g},${b},.22), var(--panel-2))`;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", rgb2hex(r, g, b));
}
async function applySongsHeaderTheme() {
  const first = state.songs.find((s) => s.coverDataUrl)?.coverDataUrl || "";
  const [r, g, b] = await dominantColor(first);
  $(
    "#songsHeader"
  ).style.background = `linear-gradient(180deg, rgba(${r},${g},${b},.55), transparent 180px)`;
}

/* ======= DB ======= */
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

/* ======= State ======= */
const state = {
  scope: { type: "all" },
  songs: [],
  favorites: new Set(),
  queue: [],
  currentIndex: -1,
  shuffle: false,
  repeat: "off",
  currentPlaylistId: null,
};

/* ======= Queue helpers ======= */
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

let audio = new Audio();
audio.preload = "metadata";

/* ======= Media Session ======= */
function setMediaSession(song) {
  if (!("mediaSession" in navigator)) return;
  const artwork = song.coverDataUrl
    ? [
        { src: song.coverDataUrl, sizes: "96x96", type: "image/png" },
        { src: song.coverDataUrl, sizes: "256x256", type: "image/png" },
        { src: song.coverDataUrl, sizes: "512x512", type: "image/png" },
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
      if (d.fastSeek && "fastSeek" in audio) {
        audio.fastSeek(d.seekTime);
      } else {
        audio.currentTime = d.seekTime;
      }
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

/* ======= Bootstrap ======= */
(async function () {
  hydrateIcons(document);
  await DB.open();
  const favs = await DB.get("prefs", "favorites");
  if (favs) state.favorites = new Set(favs.val);
  state.songs = await DB.all("songs");
  renderPlaylists(); // sidebar
  renderSideAlbums();
  setScope({ type: "all" });
  bindUI();
})();

/* ======= Bindings ======= */
function bindUI() {
  $("#btnFavorites").onclick = () => setScope({ type: "fav" });
  $("#btnAlbums").onclick = showAlbums;
  $("#btnPlaylists").onclick = showPlaylists;

  $("#btnNewPlaylist").onclick = openNewPlaylistDialog;

  $("#search").addEventListener("input", () => {
    if (state.scope.type === "albumDetail") renderAlbumDetail(state.scope.name);
    else if (state.scope.type === "playlistDetail")
      renderPlaylistDetail(state.currentPlaylistId);
    else renderSongs();
  });

  // Song dialog widgets
  $("#btnAddSong").onclick = () => songDialog.showModal();
  $("#songCover").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (f) $("#songCoverPreview").src = await readAsDataURL(f);
  });
  $("#saveSong").addEventListener("click", saveSongFromForm);

  // Player controls
  $("#volume").oninput = (e) => {
    audio.volume = +e.target.value;
    e.target.style.setProperty(
      "--_val",
      Math.floor(+e.target.value * 100) + "%"
    );
  };
  $("#seek").oninput = (e) => {
    const pos = +e.target.value / 1000;
    if (audio.duration) audio.currentTime = pos * audio.duration;
    e.target.style.setProperty("--_val", e.target.value / 10 + "%");
  };
  $("#btnShuffle").onclick = () => {
    state.shuffle = !state.shuffle;
    $("#btnShuffle").classList.toggle("primary", state.shuffle);
    rebuildQueue();
  };
  $("#btnRepeat").onclick = () => {
    state.repeat =
      state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
    $("#btnRepeat").title = "Répéter: " + state.repeat;
  };
  $("#btnPrev").onclick = prev;
  $("#btnNext").onclick = next;
  $("#btnPlay").onclick = smartPlay;
  $("#btnExpand").onclick = () => nowDialog.showModal();
  $("#btnLike").onclick = toggleLikeCurrent;

  // Big mobile header play
  $("#songsPlayBig").onclick = () => {
    rebuildQueue();
    if (state.queue.length) playIndex(0);
  };

  // Fullscreen player mirroring
  $("#npShuffle").onclick = () => $("#btnShuffle").click();
  $("#npPrev").onclick = () => $("#btnPrev").click();
  $("#npNext").onclick = () => $("#btnNext").click();
  $("#npRepeat").onclick = () => $("#btnRepeat").click();
  $("#npPlay").onclick = () => $("#btnPlay").click();
  $("#npSeek").oninput = (e) => {
    const p = +e.target.value / 1000;
    if (audio.duration) audio.currentTime = p * audio.duration;
    e.target.style.setProperty("--_val", e.target.value / 10 + "%");
  };

  // Audio events
  audio.addEventListener("timeupdate", () => {
    $("#cur").textContent = fmt(audio.currentTime);
    $("#dur").textContent = fmt(audio.duration || 0);
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
    $("#npCur").textContent = fmt(audio.currentTime);
    $("#npDur").textContent = fmt(audio.duration || 0);
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
    if (state.repeat === "one") {
      playIndex(state.currentIndex);
    } else {
      next();
    }
  });

  // Drawer mobile
  $("#btnToggleAside").onclick = toggleAside;
  $("#drawerMask").onclick = closeAside;
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAside();
  });
}

/* ======= Drawer mobile ======= */
function toggleAside() {
  document.body.classList.toggle("aside-open");
  const open = document.body.classList.contains("aside-open");
  $("#drawerMask").hidden = !open;
  requestAnimationFrame(() => $("#drawerMask").classList.toggle("show", open));
}
function closeAside() {
  document.body.classList.remove("aside-open");
  $("#drawerMask").classList.remove("show");
  setTimeout(() => ($("#drawerMask").hidden = true), 160);
}

/* ======= Views ======= */
function setScope(scope) {
  state.scope = scope;
  // hide all
  $("#viewSongs").style.display = "none";
  $("#viewAlbums").style.display = "none";
  $("#viewPlaylists").style.display = "none";
  $("#albumView").style.display = "none";
  $("#playlistView").style.display = "none";

  if (scope.type === "albumGrid") {
    $("#viewAlbums").style.display = "block";
    $("#currentScope").textContent = "Albums";
    renderAlbums();
  } else if (scope.type === "playlistGrid") {
    $("#viewPlaylists").style.display = "block";
    $("#currentScope").textContent = "Playlists";
    renderPlaylistsGrid();
  } else if (scope.type === "albumDetail") {
    $("#albumView").style.display = "block";
    $("#currentScope").textContent = "Album – " + (scope.name || "");
    renderAlbumDetail(scope.name);
  } else if (scope.type === "playlistDetail") {
    $("#playlistView").style.display = "block";
    $("#currentScope").textContent = "Playlist – " + (scope.name || "");
    renderPlaylistDetail(state.currentPlaylistId);
  } else {
    $("#viewSongs").style.display = "block";
    $("#currentScope").textContent =
      scope.type === "fav" ? "Favoris" : "Musique";
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

function showAlbumDetail(name) {
  state.scope = { type: "albumDetail", name };
  $("#viewSongs").style.display = "none";
  $("#viewAlbums").style.display = "none";
  $("#viewPlaylists").style.display = "none";
  $("#playlistView").style.display = "none";
  $("#albumView").style.display = "block";
  $("#currentScope").textContent = "Album – " + name;
  renderAlbumDetail(name);
}
async function showPlaylistDetail(id) {
  state.currentPlaylistId = id;
  const pl = await DB.get("playlists", id);
  const name = pl?.name || "—";
  state.scope = { type: "playlistDetail", id, name, ids: pl?.ids || [] };
  $("#viewSongs").style.display = "none";
  $("#viewAlbums").style.display = "none";
  $("#viewPlaylists").style.display = "none";
  $("#albumView").style.display = "none";
  $("#playlistView").style.display = "block";
  $("#currentScope").textContent = "Playlist – " + name;
  await renderPlaylistDetail(id);
}

/* ======= Side albums ======= */
function renderSideAlbums() {
  const side = $("#sideAlbums");
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
function renderAlbums() {
  const grid = $("#albumGrid");
  grid.innerHTML = "";
  const map = groupAlbums();
  [...map.values()].forEach((al) => {
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

/* ======= Grille Playlists ======= */
async function renderPlaylistsGrid() {
  const grid = $("#playlistGrid");
  grid.innerHTML = "";
  const pls = await DB.all("playlists");
  pls.forEach((pl) => {
    const count = pl.ids?.length || 0;
    const cover = pl.image || "";
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<img class="cv" src="${cover}" alt=""><div class="ttl">${pl.name}</div><div class="sub">${count} titre(s)</div>`;
    card.onclick = () => showPlaylistDetail(pl.id);
    grid.appendChild(card);
  });
}

/* ======= Album detail ======= */
async function renderAlbumDetail(name) {
  const list = state.songs.filter(
    (s) => (s.album || "").toLowerCase() === name.toLowerCase()
  );
  const art = list[0]?.artist || "—";
  const cover = list.find((s) => s.coverDataUrl)?.coverDataUrl || "";
  $("#albumTitle").textContent = name;
  $("#albumSub").textContent = `${art} • ${list.length} titre(s) • ${fmt(
    list.reduce((a, s) => a + (s.duration || 0), 0)
  )}`;
  $("#albumCover").src = cover;
  const [r, g, b] = await dominantColor(cover);
  $(
    "#albumHero"
  ).style.background = `linear-gradient(180deg, rgba(${r},${g},${b},.45), transparent 420px)`;

  const tbody = $("#albumTbody");
  tbody.innerHTML = "";
  list.forEach((s, i) => {
    const tr = document.createElement("tr");
    tr.className = "row";
    tr.innerHTML = `<td>${i + 1}</td>
      <td><div class="song"><div class="thumb">${
        s.coverDataUrl ? `<img src="${s.coverDataUrl}">` : "🎵"
      }</div>
      <div style="display:grid"><div style="font-weight:800">${
        s.name || "(sans titre)"
      }</div><div class="muted" style="font-size:.85rem">${
      s.artist || "—"
    }</div></div></div></td>
      <td>${s.duration ? fmt(s.duration) : "—"}</td>
      <td><button class="btn icon" data-like="${
        s.id
      }"><span><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-heart-icon lucide-heart"><path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"/></svg></span></button></td>
      <td style="display:flex;gap:6px;justify-content:flex-end">
        <button class="btn icon" data-play="${
          s.id
        }"><span><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-play-icon lucide-play"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/></svg></span></button>
        <button class="btn icon" data-addtopl="${
          s.id
        }"><span><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus-icon lucide-plus"><path d="M5 12h14"/><path d="M12 5v14"/></svg></span></button>
      </td>`;
    tr.onclick = (e) => {
      if (e.target.closest("button")) return;
      playById(s.id);
    };
    tbody.appendChild(tr);
  });
  hydrateIcons(tbody);
  $$("[data-play]").forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        playById(b.dataset.play);
      })
  );
  $$("[data-like]").forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        toggleLike(b.dataset.like, b);
      })
  );
  $$("[data-addtopl]").forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        openAddToPlaylistDialog(b.dataset.addtopl);
      })
  );

  $("#albumPlay").onclick = () => {
    state.queue = list.map((s) => s.id);
    state.currentIndex = -1;
    playIndex(0);
  };
  $("#albumShuffle").onclick = () => {
    state.queue = list.map((s) => s.id);
    for (let i = state.queue.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
    }
    playIndex(0);
  };
}

/* ======= Songs list ======= */
async function renderSongs() {
  const q = ($("#search").value || "").toLowerCase();
  let list = state.songs.slice();
  if (state.scope.type === "playlist") {
    const ids = state.scope.ids || [];
    list = list.filter((s) => ids.includes(s.id));
  }
  if (state.scope.type === "fav")
    list = list.filter((s) => state.favorites.has(s.id));
  if (q)
    list = list.filter((s) =>
      (s.name + " " + (s.artist || "") + " " + (s.album || ""))
        .toLowerCase()
        .includes(q)
    );

  $("#songsSubtitle").textContent = `${list.length} titre${
    list.length > 1 ? "s" : ""
  }`;
  applySongsHeaderTheme();

  const tbody = $("#songTbody");
  tbody.innerHTML = "";
  list.forEach((s, i) => {
    const tr = document.createElement("tr");
    tr.className = "row";
    tr.dataset.id = s.id;
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td><div class="song">
        <div class="thumb">${
          s.coverDataUrl ? `<img src="${s.coverDataUrl}" alt="">` : "🎵"
        }</div>
        <div style="display:grid">
          <div style="font-weight:800;max-width:48vw;white-space:nowrap;text-overflow:ellipsis;overflow:hidden">${
            s.name || "(sans titre)"
          }</div>
          <div class="muted" style="font-size:.85rem">${
            s.album || "Sans album"
          }</div>
        </div>
      </div></td>
      <td>${s.artist || "—"}</td>
      <td>${s.album || "—"}</td>
      <td>${s.duration ? fmt(s.duration) : "—"}</td>
      <td><button class="btn icon" data-like="${
        s.id
      }"><span><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-heart-icon lucide-heart"><path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"/></svg></span></button></td>
      <td style="display:flex;gap:6px;justify-content:flex-end">
        <button class="btn icon" title="Lire" data-play="${
          s.id
        }"><span><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-play-icon lucide-play"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/></svg></span></button>
        <button class="btn icon" title="Ajouter à une playlist" data-addtopl="${
          s.id
        }"><span><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus-icon lucide-plus"><path d="M5 12h14"/><path d="M12 5v14"/></svg></span></button>
        <button class="btn icon" title="Modifier" data-edit="${
          s.id
        }"><span><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pen-line-icon lucide-pen-line"><path d="M13 21h8"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg></span></button>
        <button class="btn icon" title="Supprimer" data-del="${
          s.id
        }"><span><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash2-icon lucide-trash-2"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></span></button>
      </td>`;
    tr.onclick = (e) => {
      if (e.target.closest("button")) return;
      playById(s.id);
    };
    tbody.appendChild(tr);
  });
  hydrateIcons(tbody);

  // Liste mobile
  const ml = $("#songListMobile");
  ml.innerHTML = "";
  list.forEach((s) => {
    const div = document.createElement("div");
    div.className = "item";
    div.dataset.id = s.id;
    div.innerHTML = `
      <div class="cover">${
        s.coverDataUrl ? `<img src="${s.coverDataUrl}" alt="">` : "🎵"
      }</div>
      <div><div class="t">${s.name || "(sans titre)"}</div><div class="a">${
      s.artist || "—"
    }</div></div>
      <div class="actions">
        <button class="kebab" title="Favori" data-like="${
          s.id
        }"><span><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-heart-icon lucide-heart"><path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"/></svg></span></button>
        <button class="kebab" title="Plus" data-addtopl="${
          s.id
        }"><span><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus-icon lucide-plus"><path d="M5 12h14"/><path d="M12 5v14"/></svg></span></button>
      </div>`;
    div.onclick = (e) => {
      if (e.target.closest(".actions")) return;
      playById(s.id);
    };
    ml.appendChild(div);
  });
  hydrateIcons(ml);

  $$("[data-play]").forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        playById(b.dataset.play);
      })
  );
  $$("[data-like]").forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        toggleLike(b.dataset.like, b);
      })
  );
  $$("[data-addtopl]").forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        openAddToPlaylistDialog(b.dataset.addtopl);
      })
  );
  $$("[data-edit]").forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        openEditSong(b.dataset.edit);
      })
  );
  $$("[data-del]").forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        deleteSong(b.dataset.del);
      })
  );
}

/* ======= Player ======= */
function smartPlay() {
  if (!audio.src || audio.src === window.location.href) {
    if (!state.queue.length) {
      rebuildQueue();
    }
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
  $("#nowTitle").textContent = s.name || "—";
  $("#nowArtist").textContent = s.artist || "—";
  $("#nowCover").src = s.coverDataUrl || "";
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

/* ======= Import (non UI — appels manuels si tu ajoutes des boutons) ======= */
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
  if (state.scope.type === "albumGrid") renderAlbums();
  else if (state.scope.type === "playlistGrid") renderPlaylistsGrid();
  else if (state.scope.type === "playlistDetail")
    renderPlaylistDetail(state.currentPlaylistId);
  else renderSongs();
}

/* ======= CRUD chanson ======= */
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
  songDialog.showModal();
}
async function deleteSong(id) {
  if (!confirm("Supprimer cette chanson ?")) return;
  await DB.del("songs", id);
  state.songs = state.songs.filter((s) => s.id !== id);
  postImport();
}

/* ======= Favoris ======= */
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
  $("#btnLike").classList.toggle("primary", state.favorites.has(id));
}

/* ======= Playlists: sidebar (list) ======= */
async function renderPlaylists() {
  const wrap = $("#playlists");
  if (!wrap) return;
  wrap.innerHTML = "";
  const pls = await DB.all("playlists");
  pls.forEach((pl) => {
    const a = document.createElement("div");
    a.className = "playlist-item";
    a.innerHTML = `<div class="pl-cover">${
      pl.image ? `<img src="${pl.image}" alt="">` : "🎧"
    }</div>
      <div><div class="pl-title">${
        pl.name
      }</div><div class="muted" style="font-size:.85rem">${
      pl.ids?.length || 0
    } titre(s)</div></div>
      <div style="display:flex;gap:6px">
        <button class="btn icon" data-openpl="${
          pl.id
        }" title="Ouvrir"><span><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-folder-open-icon lucide-folder-open"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg></span></button>
        <button class="btn icon" data-editpl="${
          pl.id
        }" title="Modifier"><span><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pencil-line-icon lucide-pencil-line"><path d="M13 21h8"/><path d="m15 5 4 4"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg></span></button>
        <button class="btn icon" data-delpl="${
          pl.id
        }" title="Supprimer"><span><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash2-icon lucide-trash-2"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></span></button>
      </div>`;
    // rendre toute la ligne cliquable aussi
    a.onclick = (e) => {
      if (e.target.closest("button")) return;
      showPlaylistDetail(pl.id);
    };
    wrap.appendChild(a);
  });
  hydrateIcons(wrap);
  $$("button[data-openpl]").forEach(
    (b) =>
      (b.onclick = async () => {
        await showPlaylistDetail(b.dataset.openpl);
        closeAside();
      })
  );
  $$("button[data-editpl]").forEach(
    (b) => (b.onclick = () => openEditPlaylistDialog(b.dataset.editpl))
  );
  $$("button[data-delpl]").forEach(
    (b) => (b.onclick = () => deletePlaylist(b.dataset.delpl))
  );
}

/* ======= Playlists: CRUD ======= */
function openNewPlaylistDialog() {
  $("#plDialogTitle").textContent = "Nouvelle playlist";
  $("#plName").value = "";
  $("#plCoverPreview").src = "";
  $("#plCoverInput").value = "";
  $("#plCoverInput").onchange = async (e) => {
    const f = e.target.files[0];
    if (f) $("#plCoverPreview").src = await readAsDataURL(f);
  };
  $("#plSave").onclick = async () => {
    const id = crypto.randomUUID();
    const name = $("#plName").value.trim() || "Ma playlist";
    const image = $("#plCoverPreview").src || "";
    await DB.put("playlists", { id, name, image, ids: [] });
    plDialog.close();
    renderPlaylists();
    if (state.scope.type === "playlistGrid") renderPlaylistsGrid();
  };
  plDialog.showModal();
}
async function openEditPlaylistDialog(id) {
  const pl = await DB.get("playlists", id);
  if (!pl) return;
  $("#plDialogTitle").textContent = "Modifier la playlist";
  $("#plName").value = pl.name;
  $("#plCoverPreview").src = pl.image || "";
  $("#plCoverInput").value = "";
  $("#plCoverInput").onchange = async (e) => {
    const f = e.target.files[0];
    if (f) $("#plCoverPreview").src = await readAsDataURL(f);
  };
  $("#plSave").onclick = async () => {
    pl.name = $("#plName").value.trim() || pl.name;
    pl.image = $("#plCoverPreview").src || "";
    await DB.put("playlists", pl);
    plDialog.close();
    renderPlaylists();
    if (
      state.scope.type === "playlistDetail" &&
      state.currentPlaylistId === pl.id
    ) {
      $("#currentScope").textContent = "Playlist – " + pl.name;
      renderPlaylistDetail(pl.id);
    }
    if (state.scope.type === "playlistGrid") renderPlaylistsGrid();
  };
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
  body.innerHTML = "";
  const pls = await DB.all("playlists");
  if (!pls.length) {
    if (confirm("Aucune playlist. En créer une ?")) {
      openNewPlaylistDialog();
    }
    return;
  }
  pls.forEach((pl) => {
    const line = document.createElement("label");
    line.style.display = "flex";
    line.style.alignItems = "center";
    line.style.gap = "10px";
    line.innerHTML = `<input type="radio" name="plAdd" value="${
      pl.id
    }" /> <div class="pl-cover" style="width:40px;height:40px">${
      pl.image ? `<img src="${pl.image}">` : "🎧"
    }</div> <div>${pl.name}</div>`;
    body.appendChild(line);
  });
  plAddDialog.showModal();
  $("#plAddConfirm").onclick = async () => {
    const chosen = body.querySelector('input[name="plAdd"]:checked');
    if (!chosen) {
      alert("Choisis une playlist.");
      return;
    }
    const pl = await DB.get("playlists", chosen.value);
    pl.ids = pl.ids || [];
    if (!pl.ids.includes(songId)) pl.ids.push(songId);
    await DB.put("playlists", pl);
    plAddDialog.close();
    renderPlaylists();
    if (
      state.scope.type === "playlistDetail" &&
      state.currentPlaylistId === pl.id
    )
      renderPlaylistDetail(pl.id);
  };
}

/* ======= Vue Playlist ======= */
async function renderPlaylistDetail(id) {
  const pl = await DB.get("playlists", id);
  if (!pl) {
    setScope({ type: "all" });
    return;
  }
  const ids = pl.ids || [];
  const list = ids
    .map((sid) => state.songs.find((s) => s.id === sid))
    .filter(Boolean);
  const cover =
    pl.image || list.find((s) => s.coverDataUrl)?.coverDataUrl || "";

  $("#playlistTitle").textContent = pl.name || "—";
  const totalDur = list.reduce((a, s) => a + (s?.duration || 0), 0);
  $("#playlistSub").textContent = `${list.length} titre(s) • ${fmt(totalDur)}`;
  $("#playlistCover").src = cover;
  const [r, g, b] = await dominantColor(cover);
  $(
    "#playlistHero"
  ).style.background = `linear-gradient(180deg, rgba(${r},${g},${b},.45), transparent 420px)`;

  const tbody = $("#playlistTbody");
  tbody.innerHTML = "";
  list.forEach((s, i) => {
    const tr = document.createElement("tr");
    tr.className = "row";
    tr.innerHTML = `<td>${i + 1}</td>
      <td><div class="song"><div class="thumb">${
        s.coverDataUrl ? `<img src="${s.coverDataUrl}" alt="">` : "🎵"
      }</div><div style="display:grid"><div style="font-weight:800">${
      s.name || "(sans titre)"
    }</div><div class="muted" style="font-size:.85rem">${
      s.album || "—"
    }</div></div></div></td>
      <td>${s.artist || "—"}</td>
      <td>${s.duration ? fmt(s.duration) : "—"}</td>
      <td><button class="btn icon" data-like="${
        s.id
      }"><span><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-heart-icon lucide-heart"><path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"/></svg></span></button></td>
      <td style="display:flex;gap:6px;justify-content:flex-end">
        <button class="btn icon" title="Lire" data-play="${
          s.id
        }"><span><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-play-icon lucide-play"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/></svg></span></button>
        <button class="btn icon" title="Ajouter à une playlist" data-addtopl="${
          s.id
        }"><span><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus-icon lucide-plus"><path d="M5 12h14"/><path d="M12 5v14"/></svg></span></button>
      </td>`;
    tr.onclick = (e) => {
      if (e.target.closest("button")) return;
      playById(s.id);
    };
    tbody.appendChild(tr);
  });
  hydrateIcons(tbody);

  $$("[data-play]").forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        playById(b.dataset.play);
      })
  );
  $$("[data-like]").forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        toggleLike(b.dataset.like, b);
      })
  );
  $$("[data-addtopl]").forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        openAddToPlaylistDialog(b.dataset.addtopl);
      })
  );

  $("#playlistPlay").onclick = () => {
    state.queue = list.map((s) => s.id);
    state.currentIndex = -1;
    playIndex(0);
  };
  $("#playlistShuffle").onclick = () => {
    state.queue = list.map((s) => s.id);
    for (let i = state.queue.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
    }
    playIndex(0);
  };
}

hydrateIcons(document);
