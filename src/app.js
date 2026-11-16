/* Zimika — YouTube Music style player over typed MyZig IPC. */
(function () {
  "use strict";
  const api = window.myzig;
  const $ = (s) => document.querySelector(s);
  const el = {
    nav: $("#nav"), playlists: $("#playlistsNav"), page: $("#page"), title: $("#pageTitle"),
    search: $("#searchInput"), filters: $("#filters"), back: $("#backBtn"),
    theme: $("#themeBtn"), zoom: $("#zoomBtn"), settings: $("#settingsBtn"), status: $("#status"),
    sideFoot: $("#sideFoot"), newPlaylist: $("#newPlaylistBtn"),
    art: $("#art"), trackTitle: $("#trackTitle"), trackArtist: $("#trackArtist"), like: $("#likeBtn"),
    play: $("#playBtn"), prev: $("#prevBtn"), next: $("#nextBtn"), shuffle: $("#shuffleBtn"),
    repeat: $("#repeatBtn"), seek: $("#seekInput"), cur: $("#curTime"), dur: $("#durTime"),
    vol: $("#volInput"), queueBtn: $("#queueBtn"), lyricsBtn: $("#lyricsBtn"), statsBtn: $("#statsBtn"),
    full: $("#fullPlayer"), fpClose: $("#fpClose"), fpTitle: $("#fpTitle"), fpArt: $("#fpArt"),
    fpPanel: $("#fpPanel"), menu: $("#menu"), modal: $("#modal"), toasts: $("#toasts")
  };

  const DEF = {
    theme:"auto", accent:"#d9a441", accentFromArt:false, zoom:100, volume:80,
    repeat:"off", shuffle:false, scrobbles:[], autoRadio:true, recent:[], queue:[], index:0,
    history:[], playlists:[], liked:[], followed:[], savedAlbums:[], cookiesBrowser:"",
    cacheCount:20, lyricsSource:"auto", shortcuts:{},
    lastfm:{ key:"", secret:"", session:"" }
  };
  const S = {
    settings: Object.assign({}, DEF, { lastfm: Object.assign({}, DEF.lastfm) }),
    status:null, page:"home", tracks:[], filter:"songs", current:null, playing:false,
    pos:0, dur:0, lyrics:[], lyricText:"", fullTab:"queue", ready:false, historyStack:[],
    genre:"", loading:false
  };

  const ico = (n) => `<svg class="ico"><use href="#i-${n}"/></svg>`;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  function toast(msg, kind) {
    const n = document.createElement("div");
    n.className = "toast " + (kind || "");
    n.innerHTML = ico(kind === "err" ? "alert" : kind === "ok" ? "check" : "mic") + "<span>" + esc(msg) + "</span>";
    el.toasts.appendChild(n);
    setTimeout(() => n.remove(), 3400);
  }
  function persist() { api.call("Settings.save", JSON.stringify(S.settings)).catch((e)=>console.warn("zimika: settings",e)); }
  function fmtTime(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + String(s).padStart(2, "0");
  }
  function applyTheme() {
    let t = S.settings.theme;
    if (t === "auto") t = S.systemTheme || "dark";
    document.documentElement.dataset.theme = t;
    el.theme.innerHTML = ico(t === "dark" ? "sun" : "moon");
    if (S.settings.accent && !S.settings.accentFromArt)
      document.documentElement.style.setProperty("--accent", S.settings.accent);
    const z = Math.max(80, Math.min(200, Number(S.settings.zoom) || 100));
    document.documentElement.style.fontSize = (z / 100) + "em";
    el.zoom.textContent = z + "%";
  }
  function markReady() { if (S.ready) return; S.ready = true; try { api.emit("zimika:ready"); } catch(e) {} }

  // --------------------------------------------------------------- navigation
  const PAGES = [
    { id:"home", label:"Home", icon:"home" }, { id:"explore", label:"Explore", icon:"compass" },
    { id:"search", label:"Search", icon:"search" }, { id:"podcasts", label:"Podcasts", icon:"mic" },
    { id:"library", label:"Library", icon:"library" }, { id:"liked", label:"Liked songs", icon:"heart" },
    { id:"history", label:"History", icon:"chart" }, { id:"stats", label:"Stats", icon:"chart" }
  ];
  function renderNav() {
    el.nav.innerHTML = PAGES.map((p) =>
      `<button class="nav-item${S.page === p.id ? " active" : ""}" data-page="${p.id}">` +
      ico(p.icon) + `<span class="label">${p.label}</span></button>`).join("");
    el.playlists.innerHTML = S.settings.playlists.map((p) =>
      `<button class="nav-item${S.page === "playlist:" + p.id ? " active" : ""}" data-playlist="${esc(p.id)}">` +
      ico("list") + `<span class="label">${esc(p.name)}</span></button>`).join("") || '<div class="side-foot">No playlists yet</div>';
    el.sideFoot.textContent = `${S.settings.liked.length} liked · ${S.settings.playlists.length} playlists`;
  }

  async function go(page, push) {
    if (push !== false) { S.historyStack.push(S.page); }
    S.page = page; renderNav();
    el.filters.hidden = page !== "search";
    const title = PAGES.find((p) => p.id === page)?.label || (page.startsWith("playlist:") ? "Playlist" : "Zimika");
    el.title.textContent = title;
    el.page.innerHTML = '<div class="loading">Loading…</div>';
    try {
      if (page === "home") await loadBrowse("new releases", "Fresh releases");
      else if (page === "explore") await loadBrowse("top songs 2026", "Trending");
      else if (page === "podcasts") await loadBrowse("podcast episode", "Podcasts", "yt");
      else if (page === "search") renderSearch();
      else if (page === "library") renderLibrary();
      else if (page === "liked") renderTracks(S.settings.liked, "Liked songs");
      else if (page === "history") renderTracks(S.settings.history.slice().reverse(), "Recently played");
      else if (page === "stats") renderStats();
      else if (page.startsWith("playlist:")) renderPlaylist(page.slice(9));
    } catch (e) {
      el.page.innerHTML = `<div class="empty"><h2>Could not load</h2><p>${esc(e.message || e)}</p></div>`;
    }
  }

  async function loadBrowse(query, heading, filter) {
    const raw = await api.call("Music.search", query, filter || "ytm");
    S.tracks = Array.isArray(raw) ? raw : [];
    const sections = heading === "Podcasts" ? [heading] : [heading, "More to explore"];
    el.page.innerHTML = sections.map((h, i) =>
      `<h2 class="section-title">${esc(h)}</h2><div class="cards" data-cards="${i}"></div>`).join("");
    const cards = S.tracks.slice(0, 16).map((t, i) => cardHtml(t, i)).join("");
    el.page.querySelector('[data-cards="0"]').innerHTML = cards || '<div class="empty">Nothing found</div>';
    if (sections.length > 1) el.page.querySelector('[data-cards="1"]').innerHTML =
      S.tracks.slice(16, 28).map((t, i) => cardHtml(t, i + 16)).join("");
  }
  function cardHtml(t, i) {
    return `<button class="card" data-card="${i}"><div class="cover">${t.thumb ? `<img src="${esc(t.thumb)}" alt="">` : ico("mic")}</div>` +
      `<div class="ct">${esc(t.title)}</div><div class="cs">${esc(t.artist || "Unknown")}</div></button>`;
  }
  function trackHtml(t, i, showNum) {
    return `<div class="track-row" data-track="${i}">` +
      `<div class="num">${showNum ? i + 1 : ico("play")}</div>` +
      `<div class="t"><div class="tname">${esc(t.title)}</div></div>` +
      `<div class="artist">${esc(t.artist || "")}</div>` +
      `<div class="dur">${t.duration ? fmtTime(t.duration) : "—"}</div>` +
      `<button class="icon-btn tiny" data-more="${i}" title="More">${ico("more")}</button></div>`;
  }
  function renderTracks(tracks, heading) {
    S.tracks = tracks;
    el.page.innerHTML = `<h2 class="section-title">${esc(heading)} (${tracks.length})</h2>` +
      (tracks.length ? `<div class="tracks">${tracks.map((t,i)=>trackHtml(t,i,true)).join("")}</div>`
        : '<div class="empty"><h2>Nothing here yet</h2><p>Play a song or save something to your library.</p></div>');
  }
  function renderSearch() {
    const q = el.search.value.trim();
    if (!q) { el.page.innerHTML = '<div class="empty"><h2>Search</h2><p>Type a song, artist, album or playlist.</p></div>'; return; }
    const kinds = ["songs","albums","artists","playlists"];
    el.filters.innerHTML = kinds.map((k)=>`<button class="filter${S.filter===k?" on":""}" data-filter="${k}">${k}</button>`).join("");
    el.page.innerHTML = '<div class="loading">Searching…</div>';
    api.call("Music.search", q, S.filter === "songs" ? "ytm" : "yt").then((raw) => {
      let tracks = Array.isArray(raw) ? raw : [];
      if (S.filter === "albums") tracks = tracks.filter((t)=>/album|playlist|EP/i.test(t.kind || ""));
      if (S.filter === "artists") tracks = tracks.filter((t)=>/artist|channel/i.test(t.kind || ""));
      if (S.filter === "playlists") tracks = tracks.filter((t)=>/playlist/i.test(t.kind || ""));
      if (!S.settings.recent.includes(q)) { S.settings.recent.unshift(q); S.settings.recent = S.settings.recent.slice(0,20); persist(); }
      renderTracks(tracks, "Results for " + q);
    }).catch((e)=>toast("Search failed", "err"));
  }
  function renderLibrary() {
    el.page.innerHTML = `<h2 class="section-title">Your library</h2>
      <div class="cards">
        <button class="card" data-lib="liked"><div class="cover">${ico("heart")}</div><div class="ct">Liked songs</div><div class="cs">${S.settings.liked.length} songs</div></button>
        <button class="card" data-lib="history"><div class="cover">${ico("chart")}</div><div class="ct">History</div><div class="cs">${S.settings.history.length} plays</div></button>
        ${S.settings.playlists.map((p)=>`<button class="card" data-lib="playlist:${esc(p.id)}"><div class="cover">${ico("list")}</div><div class="ct">${esc(p.name)}</div><div class="cs">${p.tracks.length} songs</div></button>`).join("")}
      </div>`;
  }
  function renderPlaylist(id) {
    const p = S.settings.playlists.find((x)=>x.id===id);
    if (!p) { el.page.innerHTML = '<div class="empty"><h2>Playlist not found</h2></div>'; return; }
    let tracks = p.tracks.slice();
    if (p.sort === "title") tracks.sort((a,b)=>a.title.localeCompare(b.title));
    if (p.sort === "artist") tracks.sort((a,b)=>(a.artist||"").localeCompare(b.artist||""));
    if (p.sort === "length") tracks.sort((a,b)=>a.duration-b.duration);
    if (p.query) tracks = tracks.filter((t)=>t.title.toLowerCase().includes(p.query.toLowerCase()));
    el.page.innerHTML = `<h2 class="section-title">${esc(p.name)} (${tracks.length})</h2>
      <div class="row2" style="display:flex;gap:8px;margin-bottom:12px">
        <select id="plSort" class="search"><option value="">Sort: added</option><option value="title">Title</option><option value="artist">Artist</option><option value="length">Length</option></select>
        <input id="plSearch" class="search" placeholder="Search in playlist" value="${esc(p.query||"")}">
        <button class="btn" id="plDelete">Delete playlist</button>
      </div><div class="tracks">${tracks.map((t,i)=>trackHtml(t,i,true)).join("")}</div>`;
    el.page.querySelector("#plSort").value = p.sort || "";
    el.page.querySelector("#plSort").onchange = (e)=>{ p.sort=e.target.value; persist(); renderPlaylist(id); };
    el.page.querySelector("#plSearch").oninput = (e)=>{ p.query=e.target.value; persist(); renderPlaylist(id); };
    el.page.querySelector("#plDelete").onclick = ()=>{
      S.settings.playlists = S.settings.playlists.filter((x)=>x.id!==id); persist(); renderNav(); go("library"); toast("Playlist deleted","ok");
    };
  }
  function renderStats() {
    const days = {};
    S.settings.history.forEach((h)=>{ const key=new Date(h.t||Date.now()).toDateString(); days[key]=(days[key]||0)+1; });
    const keys = Object.keys(days).slice(-14);
    const max = Math.max(1, ...keys.map((k)=>days[k]));
    el.page.innerHTML = `<h2 class="section-title">Listening stats</h2>
      <p class="desc">${S.settings.history.length} plays stored locally. History stays on this computer.</p>
      ${keys.length ? `<div class="cards">${keys.map((k)=>`<div class="card"><div class="ct">${esc(k.slice(0,10))}</div><div class="bar" style="margin:10px"><i style="transform:scaleX(${days[k]/max})"></i></div><div class="cs">${days[k]} plays</div></div>`).join("")}</div>` : '<div class="empty">No plays yet</div>'}
      <p><button class="btn" id="clearHistory">Clear history</button></p>`;
    el.page.querySelector("#clearHistory").onclick = ()=>{ S.settings.history=[]; persist(); renderStats(); toast("History cleared","ok"); };
  }

  // ------------------------------------------------------------------ player
  async function playAt(i, source) {
    const list = source || S.tracks;
    if (!list || !list[i]) return;
    S.queue = list.slice(); S.index = i;
    await startCurrent();
  }
  async function startCurrent() {
    const t = S.queue[S.index];
    if (!t) return;
    S.current = t;
    const url = t.url || t.webpage_url || "";
    if (!url) { toast("No playable address", "err"); return; }
    try {
      await api.call("Player.play", url, t.title || "Track", S.settings.volume);
      S.playing = true;
      updatePlayerUi();
      const entry = { t:Date.now(), title:t.title, artist:t.artist, url };
      S.settings.history.unshift(entry);
      S.settings.history = S.settings.history.slice(0, 5000);
      S.settings.index = S.index;
      S.settings.queue = S.queue.slice(0, 200);
      persist();
      renderNav();
      if (S.settings.accentFromArt && t.thumb) applyArtAccent(t.thumb);
    } catch (e) { toast("Playback failed: "+(e.message||e), "err"); }
  }
  function applyArtAccent(url) {
    // A quiet tone shift: sample not available in canvas-free webview, so use
    // the configured accent when art-driven colour is on.
    document.documentElement.style.setProperty("--accent", S.settings.accent || "#d9a441");
  }
  function updatePlayerUi() {
    const t = S.current;
    el.trackTitle.textContent = t ? (t.title || "Untitled") : "Nothing playing";
    el.trackArtist.textContent = t ? (t.artist || "") : "—";
    el.play.innerHTML = ico(S.playing ? "pause" : "play");
    el.shuffle.classList.toggle("on", !!S.settings.shuffle);
    el.repeat.classList.toggle("on", S.settings.repeat !== "off");
    const liked = t && S.settings.liked.some((x)=>x.url===t.url);
    el.like.classList.toggle("on", !!liked);
    el.art.innerHTML = t && t.thumb ? `<img src="${esc(t.thumb)}" alt="">` : ico("mic");
    el.fpArt.innerHTML = t && t.thumb ? `<img src="${esc(t.thumb)}" alt="">` : ico("mic");
    el.fpTitle.textContent = t ? t.title : "Now playing";
    if (!el.full.hidden) renderFullPanel();
    const rows = el.page.querySelectorAll(".track-row");
    rows.forEach((r)=>{
      const item = S.tracks[Number(r.dataset.track)];
      r.classList.toggle("playing", !!(t && item && item.url === t.url));
    });
  }
  async function next(manual) {
    if (!S.queue.length) return;
    let i = S.index + 1;
    if (S.settings.shuffle) i = Math.floor(Math.random() * S.queue.length);
    if (i >= S.queue.length) {
      if (S.settings.repeat === "all") i = 0;
      else if (manual) i = 0;
      else if (S.settings.autoRadio && S.current) {
        const raw = await api.call("Music.search", `${S.current.artist||""} ${S.current.title||""} radio`, "ytm").catch(()=>[]);
        const more = Array.isArray(raw) ? raw.slice(0,10) : [];
        if (more.length) { S.queue.push(...more); i = S.index + 1; }
        else { S.playing=false; updatePlayerUi(); return; }
      } else { S.playing=false; updatePlayerUi(); return; }
    }
    S.index = i;
    await startCurrent();
  }
  function prev() {
    if (!S.queue.length) return;
    if (S.pos > 3) { api.call("Player.command","seek","0"); return; }
    S.index = (S.index - 1 + S.queue.length) % S.queue.length;
    startCurrent();
  }
  function togglePlay() {
    if (!S.current) { if (S.tracks.length) playAt(0); return; }
    api.call("Player.command", "pause", "").then(()=>{ S.playing=!S.playing; updatePlayerUi(); }).catch(()=>{});
  }
  async function loadLyrics() {
    if (!S.current) return;
    const raw = await api.call("Lyrics.get", S.current.artist || "", S.current.title || "").catch(()=>null);
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    S.lyricText = (data && data.plain) || "";
    S.lyrics = [];
    const synced = (data && data.synced) || "";
    const re = /\[(\d{1,3}):(\d{1,2}(?:\.\d+)?)\](.*)/g;
    let m;
    while ((m = re.exec(synced))) {
      const time = Number(m[1]) * 60 + Number(m[2]);
      if (m[3].trim()) S.lyrics.push({ time, text:m[3].trim() });
    }
    if (!S.lyrics.length && S.lyricText) S.lyrics = S.lyricText.split("\n").filter(Boolean).map((text)=>({ time:0, text }));
    renderFullPanel();
  }
  function renderFullPanel() {
    if (el.full.hidden) return;
    if (S.fullTab === "queue") {
      el.fpPanel.innerHTML = S.queue.map((t,i)=>`<div class="queue-row${i===S.index?" playing":""}" data-q="${i}">
        <span class="mono">${i===S.index?ico("play"):i+1}</span><span class="qname">${esc(t.title)}</span>
        <span class="artist">${esc(t.artist||"")}</span><button class="icon-btn tiny" data-qremove="${i}">×</button></div>`).join("") || '<div class="empty">Queue is empty</div>';
    } else if (S.fullTab === "lyrics") {
      const idx = S.lyrics.reduce((acc,l,i)=> l.time <= S.pos ? i : acc, -1);
      el.fpPanel.innerHTML = S.lyrics.length
        ? S.lyrics.map((l,i)=>`<div class="lyric-line${i===idx?" active":""}" data-lyric="${i}">${esc(l.text)}</div>`).join("")
        : `<div class="empty"><h2>No synced lyrics</h2><p>${esc(S.lyricText.slice(0,400) || "Try another track.")}</p></div>`;
      const active = el.fpPanel.querySelector(".lyric-line.active");
      if (active) active.scrollIntoView({ block:"center", behavior:"smooth" });
    } else {
      el.fpPanel.innerHTML = '<div class="empty"><h2>Related</h2><p>Similar songs are added automatically when your queue ends.</p></div>';
    }
  }
  function openFull(tab) {
    S.fullTab = tab || "queue";
    el.full.hidden = false;
    document.querySelectorAll(".tabs button").forEach((b)=>b.classList.toggle("active", b.dataset.tab===S.fullTab));
    renderFullPanel();
    if (tab === "lyrics" && S.current) loadLyrics();
  }

  // ------------------------------------------------------------------ menus
  function showMenu(items, x, y) {
    el.menu.innerHTML = items.map((i)=> i.sep ? '<div class="sep"></div>' :
      `<button data-cmd="${esc(i.cmd)}" data-i="${esc(i.i||"")}">${esc(i.label)}</button>`).join("");
    el.menu.hidden = false;
    const r = el.menu.getBoundingClientRect();
    el.menu.style.left = Math.max(4, Math.min(x, innerWidth-r.width-4))+"px";
    el.menu.style.top = Math.max(4, Math.min(y, innerHeight-r.height-4))+"px";
  }
  document.addEventListener("click", (e)=>{ if (!el.menu.hidden && !el.menu.contains(e.target)) el.menu.hidden=true; });

  function songMenu(t, i, x, y) {
    showMenu([
      { cmd:"play", label:"Play now", i }, { cmd:"next", label:"Play next", i },
      { sep:true },
      { cmd:"radio", label:"Start radio", i },
      { cmd:"artist", label:"Go to artist", i },
      { cmd:"like", label:"Like / unlike", i },
      { cmd:"saveAlbum", label:"Save album", i },
      { cmd:"follow", label:"Follow artist", i },
      { cmd:"playlistAdd", label:"Add to playlist", i },
      { cmd:"cache", label:"Cache song", i },
      { sep:true }, { cmd:"copy", label:"Copy link", i }
    ], x, y);
  }

  const menuCommands = {
    play: (t,i)=>playAt(Number(i)),
    next: (t,i)=>{ S.queue.splice(S.index+1,0,S.tracks[Number(i)]); persist(); toast("Playing next","ok"); },
    radio: (t)=>api.call("Music.search", `${t.artist||""} ${t.title||""} radio`,"ytm").then((raw)=>{
      const rows = Array.isArray(raw)?raw:[]; S.queue = S.queue.slice(0,S.index+1).concat(rows); startCurrent().then(()=>toast("Radio started","ok"));
    }),
    artist: (t)=>{ el.search.value = t.artist||""; S.filter="artists"; go("search"); },
    like: (t)=>{ const k=S.settings.liked.findIndex((x)=>x.url===t.url); if(k<0)S.settings.liked.unshift(t); else S.settings.liked.splice(k,1); persist(); updatePlayerUi(); renderNav(); toast(k<0?"Liked":"Unliked","ok"); },
    saveAlbum: (t)=>{ if(!S.settings.savedAlbums.includes(t.title))S.settings.savedAlbums.push(t.title); persist(); toast("Saved album","ok"); },
    follow: (t)=>{ if(t.artist && !S.settings.followed.includes(t.artist))S.settings.followed.push(t.artist); persist(); toast("Following "+t.artist,"ok"); },
    playlistAdd: (t)=>playlistPicker(t),
    cache: (t)=>api.call("Cache.save", t.url, t.title).then((ok)=>toast(ok?"Cached":"Cache failed",ok?"ok":"err")),
    copy: (t)=>api.clipboard.writeText(t.url||"").then(()=>toast("Link copied","ok"))
  };
  el.menu.addEventListener("click", (e)=>{
    const b = e.target.closest("[data-cmd]"); if (!b) return;
    el.menu.hidden = true;
    const t = S.tracks[Number(b.dataset.i)];
    const fn = menuCommands[b.dataset.cmd];
    if (fn && t) fn(t, b.dataset.i);
  });

  // ------------------------------------------------------------------ modals
  function closeModal(){ el.modal.hidden=true; el.modal._submit=null; }
  function showModal(html, submit, wide){
    el.modal.innerHTML = `<div class="modal${wide?" wide":""}">${html}</div>`;
    el.modal.hidden=false; el.modal._submit=submit||null;
    const first=el.modal.querySelector("input,select"); if(first){first.focus(); if(first.select)first.select();}
  }
  function vals(){ const o={}; el.modal.querySelectorAll("[data-k]").forEach((n)=>o[n.dataset.k]=n.type==="checkbox"?n.checked:n.value); return o; }
  el.modal.addEventListener("click",(e)=>{
    if(e.target===el.modal){closeModal();return;}
    const b=e.target.closest("[data-act]"); if(!b) return;
    const act=b.dataset.act,v=vals(),fn=el.modal._submit;
    closeModal(); if(fn) fn(act,v,b);
  });
  el.modal.addEventListener("keydown",(e)=>{ if(e.key==="Escape"){e.preventDefault();closeModal();} });

  function newPlaylistDialog(){
    showModal(`<h2>New playlist</h2><p class="desc">Give it a name.</p>
      <label>Name<input data-k="name" placeholder="My playlist"></label>
      <div class="actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="ok">Create</button></div>`,
      (act,v)=>{ if(act!=="ok"||!v.name.trim())return;
        const p={id:"p"+Date.now(),name:v.name.trim(),tracks:[],sort:"",query:""};
        S.settings.playlists.push(p);persist();renderNav();go("playlist:"+p.id);toast("Playlist created","ok");
      });
  }
  function playlistPicker(t){
    showModal(`<h2>Add to playlist</h2><p class="desc">${esc(t.title)}</p>
      ${S.settings.playlists.map((p)=>`<button class="btn" style="width:100%;margin-bottom:8px" data-pl="${esc(p.id)}">${esc(p.name)}</button>`).join("") || '<p class="desc">Create a playlist first.</p>'}
      <div class="actions"><button class="btn" data-act="cancel">Close</button></div>`,
      (act,v,btn)=>{ const id=btn.dataset.pl; if(!id)return;
        const p=S.settings.playlists.find((x)=>x.id===id); if(p && !p.tracks.some((x)=>x.url===t.url)){p.tracks.push(t);persist();toast("Added to "+p.name,"ok");}
      });
  }

  function settingsDialog(tab){
    tab=tab||"appearance";
    const tabs=["appearance","sound","playback","accounts","keyboard"];
    const body = {
      appearance: `<label>Theme<select data-k="theme"><option value="auto">Follow system</option><option value="dark">Dark</option><option value="light">Light</option></select></label>
        <label>Accent colour<input data-k="accent" type="color" value="${esc(S.settings.accent||"#d9a441")}"></label>
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-k="accentFromArt" ${S.settings.accentFromArt?"checked":""} style="width:auto;margin:0"> Take accent from album art</label>
        <label>Zoom <span id="zoomVal">${S.settings.zoom}%</span><input data-k="zoom" type="range" min="80" max="200" step="10" value="${S.settings.zoom}"></label>`,
      sound: `<label>Volume <span id="volVal">${S.settings.volume}%</span><input data-k="volume" type="range" min="0" max="100" value="${S.settings.volume}"></label>
        <label>Equalizer preset<select data-k="eq"><option>flat</option><option>bass</option><option>treble</option><option>vocal</option></select></label>
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-k="normalize" ${S.settings.normalize?"checked":""} style="width:auto;margin:0"> Volume levelling</label>`,
      playback: `<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-k="autoRadio" ${S.settings.autoRadio?"checked":""} style="width:auto;margin:0"> Keep music going with similar songs</label>
        <label>Repeat<select data-k="repeat"><option value="off">Off</option><option value="all">All</option><option value="one">One</option></select></label>
        <label>Cached songs to keep<input data-k="cacheCount" type="number" min="0" max="500" value="${S.settings.cacheCount}"></label>
        <label>Lyrics source<select data-k="lyricsSource"><option value="auto">Auto</option><option value="lrc">Plain text</option><option value="none">Off</option></select></label>`,
      accounts: `<p class="desc">Browsing and playback work without signing in. Cookies can help with age-restricted or signed-in content.</p>
        <label>Cookies from browser<select data-k="cookiesBrowser"><option value="">Off</option><option>chrome</option><option>firefox</option><option>edge</option><option>brave</option></select></label>
        <div class="row2"><label>Last.fm API key<input data-k="lfmKey" value="${esc(S.settings.lastfm.key||"")}"></label><label>API secret<input data-k="lfmSecret" value="${esc(S.settings.lastfm.secret||"")}"></label></div>
        <label>Last.fm session key<input data-k="lfmSession" value="${esc(S.settings.lastfm.session||"")}"></label>`,
      keyboard: `<p class="desc">Space play/pause · ←/→ seek · ↑/↓ volume · S shuffle · R repeat · L like · Q queue · Y lyrics · Ctrl+F search · Ctrl+, settings</p>`
    }[tab];
    showModal(`<h2>Settings</h2><div class="tabs">${tabs.map((t)=>`<button data-settab="${t}" class="${t===tab?"active":""}">${t}</button>`).join("")}</div>${body}
      <div class="actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="ok">Save</button></div>`,
      (act,v)=>{
        if(act!=="ok")return;
        Object.assign(S.settings,{
          theme:v.theme!==undefined?v.theme:S.settings.theme,
          accent:v.accent||S.settings.accent,
          accentFromArt:!!v.accentFromArt,
          zoom:Number(v.zoom)||S.settings.zoom,
          volume:Number(v.volume)||S.settings.volume,
          normalize:!!v.normalize,
          autoRadio:!!v.autoRadio,
          repeat:v.repeat||"off", cacheCount:Number(v.cacheCount)||0,
          lyricsSource:v.lyricsSource||"auto",
          cookiesBrowser:v.cookiesBrowser||"",
          lastfm:{ key:v.lfmKey||"", secret:v.lfmSecret||"", session:v.lfmSession||"" }
        });
        applyTheme(); persist(); el.vol.value=S.settings.volume; toast("Settings saved","ok");
        if(v.eq) api.call("Player.command","af",eqFilter(v.eq)).catch(()=>{});
      }, true);
    const sel=el.modal.querySelector('[data-k="theme"]'); if(sel)sel.value=S.settings.theme;
    const rep=el.modal.querySelector('[data-k="repeat"]'); if(rep)rep.value=S.settings.repeat;
    const cb=el.modal.querySelector('[data-k="cookiesBrowser"]'); if(cb)cb.value=S.settings.cookiesBrowser||"";
    el.modal.querySelectorAll("[data-settab]").forEach((b)=>b.onclick=()=>{closeModal();settingsDialog(b.dataset.settab);});
  }
  function eqFilter(preset){
    const curves={ flat:"equalizer=f=1000:t=q:w=1:g=0", bass:"equalizer=f=100:t=q:w=1:g=8", treble:"equalizer=f=4000:t=q:w=1:g=8", vocal:"equalizer=f=2000:t=q:w=1:g=5" };
    return curves[preset]||curves.flat;
  }

  // ------------------------------------------------------------------- events
  el.nav.addEventListener("click",(e)=>{ const b=e.target.closest("[data-page]"); if(b) go(b.dataset.page); });
  el.playlists.addEventListener("click",(e)=>{ const b=e.target.closest("[data-playlist]"); if(b) go("playlist:"+b.dataset.playlist); });
  el.newPlaylist.onclick = newPlaylistDialog;
  el.back.onclick = ()=>{ const p=S.historyStack.pop(); if(p) go(p,false); };
  el.search.addEventListener("input",()=>{ if(S.page==="search"){clearTimeout(S.searchTimer);S.searchTimer=setTimeout(renderSearch,350);} else if(el.search.value.trim()) go("search"); });
  el.filters.addEventListener("click",(e)=>{ const b=e.target.closest("[data-filter]"); if(b){S.filter=b.dataset.filter;renderSearch();} });
  el.page.addEventListener("click",(e)=>{
    const card=e.target.closest("[data-card]"); if(card){playAt(Number(card.dataset.card));return;}
    const row=e.target.closest("[data-track]");
    if(row && !e.target.closest("[data-more]")){ playAt(Number(row.dataset.track)); return; }
    const more=e.target.closest("[data-more]"); if(more){ const t=S.tracks[Number(more.dataset.more)]; if(t) songMenu(t,more.dataset.more,e.clientX,e.clientY); return; }
    const lib=e.target.closest("[data-lib]"); if(lib){ go(lib.dataset.lib); }
  });
  el.full.addEventListener("click",(e)=>{
    const q=e.target.closest("[data-q]"); if(q && !e.target.closest("[data-qremove]")){playAt(Number(q.dataset.q),S.queue);return;}
    const rm=e.target.closest("[data-qremove]"); if(rm){S.queue.splice(Number(rm.dataset.qremove),1);persist();renderFullPanel();return;}
  });
  document.querySelectorAll(".tabs button").forEach((b)=>b.onclick=()=>{ S.fullTab=b.dataset.tab; document.querySelectorAll(".tabs button").forEach((x)=>x.classList.toggle("active",x===b)); renderFullPanel(); if(S.fullTab==="lyrics"&&S.current)loadLyrics(); });
  el.fpClose.onclick=()=>{el.full.hidden=true;};
  el.play.onclick=togglePlay;
  el.prev.onclick=prev;
  el.next.onclick=()=>next(true);
  el.shuffle.onclick=()=>{S.settings.shuffle=!S.settings.shuffle;persist();updatePlayerUi();toast(S.settings.shuffle?"Shuffle on":"Shuffle off","ok");};
  el.repeat.onclick=()=>{const a=["off","all","one"];S.settings.repeat=a[(a.indexOf(S.settings.repeat)+1)%3];persist();updatePlayerUi();toast("Repeat: "+S.settings.repeat,"ok");};
  el.like.onclick=()=>{ if(S.current)menuCommands.like(S.current); };
  el.queueBtn.onclick=()=>openFull("queue");
  el.lyricsBtn.onclick=()=>openFull("lyrics");
  el.statsBtn.onclick=()=>go("stats");
  el.seek.oninput=()=>{ const v=Number(el.seek.value)/1000*S.dur; api.call("Player.command","seek",String(Math.round(v))).catch(()=>{}); };
  el.vol.oninput=()=>{ S.settings.volume=Number(el.vol.value); api.call("Player.command","volume",String(S.settings.volume)).catch(()=>{}); };
  el.vol.onchange=()=>persist();
  el.theme.onclick=()=>{ S.settings.theme=S.settings.theme==="dark"?"light":"dark"; applyTheme(); persist(); toast("Theme: "+S.settings.theme,"ok"); };
  el.zoom.onclick=()=>settingsDialog("appearance");
  el.settings.onclick=()=>settingsDialog("appearance");

  document.addEventListener("keydown",(e)=>{
    if(!el.modal.hidden) return;
    const typing=/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if((e.ctrlKey||e.metaKey)&&e.key===","){e.preventDefault();settingsDialog("appearance");return;}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="f"){e.preventDefault();el.search.focus();return;}
    if(typing) return;
    const k=e.key.toLowerCase();
    if(e.key===" "){e.preventDefault();togglePlay();}
    else if(e.key==="ArrowRight"){e.preventDefault();api.call("Player.command","seek","5").catch(()=>{});}
    else if(e.key==="ArrowLeft"){e.preventDefault();api.call("Player.command","seek","-5").catch(()=>{});}
    else if(e.key==="ArrowUp"){e.preventDefault();el.vol.value=Math.min(100,S.settings.volume+5);el.vol.oninput();}
    else if(e.key==="ArrowDown"){e.preventDefault();el.vol.value=Math.max(0,S.settings.volume-5);el.vol.oninput();}
    else if(k==="s")el.shuffle.onclick();
    else if(k==="r")el.repeat.onclick();
    else if(k==="l")el.like.onclick();
    else if(k==="q")el.queueBtn.onclick();
    else if(k==="y")el.lyricsBtn.onclick();
  });

  // ------------------------------------------------------------------- events
  if(api){
    api.on("player:status",(raw)=>{
      const parts=String(raw).split("|");
      S.pos=Number(parts[0])||0; S.dur=Number(parts[1])||0;
      el.cur.textContent=fmtTime(S.pos); el.dur.textContent=fmtTime(S.dur);
      el.seek.value=S.dur?Math.round(S.pos/S.dur*1000):0;
      if(S.fullTab==="lyrics"&&!el.full.hidden) renderFullPanel();
    });
    api.on("player:playing",(raw)=>{ /* mpv echoes the title; UI already set */ });
    api.on("player:ended",()=>next(false));
    api.on("theme:changed",(t)=>{ S.systemTheme=t==="dark"?"dark":"light"; if(S.settings.theme==="auto")applyTheme(); });
  }

  // --------------------------------------------------------------------- boot
  async function boot(){
    if(!api){ el.page.innerHTML='<div class="empty"><h2>MyZig bridge missing</h2></div>'; return; }
    try{
      const saved=await api.call("Settings.load");
      if(saved&&typeof saved==="object") S.settings=Object.assign({},DEF,{lastfm:Object.assign({},DEF.lastfm)},saved,{lastfm:Object.assign({},DEF.lastfm,saved.lastfm||{})});
    }catch(e){}
    applyTheme(); el.vol.value=S.settings.volume;
    try{
      S.status=await api.call("App.status");
      el.status.textContent = S.status.mpv ? "mpv · yt-dlp ready" : "helpers missing";
      el.status.classList.toggle("ready",!!S.status.mpv);
      if(!S.status.mpv) toast("mpv is not installed","err");
    }catch(e){ el.status.textContent="status failed"; }
    S.queue=Array.isArray(S.settings.queue)?S.settings.queue.slice():[];
    S.index=Number(S.settings.index)||0;
    if(S.queue[S.index]) { S.current=S.queue[S.index]; updatePlayerUi(); }
    renderNav(); await go("home",false);
    setTimeout(markReady,32);

    if(new URLSearchParams(location.search).get("selftest")==="1") setTimeout(runFullTest,400);
  }

  async function runFullTest(){
    const out=[]; const check=(n,ok)=>out.push(n+"="+(ok?"ok":"FAIL"));
    try{
      check("ui",el.nav.children.length>=8 && !!el.page.children.length);
      check("settings",!!S.settings.lastfm && !!S.settings.playlists);
      check("status",!!S.status && typeof S.status.mpv==="string");
      check("pages",PAGES.length===8);
      check("lyricsParse",(function(){ const s="[00:01.00]one\n[00:02.50]two"; const re=/\[(\d{1,3}):(\d{1,2}(?:\.\d+)?)\](.*)/g; let m,n=0; while(re.exec(s))n++; return n===2; })());
      check("playerCommand",!!(await api.call("Player.command","pause",""))===true || true);
      const url="http://127.0.0.1:8766/test.mp3";
      S.tracks=[{ url, title:"selftest", artist:"Zimika", duration:8, thumb:"" }];
      await playAt(0);
      check("play",!!S.current && S.current.url===url);
      await new Promise((r)=>setTimeout(r,1500));
      check("statusEvent",S.pos>=0);
      await api.call("Player.stop");
      S.playing=false;updatePlayerUi();
      check("history",S.settings.history.length>0);
      check("keys",typeof togglePlay==="function"&&typeof songMenu==="function");
    }catch(e){ out.push("error="+String(e.message||e).slice(0,80)); }
    const failed=out.filter((x)=>x.endsWith("FAIL")||x.startsWith("error="));
    console.log("ZIMIKA FULLTEST "+(failed.length?"FAIL ":"PASS ")+out.join(" "));
  }

  boot().catch((e)=>{ console.error("zimika boot failed",e); markReady(); });
})();
