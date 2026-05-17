let currentSearchList = [];
let currentIndex = -1;
let currentSongTitle = "Aspec";
let currentArtist;
let currentThumb;
let shuffleOn = false;
let repeatOn = false;
let currentTheme = localStorage.getItem("aspec_theme") || "dark";
let customColors = JSON.parse(
  localStorage.getItem("aspec_custom_colors") || "null"
);
let savedThemes = JSON.parse(
  localStorage.getItem("aspec_saved_themes") || "[]"
);
let shortcutBindings = JSON.parse(
  localStorage.getItem("aspec_shortcuts") || "null"
);
let recordingShortcut = null;
let presetThemes = {};

window.median_audio_command = function(command) {
  if (typeof audio === 'undefined' || !audio) return;
  switch(command) {
    case 'play':
      audio.play();
      break;
    case 'pause':
      audio.pause();
      break;
    case 'next':
      if (typeof playNextTrack === 'function') playNextTrack();
      break;
    case 'previous':
      if (typeof playPreviousTrack === 'function') playPreviousTrack();
      break;
  }
};
window.gonative_audio_command = window.median_audio_command;

async function loadThemes() {
  try {
    const res = await fetch("/themes.json");
    presetThemes = await res.json();
  } catch {
    presetThemes = {
      dark: { label: "aspec Dark", css: {} },
      light: {
        label: "aspec Light",
        css: {
          theme: "light",
          bg: "#f5f5f7",
          accent: "#2563eb",
          text: "#111111",
        },
      },
      forest: {
        label: "Forest",
        css: { bg: "#0f1a0f", accent: "#4ade80", text: "#e0f0e0" },
      },
      ocean: {
        label: "Ocean",
        css: { bg: "#0a1628", accent: "#38bdf8", text: "#d0e0f0" },
      },
      midnight: {
        label: "Midnight",
        css: { bg: "#0d0d1a", accent: "#a78bfa", text: "#e0d0f0" },
      },
      sunset: {
        label: "Sunset",
        css: { bg: "#1a0d0d", accent: "#fb7185", text: "#f0d0d0" },
      },
    };
  }
}
let queue = [];
let queueViewOpen = false;
let prevView = null;
let currentUser = null;
let currentPlaylistId = null;
let playGeneration = 0;
let userPaused = false;
let syncedLyrics = [];
let activeLyricsId = "";
let activeLyricLineIndex = -1;
let lyricsScrollFrame = 0;
let lyricsAnimationFrame = 0;
let lyricsRightToLeft = false;
let currentSongId = "";
let lastSavedSongSecond = -1;
let hoveredQueueSong = null;
let searchPlaybackQueue = [];
let searchPlaybackIndex = -1;
let lastSearchQuery = "";
let lastSearchResults = [];
let searchDebounceTimer = 0;
let activeSearchRequestId = 0;
let loadedSearchQuery = "";
let pendingSearchQuery = "";
let changelogLoaded = false;
const lyricsCache = new Map();
const currentSongCookieName = "aspec_current_song";
const queueCookieName = "aspec_queue";
const themeCookieName = "aspec_theme";
const shortcutsCookieName = "aspec_shortcuts";
const cookieMaxAge = 60 * 60 * 24 * 30;
const queuePrefetchIntervalMs = 10 * 60 * 1000;

function getLyricsKey(id) {
  return String(id || "").trim();
}

function isArabicText(text) {
  return /[?-?]/.test(text);
}

function setCookie(name, value, maxAge = cookieMaxAge) {
  document.cookie = `${name}=${encodeURIComponent(
    value
  )}; path=/; max-age=${maxAge}; SameSite=Lax`;
}

function getCookie(name) {
  const prefix = `${name}=`;
  const match = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(prefix));
  return match ? decodeURIComponent(match.slice(prefix.length)) : "";
}

function deleteCookie(name) {
  document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax`;
}

function persistQueueState() {
  if (!queue.length) {
    deleteCookie(queueCookieName);
    return;
  }
  setCookie(
    queueCookieName,
    JSON.stringify(
      queue.map((song) => ({
        videoId: song.videoId || "",
        title: song.title || "",
        thumb: song.thumb || "",
        channel: song.channel || "",
        artist: song.artist || "",
      }))
    )
  );
}

function persistCurrentSongState() {
  if (!currentSongId) {
    deleteCookie(currentSongCookieName);
    return;
  }
  const payload = {
    videoId: currentSongId,
    title: currentSongTitle || "",
    artist: currentArtist || "Unknown Artist",
    thumb: currentThumb || "",
    timestamp: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
    duration: Number.isFinite(audio.duration) ? audio.duration : 0,
  };
  const second = Math.floor(payload.timestamp);
  if (second === lastSavedSongSecond && payload.duration) return;
  lastSavedSongSecond = second;
  setCookie(currentSongCookieName, JSON.stringify(payload));

  if (window.median?.audio || window.gonative?.audio) {
    const bridge = window.median?.audio || window.gonative?.audio;
    bridge.setMetadata({
      "title": payload.title,
      "artist": payload.artist,
      "album": "aspec Player",
      "imageUrl": payload.thumb
    });
    if (audio.paused) {
      bridge.setState({"state": "paused"});
    } else {
      bridge.setState({"state": "playing"});
    }
  }
}

function prefetchSongs(songs, limit = Infinity) {
  if (!Array.isArray(songs)) return;
  songs
    .filter((song) => song?.videoId)
    .slice(0, limit)
    .forEach((song) => {
      fetch(`/prefetch?id=${encodeURIComponent(song.videoId)}`).catch(() => { });
    });
}

function prefetchQueueSongs() {
  prefetchSongs(queue);
}

function restoreQueueFromCookie() {
  const raw = getCookie(queueCookieName);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    queue = parsed
      .map((song) => ({
        videoId: String(song?.videoId || "").trim(),
        title: song?.title || "Unknown",
        thumb: song?.thumb || "",
        channel: song?.channel || song?.artist || "",
        artist: song?.artist || song?.channel || "",
      }))
      .filter((song) => song.videoId);
  } catch {
    deleteCookie(queueCookieName);
  }
}

function restoreCurrentSongFromCookie() {
  const raw = getCookie(currentSongCookieName);
  if (!raw) return;
  try {
    const song = JSON.parse(raw);
    const videoId = String(song?.videoId || "").trim();
    if (!videoId) {
      deleteCookie(currentSongCookieName);
      return;
    }
    currentSongId = videoId;
    currentSongTitle = song?.title || "Unknown";
    currentArtist = song?.artist || "";
    currentThumb = song?.thumb || "";
    currentTitleEl.innerText = currentSongTitle;
    currentStatusEl.innerText = currentArtist || "";
    currentTimeEl.innerText = formatTime(song?.timestamp || 0);
    durationEl.innerText = formatTime(song?.duration || 0);
    const pct = song?.duration
      ? Math.max(
        0,
        Math.min(100, ((song.timestamp || 0) / song.duration) * 100)
      )
      : 0;
    miniBarFill.style.width = `${pct}%`;
    if (currentThumb) trackThumb.style.backgroundImage = `url(${currentThumb})`;
    else trackThumb.style.backgroundImage = "";
    if (
      trackThumb.style.backgroundImage ===
      "https://resources.tidal.com/images/4e4aec29/deff/466e/9ea1/c47916d5960b/640x640.jpg"
    ) {
      trackThumb.style.filter = "blur(2px)";
    }
    userPaused = true;
    playBtn.style.display = "flex";
    pauseBtn.style.display = "none";
    const seekTime = Math.max(0, Number(song?.timestamp) || 0);
    const applySeek = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = Math.min(seekTime, audio.duration);
      } else {
        audio.currentTime = seekTime;
      }
      currentTimeEl.innerText = formatTime(audio.currentTime);
      durationEl.innerText = formatTime(audio.duration || song?.duration || 0);
      const pct = audio.duration
        ? Math.max(0, Math.min(100, (audio.currentTime / audio.duration) * 100))
        : 0;
      miniBarFill.style.width = `${pct}%`;
      audio.pause();
      persistCurrentSongState();
    };
    audio.addEventListener("loadedmetadata", applySeek, { once: true });
    audio.src = `/stream?id=${encodeURIComponent(videoId)}`;
    audio.load();
    loadLyricsForTrack(videoId);
  } catch {
    deleteCookie(currentSongCookieName);
  }
}

const appName = "Aspec";

async function artistPageHandler(artistName) {
  const viewTitleEl = document.getElementById("viewTitle");
  const sectionLabelEl = document.getElementById("sectionLabel");
  const resultsGrid = document.getElementById("resultsGrid");
  const existingTabs = document.getElementById("searchTabs");
  if (existingTabs) existingTabs.remove();

  viewTitleEl.innerText = artistName;
  sectionLabelEl.innerText = "";
  setLyricsPanel(false);
  resultsGrid.className = "list-grid";
  showSkeletons(5);
  document.querySelectorAll(".rail-btn").forEach((b) => b.classList.remove("active"));

  var existingBack = document.querySelector(".back-btn");
  if (existingBack) existingBack.remove();
  var backBtn = document.createElement("button");
  backBtn.className = "back-btn";
  backBtn.innerHTML = '<i class="fa-solid fa-arrow-left"></i>';
      backBtn.addEventListener("click", function () {
    history.replaceState(null, "", "/");
    showSearchView();
  });
  var headerLeft = document.querySelector(".header-left");
  if (headerLeft) headerLeft.insertBefore(backBtn, headerLeft.firstChild);

  var hl = document.querySelector(".header-left");
  if (hl) hl.style.display = "flex";

  try {
    const res = await fetch("/api/artist/" + encodeURIComponent(artistName));
    const data = await res.json();

    if (!data.tracks || data.tracks.length === 0) {
      resultsGrid.innerHTML =
        "<p style='color:var(--text-dim);padding:16px 0'>No tracks found for this artist.</p>";
      return;
    }

    resultsGrid.className = "list-grid";
    resultsGrid.innerHTML = "";

    var artistPic = data.artist.picture;
    if (!artistPic) {
      if (data.tracks && data.tracks.length > 0) {
        artistPic = data.tracks[0].album_pic || '';
      }
      if (!artistPic && data.albums && data.albums.length > 0) {
        artistPic = data.albums[0].cover || '';
      }
    }
    const hero = document.createElement("div");
    hero.className = "artist-hero";
    const bgStyle = artistPic ? ' style="background-image:url(' + artistPic + ')"' : '';
    const picHtml = artistPic
      ? '<img src="' + artistPic + '" alt="' + data.artist.name + '" class="artist-hero-img">'
      : '<div class="artist-hero-placeholder">' + data.artist.name.charAt(0) + '</div>';

    hero.innerHTML =
      '<div class="artist-hero-bg"' + bgStyle + '></div>' +
      picHtml +
      '<div class="artist-hero-content">' +
      '<h1 class="artist-hero-name">' + data.artist.name + '</h1>' +
      '<div class="artist-hero-stats"></div>' +
      '<div class="artist-hero-actions">' +
      '<button title="Play All" id="artistPlayAll"><i class="fa-solid fa-play"></i></button>' +
      '<button class="dark-btn" title="Shuffle"><i class="fa-solid fa-shuffle"></i></button>' +
      '</div>' +
      '</div>';
    resultsGrid.appendChild(hero);

    if (window.innerWidth <= 480) {
      var actionsEl = hero.querySelector(".artist-hero-actions");
      var picEl = hero.querySelector(".artist-hero-img, .artist-hero-placeholder");
      if (actionsEl && picEl) hero.insertBefore(actionsEl, picEl);
    }

    var playAllBtn = hero.querySelector("#artistPlayAll");
    if (playAllBtn) {
      playAllBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (data.tracks.length > 0) {
          currentIndex = 0;
          syncSearchPlaybackIndexBySongId(data.tracks[0].id);
          playSong(data.tracks[0].id, data.tracks[0].name, data.tracks[0].album_pic, data.tracks[0].artist);
          highlightActive();
        }
      });
    }

    var artistShuffleBtn = hero.querySelector(".dark-btn[title='Shuffle']");
    if (artistShuffleBtn) {
      artistShuffleBtn.addEventListener("click", async function (e) {
        e.stopPropagation();
        if (data.tracks.length > 0) {
          shuffleOn = !shuffleOn;
          var globalShuffleBtn = document.getElementById("shuffleBtn");
          if (globalShuffleBtn) globalShuffleBtn.classList.toggle("active", shuffleOn);
          if (shuffleOn) {
            var allAlbumTracks = [];
            var seenIds = {};
            var albumList = data.albums || [];
            if (data.artist.id && albumList.length > 0) {
              var albumResults = await Promise.all(albumList.map(function (a) {
                if (!a.id) return null;
                return fetch("/api/album/" + a.id).then(function (r) { return r.json(); }).catch(function () { return null; });
              }));
              albumResults.forEach(function (albumData) {
                if (!albumData || !albumData.tracks) return;
                var albumCover = albumData.cover || '';
                albumData.tracks.forEach(function (t) {
                  var id = String(t.id).trim();
                  if (!id || seenIds[id]) return;
                  seenIds[id] = true;
                  allAlbumTracks.push({
                    videoId: id,
                    title: t.name,
                    thumb: t.album_pic || albumCover,
                    channel: t.artist,
                  });
                });
              });
            }
            if (allAlbumTracks.length === 0) {
              allAlbumTracks = data.tracks.filter(function (t) {
                var id = String(t.id).trim();
                if (!id || seenIds[id]) return false;
                seenIds[id] = true;
                return true;
              }).map(function (t) {
                return {
                  videoId: String(t.id).trim(),
                  title: t.name,
                  thumb: t.album_pic,
                  channel: t.artist,
                };
              });
            }
            for (var i = allAlbumTracks.length - 1; i > 0; i -= 1) {
              var j = Math.floor(Math.random() * (i + 1));
              var tmp = allAlbumTracks[i];
              allAlbumTracks[i] = allAlbumTracks[j];
              allAlbumTracks[j] = tmp;
            }
            currentSearchList = allAlbumTracks;
            currentIndex = 0;
            var t = currentSearchList[0];
            playSong(t.videoId, t.title, t.thumb, t.channel);
          } else {
            currentSearchList = popularTracks.map(function (track) {
              return {
                videoId: String(track.id).trim(),
                title: track.name,
                thumb: track.album_pic,
                channel: track.artist,
              };
            });
          }
          highlightActive();
        }
      });
    }

    if (data.tracks && data.tracks.length > 0) {
      var popularTracks = data.tracks.slice(0, 12);

      const tracksSection = document.createElement("div");
      tracksSection.className = "artist-section";
      tracksSection.innerHTML = '<h2 class="artist-section-title">Popular Tracks</h2>';
      resultsGrid.appendChild(tracksSection);

      const tracksGrid = document.createElement("div");
      tracksGrid.className = "artist-tracks-grid";
      tracksSection.appendChild(tracksGrid);

      currentSearchList = popularTracks.map(function (track) {
        return {
          videoId: String(track.id).trim(),
          title: track.name,
          thumb: track.album_pic,
          channel: track.artist,
        };
      });
      rebuildSearchPlaybackQueue(currentSearchList);

      popularTracks.forEach(function (track, index) {
        const item = document.createElement("div");
        item.className = "artist-track-item";
        item.dataset.videoId = track.id;
        item.innerHTML =
          '<span class="artist-track-num">' + (index + 1) + '</span>' +
          '<img src="' + (track.album_pic || '') + '" alt="" loading="lazy">' +
          '<div class="artist-track-info">' +
          '<div class="artist-track-title">' + track.name + '</div>' +
          '<div class="artist-track-meta">' + track.artist + (track.album ? ' \u00B7 ' + track.album : '') + '</div>' +
          '</div>' +
          (track.duration_formatted ? '<span class="artist-track-duration">' + track.duration_formatted + '</span>' : '');
        item.addEventListener("click", function () {
          currentIndex = index;
          syncSearchPlaybackIndexBySongId(track.id);
          playSong(track.id, track.name, track.album_pic, track.artist);
          highlightActive();
        });
        item.addEventListener("contextmenu", function (e) {
          e.preventDefault();
          showCtxMenu(e, currentSearchList[index]);
        });
        tracksGrid.appendChild(item);
      });
    }

    function renderAlbumCards(albums, gridEl) {
      albums.forEach(function (album) {
        const card = document.createElement("div");
        card.className = "artist-album-card";
        card.innerHTML =
          '<div class="artist-album-cover-wrap">' +
          '<img src="' + (album.cover || '') + '" alt="' + album.title + '" loading="lazy">' +
          '<div class="artist-album-overlay">' +
          '<button class="album-play-btn" title="Play"><i class="fa-solid fa-play"></i></button>' +
          '<button class="album-shuffle-btn" title="Shuffle"><i class="fa-solid fa-shuffle"></i></button>' +
          '</div>' +
          '</div>' +
          '<div class="artist-album-info">' +
          '<div class="artist-album-title">' + album.title + '</div>' +
          '<div class="artist-album-artist">' + (album.artist || data.artist.name) + '</div>' +
          '</div>';
        card.addEventListener("click", function () {
          if (album.id) window.location.hash = "#album/" + album.id;
        });
        var playBtn = card.querySelector(".album-play-btn");
        if (playBtn) {
          playBtn.addEventListener("click", async function (e) {
            e.stopPropagation();
            if (album.id) {
              try {
                var albumRes = await fetch("/api/album/" + album.id);
                var albumData = await albumRes.json();
                if (albumData.tracks && albumData.tracks.length > 0) {
                  currentSearchList = albumData.tracks.map(function (t) {
                    return { videoId: t.id, title: t.name, thumb: t.album_pic, channel: t.artist };
                  });
                  currentIndex = 0;
                  playSong(albumData.tracks[0].id, albumData.tracks[0].name, albumData.tracks[0].album_pic, albumData.tracks[0].artist);
                  highlightActive();
                }
              } catch {}
            }
          });
        }
        var shuffleBtn = card.querySelector(".album-shuffle-btn");
        if (shuffleBtn) {
          shuffleBtn.addEventListener("click", async function (e) {
            e.stopPropagation();
            if (album.id) {
              try {
                var albumRes = await fetch("/api/album/" + album.id);
                var albumData = await albumRes.json();
                if (albumData.tracks && albumData.tracks.length > 0) {
                  currentSearchList = albumData.tracks.map(function (t) {
                    return { videoId: t.id, title: t.name, thumb: t.album_pic, channel: t.artist };
                  });
                  currentIndex = Math.floor(Math.random() * currentSearchList.length);
                  var t = currentSearchList[currentIndex];
                  playSong(t.videoId, t.title, t.thumb, t.channel);
                  highlightActive();
                }
              } catch {}
            }
          });
        }
        card.addEventListener("contextmenu", function (e) {
          e.preventDefault();
          e.stopPropagation();
        });
        gridEl.appendChild(card);
      });
    }

    if (data.albums && data.albums.length > 0) {
      var sortedAlbums = data.albums.slice().sort(function (a, b) {
        return (b.year || "0") > (a.year || "0") ? 1 : -1;
      });
      var fullAlbums = sortedAlbums.filter(function (a) { return a.trackCount > 2 || (a.trackCount === 0 && a.id); });
      var singles = sortedAlbums.filter(function (a) { return a.trackCount > 0 && a.trackCount <= 2; });

      if (fullAlbums.length > 0) {
        const albumsSection = document.createElement("div");
        albumsSection.className = "artist-section";
        albumsSection.innerHTML =
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px"><h2 class="artist-section-title" style="margin-bottom:0">Albums</h2><button class="discography-btn">See Discography <i class="fa-solid fa-arrow-right"></i></button></div><div class="artist-albums-grid"></div>';
        renderAlbumCards(fullAlbums, albumsSection.querySelector(".artist-albums-grid"));
        resultsGrid.appendChild(albumsSection);
        var discogBtn = albumsSection.querySelector(".discography-btn");
        if (discogBtn) {
          discogBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            window.location.hash = "#discography/" + encodeURIComponent(data.artist.name);
          });
        }
      }

      if (singles.length > 0) {
        const singlesSection = document.createElement("div");
        singlesSection.className = "artist-section singles-section";
        singlesSection.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px"><h2 class="artist-section-title" style="margin-bottom:0">Singles and EPs</h2><button class="discography-btn">See Discography <i class="fa-solid fa-arrow-right"></i></button></div><div class="artist-albums-grid"></div>';
        renderAlbumCards(singles, singlesSection.querySelector(".artist-albums-grid"));
        resultsGrid.appendChild(singlesSection);
        var discogBtn2 = singlesSection.querySelector(".discography-btn");
        if (discogBtn2) {
          discogBtn2.addEventListener("click", function (e) {
            e.stopPropagation();
            window.location.hash = "#discography/" + encodeURIComponent(data.artist.name);
          });
        }
      }
    }
  } catch (err) {
    console.error("Artist page load error:", err);
    resultsGrid.innerHTML =
      "<p style='color:var(--text-dim);padding:16px 0'>Could not load artist page.</p>";
  }
}

async function showDiscographyView(artistName) {
  const viewTitleEl = document.getElementById("viewTitle");
  const sectionLabelEl = document.getElementById("sectionLabel");
  const resultsGrid = document.getElementById("resultsGrid");
  var existingTabs = document.getElementById("searchTabs");
  if (existingTabs) existingTabs.remove();

  viewTitleEl.innerText = artistName + " � Discography";
  sectionLabelEl.innerText = "";
  setLyricsPanel(false);
  resultsGrid.className = "list-grid";
  showSkeletons(5);
  document.querySelectorAll(".rail-btn").forEach((b) => b.classList.remove("active"));

  var existingBack = document.querySelector(".back-btn");
  if (existingBack) existingBack.remove();
  var backBtn = document.createElement("button");
  backBtn.className = "back-btn";
  backBtn.innerHTML = '<i class="fa-solid fa-arrow-left"></i>';
  backBtn.addEventListener("click", function () {
    window.location.hash = "#artist/" + encodeURIComponent(artistName);
  });
  var headerLeft = document.querySelector(".header-left");
  if (headerLeft) headerLeft.insertBefore(backBtn, headerLeft.firstChild);
  var hl = document.querySelector(".header-left");
  if (hl) hl.style.display = "flex";

  try {
    var res = await fetch("/api/artist/" + encodeURIComponent(artistName));
    var data = await res.json();
    var allAlbums = (data.albums || []).slice();
    allAlbums.sort(function (a, b) {
      return (b.year || "0") > (a.year || "0") ? 1 : -1;
    });

    resultsGrid.innerHTML = "";
    resultsGrid.className = "list-grid";

    var fullAlbums = allAlbums.filter(function (a) { return a.trackCount > 2 || (a.trackCount === 0 && a.id); });
    var singles = allAlbums.filter(function (a) { return a.trackCount > 0 && a.trackCount <= 2; });

    async function renderDiscogSection(albums, sectionTitle) {
      if (albums.length === 0) return;
      var sectionEl = document.createElement("div");
      sectionEl.className = "artist-section";
      sectionEl.innerHTML = '<h2 class="artist-section-title" style="margin-bottom:20px">' + sectionTitle + '</h2>';
      resultsGrid.appendChild(sectionEl);

      var albumTrackPromises = albums.map(async function (album) {
        if (!album.id) return { album: album, tracks: [] };
        try {
          var r = await fetch("/api/album/" + album.id);
          var d = await r.json();
          return { album: album, tracks: d.tracks || [] };
        } catch { return { album: album, tracks: [] }; }
      });
      var albumDataList = await Promise.all(albumTrackPromises);

      albumDataList.forEach(function (entry, idx) {
        var album = entry.album;
        var tracks = entry.tracks;
        var albumCover = album.cover || '';

        var discogEntry = document.createElement("div");
        discogEntry.className = "discog-entry";
        discogEntry.style.marginBottom = (idx < albumDataList.length - 1) ? "32px" : "0";

        var header = document.createElement("div");
        header.className = "discog-header";

        var cover = document.createElement("img");
        cover.className = "discog-cover";
        cover.src = albumCover;
        cover.alt = album.title || "";
        cover.loading = "lazy";
        header.appendChild(cover);

        var info = document.createElement("div");
        info.className = "discog-info";
        info.innerHTML =
          '<div class="discog-title">' + (album.title || "") + '</div>' +
          '<div class="discog-year">' + (album.year || "") + '</div>';
        header.appendChild(info);
        discogEntry.appendChild(header);

        if (tracks.length > 0) {
          var trackList = document.createElement("div");
          trackList.className = "discog-tracks";

          var mappedTracks = tracks.map(function (t) {
            return { videoId: String(t.id).trim(), title: t.name || "Unknown", thumb: t.album_pic || albumCover, channel: t.artist || "", duration: t.duration_formatted || "" };
          }).filter(function (s) { return s.videoId; });

          mappedTracks.forEach(function (song, tIdx) {
            var wrap = document.createElement("div");
            wrap.className = "list-item-wrap";
            var row = document.createElement("div");
            row.dataset.videoId = song.videoId;
            row._song = song;
            row.className = "list-item";
            var actionsHtml = song.duration
              ? '<span class="list-duration">' + song.duration + '</span><i class="fa-solid fa-ellipsis-h dotted"></i>'
              : '';
            row.innerHTML =
              '<span class="list-num">' + (tIdx + 1) + '</span>' +
              '<img class="list-thumb" src="' + song.thumb + '" alt="" loading="lazy">' +
          '<div class="list-info"><div class="list-title">' + song.title + '</div><div class="list-channel"><span class="artist-link playlist-track-artist" data-artist="' + song.channel + '" data-video-id="' + song.videoId + '">' + song.channel + '</span></div></div>' +
              actionsHtml;
            row.addEventListener("click", function (e) {
              if (e.target.closest(".artist-link")) return;
              currentSearchList = mappedTracks;
              currentIndex = tIdx;
              playSong(song.videoId, song.title, song.thumb, song.channel);
              highlightActive();
            });
            row.addEventListener("mouseenter", function () { setHoveredQueueSong(song); });
            row.addEventListener("mouseleave", function () { setHoveredQueueSong(null); });
            row.addEventListener("contextmenu", function (e) { showCtxMenu(e, song); });
            var dotted = row.querySelector(".dotted");
            if (dotted) dotted.addEventListener("click", function (e) { e.stopPropagation(); showCtxMenu(e, song); });
            wrap.appendChild(row);
            trackList.appendChild(wrap);
          });

          discogEntry.appendChild(trackList);
        }

        sectionEl.appendChild(discogEntry);
      });
    }

    await renderDiscogSection(fullAlbums, "Albums");
    await renderDiscogSection(singles, "Singles &amp; EPs");
  } catch (err) {
    console.error("Discography load error:", err);
    resultsGrid.innerHTML = "<p style='color:var(--text-dim);padding:16px 0'>Could not load discography.</p>";
  }
}

async function albumPageHandler(albumId) {
  const viewTitleEl = document.getElementById("viewTitle");
  const sectionLabelEl = document.getElementById("sectionLabel");
  const resultsGrid = document.getElementById("resultsGrid");
  const existingTabs = document.getElementById("searchTabs");
  if (existingTabs) existingTabs.remove();

  viewTitleEl.innerText = "Album";
  sectionLabelEl.innerText = "Loading album...";
  setLyricsPanel(false);
  resultsGrid.className = "list-grid results-grid";
  showSkeletons(10);

  try {
    const res = await fetch("/api/album/" + encodeURIComponent(albumId));
    const data = await res.json();

    if (!data.tracks || data.tracks.length === 0) {
      resultsGrid.innerHTML = "<p style='color:var(--text-dim);padding:16px 0'>No tracks found for this album.</p>";
      return;
    }

    viewTitleEl.innerText = data.album || "Album";
    sectionLabelEl.innerText = "";

    currentSearchList = data.tracks.map((track) => ({
      videoId: track.id,
      title: track.name,
      thumb: track.album_pic,
      channel: track.artist,
    }));
    rebuildSearchPlaybackQueue(currentSearchList);

    var existingBack = document.querySelector(".back-btn");
    if (existingBack) existingBack.remove();
    var backBtn = document.createElement("button");
    backBtn.className = "back-btn";
    backBtn.innerHTML = '<i class="fa-solid fa-arrow-left"></i>';
    backBtn.addEventListener("click", function () {
    history.replaceState(null, "", "/");
    showSearchView();
  });
    var headerLeft = document.querySelector(".header-left");
    if (headerLeft) headerLeft.insertBefore(backBtn, headerLeft.firstChild);
    var hl = document.querySelector(".header-left");
    if (hl) hl.style.display = "flex";

    var albumCover = data.cover || '';

    var mappedTracks = data.tracks.map(function (t) {
      return { videoId: String(t.id).trim(), title: t.name || "Unknown", thumb: t.album_pic || albumCover, channel: t.artist || "", duration: t.duration_formatted || "" };
    }).filter(function (s) { return s.videoId; });

    currentSearchList = mappedTracks;
    rebuildSearchPlaybackQueue(currentSearchList);

    var totalDuration = 0;
    data.tracks.forEach(function (t) {
      if (t.duration_ms) totalDuration += t.duration_ms;
    });
    var totalMinutes = Math.floor(totalDuration / 60000);

    resultsGrid.className = "list-grid";
    resultsGrid.innerHTML = "";

    var albumWrap = document.createElement("div");
    albumWrap.className = "album-page-wrap";

    var hero = document.createElement("div");
    hero.className = "album-spotify-hero";

    var heroInner = document.createElement("div");
    heroInner.className = "album-spotify-inner";

    var artWrap = document.createElement("div");
    artWrap.className = "album-art-wrap";
    artWrap.innerHTML = '<img src="' + albumCover + '" alt="' + (data.album || "") + '" loading="lazy">';
    heroInner.appendChild(artWrap);

    var metaWrap = document.createElement("div");
    metaWrap.className = "album-meta-wrap";
    metaWrap.innerHTML =
      '<div class="album-type-label">ALBUM</div>' +
      '<h1 class="album-spotify-title">' + (data.album || "") + '</h1>' +
      '<div class="album-spotify-artist">' +
        (data.artist ? '<span class="artist-link" data-artist="' + data.artist + '">' + data.artist + '</span>' : '') +
      '</div>' +
      '<div class="album-spotify-meta">' +
        (data.year ? '<span>' + data.year + '</span>' : '') +
        '<span>' + data.tracks.length + ' songs</span>' +
        '<span>' + totalMinutes + ' min</span>' +
      '</div>';
    heroInner.appendChild(metaWrap);
    hero.appendChild(heroInner);
    albumWrap.appendChild(hero);

    var actions = document.createElement("div");
    actions.className = "album-spotify-actions";
    actions.innerHTML =
      '<button class="album-spotify-play" title="Play All"><i class="fa-solid fa-play"></i></button>' +
      '<button class="album-spotify-shuffle" title="Shuffle"><i class="fa-solid fa-shuffle"></i></button>';
    var playAllBtn = actions.querySelector(".album-spotify-play");
    playAllBtn.addEventListener("click", function () {
      if (mappedTracks.length > 0) {
        currentIndex = 0;
        playSong(mappedTracks[0].videoId, mappedTracks[0].title, mappedTracks[0].thumb, mappedTracks[0].channel);
        highlightActive();
      }
    });
    var shuffleBtn = actions.querySelector(".album-spotify-shuffle");
    shuffleBtn.addEventListener("click", function () {
      if (mappedTracks.length > 0) {
        var shuffled = mappedTracks.slice();
        for (var i = shuffled.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var tmp = shuffled[i];
          shuffled[i] = shuffled[j];
          shuffled[j] = tmp;
        }
        currentSearchList = shuffled;
        currentIndex = 0;
        playSong(shuffled[0].videoId, shuffled[0].title, shuffled[0].thumb, shuffled[0].channel);
        highlightActive();
      }
    });
    albumWrap.appendChild(actions);

    var trackHeader = document.createElement("div");
    trackHeader.className = "album-track-header";
    trackHeader.innerHTML =
      '<span class="album-track-header-num">#</span>' +
      '<span class="album-track-header-title">Title</span>' +
      '<span class="album-track-header-duration"><i class="fa-regular fa-clock"></i></span>';
    albumWrap.appendChild(trackHeader);

    var trackList = document.createElement("div");
    trackList.className = "album-track-list";

    mappedTracks.forEach(function (song, tIdx) {
      var row = document.createElement("div");
      row.className = "album-track-row";
      row.dataset.videoId = song.videoId;
      row.innerHTML =
        '<span class="album-track-num">' + (tIdx + 1) + '</span>' +
        '<div class="album-track-info">' +
          '<div class="album-track-title">' + song.title + '</div>' +
          '<div class="album-track-artist"><span class="artist-link" data-artist="' + song.channel + '">' + song.channel + '</span></div>' +
        '</div>' +
        '<span class="album-track-duration">' + song.duration + '</span>' +
        '<i class="fa-solid fa-ellipsis-h album-track-ctx"></i>';
      row.addEventListener("click", function (e) {
        if (e.target.closest(".artist-link")) return;
        currentSearchList = mappedTracks;
        currentIndex = tIdx;
        playSong(song.videoId, song.title, song.thumb, song.channel);
        highlightActive();
      });
      row.addEventListener("contextmenu", function (e) { showCtxMenu(e, song); });
      var ctxBtn = row.querySelector(".album-track-ctx");
      if (ctxBtn) ctxBtn.addEventListener("click", function (e) { e.stopPropagation(); showCtxMenu(e, song); });
      trackList.appendChild(row);
    });

    albumWrap.appendChild(trackList);
    resultsGrid.appendChild(albumWrap);
  } catch (err) {
    console.error("Album page load error:", err);
    resultsGrid.innerHTML = "<p style='color:var(--text-dim);padding:16px 0'>Could not load album tracks.</p>";
  }
}

window.addEventListener("hashchange", () => {
  const hash = window.location.hash;
  if (hash.startsWith("#discography/")) {
    const artistName = decodeURIComponent(hash.slice(13));
    showDiscographyView(artistName);
  } else if (hash.startsWith("#artist/")) {
    var artistName2 = decodeURIComponent(hash.slice(8));
    if (!artistName2 || artistName2.trim() === "") {
      loadRecommendations();
    } else {
      artistPageHandler(artistName2);
    }
  } else if (hash.startsWith("#album/")) {
    const albumId = hash.slice(7);
    albumPageHandler(albumId);
  } else {
    loadRecommendations();
  }
});

const audio = document.getElementById("audio");
const playBtn = document.getElementById("playBtn");
const pauseBtn = document.getElementById("pauseBtn");
const currentTimeEl = document.getElementById("currentTime");
const durationEl = document.getElementById("duration");
const miniBarFill = document.getElementById("miniBarFill");
const volumeBar = document.getElementById("volumeBar");
const trackThumb = document.getElementById("trackThumb");
const currentTitleEl = document.getElementById("currentTitle");
const currentStatusEl = document.getElementById("currentStatus");
const ctxMenu = document.getElementById("ctxMenu");
const sectionLabel = document.getElementById("sectionLabel");
const lyricsToggleBtn = document.getElementById("lyricsToggleBtn");
const lyricsPanel = document.getElementById("lyricsPanel");
const fullPlayer = document.getElementById("fullPlayer");
const fpClose = document.getElementById("fpClose");
const fpThumb = document.getElementById("fpThumb");
const fpTitle = document.getElementById("fpTitle");
const fpArtist = document.getElementById("fpArtist");
const fpPlay = document.getElementById("fpPlay");
const fpPrev = document.getElementById("fpPrev");
const fpNext = document.getElementById("fpNext");
const fpShuffle = document.getElementById("fpShuffle");
const fpRepeat = document.getElementById("fpRepeat");
const fpVolume = document.getElementById("fpVolume");
const fpCurrentTime = document.getElementById("fpCurrentTime");
const fpDuration = document.getElementById("fpDuration");
const fpProgressFill = document.getElementById("fpProgressFill");
const fpProgressBg = document.getElementById("fpProgressBg");
const fpLyricsContainer = document.getElementById("fpLyricsContainer");
const deckPlayBtn = document.getElementById("deckPlayBtn");
const deckPauseBtn = document.getElementById("deckPauseBtn");
const deckNowPlaying = document.getElementById("deckNowPlaying");
const lyricsCloseBtn = document.getElementById("lyricsCloseBtn");
const navHome = document.getElementById("navHome");
const navSearch = document.getElementById("navSearch");
const navLibrary = document.getElementById("navLibrary");
const mainArea = document.querySelector(".main-area");
const changelog = document.querySelector(".changelog");
const changelogContent = document.getElementById("changelogContent");
const navChangelog = document.getElementById("navChangelog");
const playerDeck = document.querySelector(".player-deck");
const navSettings = document.getElementById("navSettings");
const settingsContent = document.getElementById("settingsContent");
const navCredits = document.getElementById("navCredits");
const creditsContent = document.getElementById("creditsContent");
const lyricsContainer = document.getElementById("lyrics-container");

const lyricLineClickHandler = (event) => {
  const lineEl = event.target.closest(".lyrics-line");
  if (!lineEl) return;
  const index = Number(lineEl.dataset.index);
  if (Number.isNaN(index) || index < 0 || index >= syncedLyrics.length) return;
  const lyric = syncedLyrics[index];
  if (!lyric || typeof lyric.time !== "number") return;
  audio.currentTime = Math.max(0, lyric.time - 0.05);
  updateLyrics(audio.currentTime);
  if (audio.paused) audio.play().catch(() => { });
};

if (lyricsContainer) {
  lyricsContainer.addEventListener("click", lyricLineClickHandler);
}

const fpLyricsContainerEl = document.getElementById("fpLyricsContainer");
if (fpLyricsContainerEl) {
  fpLyricsContainerEl.addEventListener("click", lyricLineClickHandler);
}

audio.volume = volumeBar.value / 100;
renderLyrics(null);

audio.addEventListener("play", () => {
  currentStatusEl.innerText = currentArtist || "";
  playBtn.style.display = "none";
  pauseBtn.style.display = "flex";
  deckPlayBtn.style.display = "none";
  deckPauseBtn.style.display = "flex";
  document.title = currentSongTitle + " - " + appName;
  syncFullPlayer();
  persistCurrentSongState();
});

audio.addEventListener("pause", () => {
  if (!userPaused) return;
  currentStatusEl.innerText = currentArtist || "";
  playBtn.style.display = "flex";
  pauseBtn.style.display = "none";
  deckPlayBtn.style.display = "flex";
  deckPauseBtn.style.display = "none";
  document.title = appName;
  syncFullPlayer();
  persistCurrentSongState();
});

audio.addEventListener("waiting", () => {
  currentStatusEl.innerText = currentArtist || "";
});

audio.addEventListener("ended", () => {
  if (repeatOn) {
    changeTrack(0);
    return;
  }
  if (queue.length > 0) {
    playFromQueue();
    return;
  }
  changeTrack(1);
});

audio.addEventListener("error", () => {
  const code = audio.error ? audio.error.code : 0;
  currentStatusEl.innerText =
    code === 2 ? "Unavailable � try again shortly" : "Error loading audio";
  playBtn.style.display = "flex";
  pauseBtn.style.display = "none";
  userPaused = true;
});

function syncFullPlayer() {
  if (!fpTitle) return;
  fpTitle.innerText = currentSongTitle || "Select a track";
  fpArtist.innerText = currentArtist || "No track playing";
  if (fpThumb) fpThumb.src = currentThumb || "";
  const isPlaying = !audio.paused && !audio.ended;
  if (fpPlay) {
    const playIcon = fpPlay.querySelector(".fa-play");
    const pauseIcon = fpPlay.querySelector(".fa-pause");
    if (playIcon) playIcon.style.display = isPlaying ? "none" : "";
    if (pauseIcon) pauseIcon.style.display = isPlaying ? "" : "none";
  }
  if (deckPlayBtn) deckPlayBtn.style.display = isPlaying ? "none" : "flex";
  if (deckPauseBtn) deckPauseBtn.style.display = isPlaying ? "flex" : "none";
  if (fpShuffle) fpShuffle.classList.toggle("active", shuffleOn);
  if (fpRepeat) fpRepeat.classList.toggle("active", repeatOn);
  if (audio.duration) {
    const pct = (audio.currentTime / audio.duration) * 100;
    if (fpProgressFill) fpProgressFill.style.width = pct + "%";
  }
  if (fpCurrentTime) fpCurrentTime.innerText = formatTime(audio.currentTime);
  if (fpDuration) fpDuration.innerText = formatTime(audio.duration);
}

audio.addEventListener("timeupdate", () => {
  if (!audio.duration) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  miniBarFill.style.width = pct + "%";
  currentTimeEl.innerText = formatTime(audio.currentTime);
  durationEl.innerText = formatTime(audio.duration);
  if (fpProgressFill) fpProgressFill.style.width = pct + "%";
  if (fpCurrentTime) fpCurrentTime.innerText = formatTime(audio.currentTime);
  if (fpDuration) fpDuration.innerText = formatTime(audio.duration);
  if ("mediaSession" in navigator && "setPositionState" in navigator.mediaSession) {
    navigator.mediaSession.setPositionState({
      duration: audio.duration || 0,
      playbackRate: audio.playbackRate || 1,
      position: audio.currentTime || 0,
    });
  }
  persistCurrentSongState();
});

audio.preload = "auto";

audio.addEventListener("canplay", () => {
  if (!userPaused && audio.paused) audio.play().catch(() => { });
});

audio.addEventListener("loadedmetadata", () => {
  durationEl.innerText = formatTime(audio.duration);
  persistCurrentSongState();
});

audio.addEventListener("play", startLyricsAnimation);
audio.addEventListener("pause", stopLyricsAnimation);
audio.addEventListener("seeking", syncLyricsAnimation);
audio.addEventListener("seeked", syncLyricsAnimation);

function formatTime(s) {
  if (isNaN(s) || s < 0) return "0:00";
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

async function warmStream(url, gen) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 1500);
    const r = await fetch(url, {
      headers: { Range: "bytes=0-1" },
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    if (gen !== playGeneration) return false;
    if (!(r.ok || r.status === 206)) return false;
    await r.arrayBuffer().catch(() => { });
    return true;
  } catch {
    return false;
  }
}

async function playSong(videoId, title, thumb, artist) {
  if (!videoId) {
    flashToast("Unable to play this song. Missing track id.");
    return;
  }
  currentSongId = String(videoId).trim();
  lastSavedSongSecond = -1;
  currentSongTitle = title;
  currentArtist = artist;
  currentThumb = thumb;
  currentTitleEl.innerText = title;
  if (isArabicText(title)) currentTitleEl.classList.add("arabicText");
  else currentTitleEl.classList.remove("arabicText");
  if (thumb) trackThumb.style.backgroundImage = `url(${thumb})`;
  currentStatusEl.innerText = currentArtist || "";
  if (isArabicText(currentArtist || "")) {
    currentStatusEl.classList.add("arabicText");
    document.documentElement.classList.add("arabicText");
  } else {
    currentStatusEl.classList.remove("arabicText");
    document.documentElement.classList.remove("arabicText");
  }
  playBtn.style.display = "none";
  pauseBtn.style.display = "flex";
  userPaused = false;

  const gen = ++playGeneration;
  const url = `/stream?id=${videoId}`;

  warmStream(url, gen).catch(() => { });

  audio.src = url;
  audio.load();
  resetLyricsState();
  audio.play().catch((err) => {
    if (gen !== playGeneration) return;
    if (
      err.name === "AbortError" ||
      err.name === "NotSupportedError" ||
      err.name === "NotAllowedError"
    ) {
      audio.addEventListener("canplay", () => audio.play().catch(() => { }), {
        once: true,
      });
      setTimeout(() => {
        if (gen === playGeneration && !userPaused && audio.paused)
          audio.play().catch(() => { });
      }, 600);
    } else {
      currentStatusEl.innerText = currentArtist || "";
    }
  });
  persistCurrentSongState();

  loadLyricsForTrack(videoId);

  if (fullPlayer && fullPlayer.classList.contains("open")) {
    syncFullPlayer();
    setTimeout(loadFullPlayerLyrics, 100);
  }

  const nextIdx = (currentIndex + 1) % (currentSearchList.length || 1);
  if (currentSearchList[nextIdx]?.videoId) {
    prefetchSongs([currentSearchList[nextIdx]], 1);
  }

  if ("mediaSession" in navigator) {
    var artSrc = currentThumb || "icon.png";
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentSongTitle,
      artist: currentArtist || "",
      artwork: [
        { src: artSrc, sizes: "96x96", type: "image/jpeg" },
        { src: artSrc, sizes: "256x256", type: "image/jpeg" },
        { src: artSrc, sizes: "512x512", type: "image/jpeg" },
      ],
    });
    navigator.mediaSession.setActionHandler("pause", () => pauseMusic());
    navigator.mediaSession.setActionHandler("play", () => playMusic());
    navigator.mediaSession.setActionHandler("nexttrack", () => changeTrack(1));
    navigator.mediaSession.setActionHandler("previoustrack", () => changeTrack(-1));
    navigator.mediaSession.setActionHandler("seekforward", () => {
      audio.currentTime = Math.min(audio.currentTime + 10, audio.duration || Infinity);
    });
    navigator.mediaSession.setActionHandler("seekbackward", () => {
      audio.currentTime = Math.max(audio.currentTime - 10, 0);
    });
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (details.fastSeek && "fastSeek" in audio) {
        audio.fastSeek(details.seekTime);
        return;
      }
      audio.currentTime = details.seekTime;
    });
  }
  if ("setPositionState" in navigator.mediaSession) {
    navigator.mediaSession.setPositionState({
      duration: audio.duration || 0,
      playbackRate: audio.playbackRate || 1,
      position: audio.currentTime || 0,
    });
  }
  highlightActive();
}

function playLocal(src, title) {
  currentSongId = "";
  lastSavedSongSecond = -1;
  persistCurrentSongState();
  currentSongTitle = title;
  currentTitleEl.innerText = title;
  trackThumb.style.backgroundImage = "";
  currentStatusEl.innerText = "";
  userPaused = false;
  audio.src = src;
  audio.play().catch((err) => {
    if (
      err.name === "AbortError" ||
      err.name === "NotSupportedError" ||
      err.name === "NotAllowedError"
    ) {
      audio.addEventListener("canplay", () => audio.play().catch(() => { }), {
        once: true,
      });
      setTimeout(() => {
        if (!userPaused && audio.paused) audio.play().catch(() => { });
      }, 600);
    }
  });
}

function playMusic() {
  userPaused = false;
  audio.play().catch(() => {
    audio.addEventListener("canplay", () => audio.play().catch(() => { }), {
      once: true,
    });
  });
  playBtn.style.display = "none";
  pauseBtn.style.display = "flex";
  persistCurrentSongState();
}

function pauseMusic() {
  userPaused = true;
  audio.pause();
  playBtn.style.display = "flex";
  pauseBtn.style.display = "none";
  if (fullPlayer && fullPlayer.classList.contains("open")) syncFullPlayer();
  persistCurrentSongState();
}

function shuffleSongsCopy(songs) {
  const copy = songs.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function rebuildSearchPlaybackQueue(songs) {
  const base = Array.isArray(songs)
    ? songs.filter((song) => song?.videoId)
    : [];
  searchPlaybackQueue = shuffleOn ? shuffleSongsCopy(base) : base.slice();
  if (!currentSongId) {
    searchPlaybackIndex = -1;
    return;
  }
  searchPlaybackIndex = searchPlaybackQueue.findIndex(
    (song) => song.videoId === currentSongId
  );
}

function syncSearchPlaybackIndexBySongId(videoId) {
  if (!videoId || !searchPlaybackQueue.length) {
    searchPlaybackIndex = -1;
    return;
  }
  searchPlaybackIndex = searchPlaybackQueue.findIndex(
    (song) => song.videoId === videoId
  );
}

function changeTrack(direction) {
  if (queue.length > 0 && direction > 0) {
    playFromQueue();
    return;
  }
  if (getCurrentTab() === "search" && searchPlaybackQueue.length > 0) {
    if (direction === 0) {
      if (searchPlaybackIndex < 0)
        syncSearchPlaybackIndexBySongId(currentSongId);
      if (searchPlaybackIndex < 0) searchPlaybackIndex = 0;
    } else {
      if (searchPlaybackIndex < 0)
        syncSearchPlaybackIndexBySongId(currentSongId);
      if (searchPlaybackIndex < 0) searchPlaybackIndex = 0;
      else {
        searchPlaybackIndex =
          (searchPlaybackIndex + direction + searchPlaybackQueue.length) %
          searchPlaybackQueue.length;
      }
    }
    const track = searchPlaybackQueue[searchPlaybackIndex];
    if (!track) return;
    currentIndex = currentSearchList.findIndex(
      (song) => song.videoId === track.videoId
    );
    playSong(track.videoId, track.title, track.thumb, track.channel);
    highlightActive();
    return;
  }
  if (currentSearchList.length === 0) return;
  if (shuffleOn && direction !== 0) {
    currentIndex += direction;
    if (currentIndex < 0) {
      currentIndex = currentSearchList.length - 1;
    } else if (currentIndex >= currentSearchList.length) {
      for (var si = currentSearchList.length - 1; si > 0; si -= 1) {
        var sj = Math.floor(Math.random() * (si + 1));
        var st = currentSearchList[si];
        currentSearchList[si] = currentSearchList[sj];
        currentSearchList[sj] = st;
      }
      currentIndex = 0;
    }
  } else {
    currentIndex =
      (currentIndex + direction + currentSearchList.length) %
      currentSearchList.length;
  }
  const t = currentSearchList[currentIndex];
  playSong(t.videoId, t.title, t.thumb, t.channel);
  highlightActive();
}

playBtn.addEventListener("click", playMusic);
pauseBtn.addEventListener("click", pauseMusic);
document
  .getElementById("prevBtn")
  .addEventListener("click", () => changeTrack(-1));
document
  .getElementById("nextBtn")
  .addEventListener("click", () => changeTrack(1));

currentStatusEl.addEventListener("click", function (e) {
  e.stopPropagation();
  if (currentArtist) window.location.hash = "#artist/" + encodeURIComponent(currentArtist);
});

document.getElementById("shuffleBtn").addEventListener("click", function () {
  shuffleOn = !shuffleOn;
  this.classList.toggle("active", shuffleOn);
  if (getCurrentTab() === "search" && currentSearchList.length > 0) {
    rebuildSearchPlaybackQueue(currentSearchList);
  }
});

document.getElementById("repeatBtn").addEventListener("click", function () {
  repeatOn = !repeatOn;
  this.classList.toggle("active", repeatOn);
  syncFullPlayer();
});

if (fpShuffle) fpShuffle.addEventListener("click", function () {
  shuffleOn = !shuffleOn;
  this.classList.toggle("active", shuffleOn);
  if (getCurrentTab() === "search" && currentSearchList.length > 0) {
    rebuildSearchPlaybackQueue(currentSearchList);
  }
  document.getElementById("shuffleBtn").classList.toggle("active", shuffleOn);
});

if (fpRepeat) fpRepeat.addEventListener("click", function () {
  repeatOn = !repeatOn;
  this.classList.toggle("active", repeatOn);
  document.getElementById("repeatBtn").classList.toggle("active", repeatOn);
});

if (fpPrev) fpPrev.addEventListener("click", () => changeTrack(-1));
if (fpNext) fpNext.addEventListener("click", () => changeTrack(1));

if (deckPlayBtn) deckPlayBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  playMusic();
});

if (deckPauseBtn) deckPauseBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  pauseMusic();
});

if (fpPlay) fpPlay.addEventListener("click", (e) => {
  e.stopPropagation();
  if (audio.paused) {
    playMusic();
  } else {
    pauseMusic();
  }
});

if (deckNowPlaying) deckNowPlaying.addEventListener("click", () => {
  if (currentSongId) openFullPlayer();
});

if (fpClose) fpClose.addEventListener("click", closeFullPlayer);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && fullPlayer && fullPlayer.classList.contains("open")) {
    closeFullPlayer();
  }
});

if (fpVolume) fpVolume.addEventListener("input", () => {
  audio.volume = fpVolume.value / 100;
  if (volumeBar) volumeBar.value = fpVolume.value;
});

if (fpProgressBg) fpProgressBg.addEventListener("click", (e) => {
  if (!audio.duration) return;
  const rect = fpProgressBg.getBoundingClientRect();
  const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
  audio.currentTime = (x / rect.width) * audio.duration;
});

function openFullPlayer() {
  if (!fullPlayer || !currentSongId) return;
  if (window.innerWidth > 480) return;
  fullPlayer.classList.add("open");
  if (fpVolume) fpVolume.value = volumeBar.value;
  syncFullPlayer();
  loadFullPlayerLyrics();
  document.body.style.overflow = "hidden";
}

function closeFullPlayer() {
  if (!fullPlayer) return;
  fullPlayer.classList.remove("open");
  document.body.style.overflow = "";
}

function loadFullPlayerLyrics() {
  if (!fpLyricsContainer) return;
  const sourceContainer = document.getElementById("lyrics-container");
  if (sourceContainer) {
    fpLyricsContainer.innerHTML = sourceContainer.innerHTML;
  }
}

if (lyricsContainer) {
  const observer = new MutationObserver(() => {
    if (fullPlayer && fullPlayer.classList.contains("open")) {
      loadFullPlayerLyrics();
    }
  });
  observer.observe(lyricsContainer, { childList: true, subtree: true });
}

function lightenColor(hex, amount) {
  const num = parseInt(hex.replace("#", ""), 16);
  const r = Math.min(255, (num >> 16) + amount);
  const g = Math.min(255, ((num >> 8) & 0xff) + amount);
  const b = Math.min(255, (num & 0xff) + amount);
  return "#" + ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0");
}

function clearInlineCSS() {
  const r = document.documentElement.style;
  r.removeProperty("--bg-deep");
  r.removeProperty("--bg-surface");
  r.removeProperty("--bg-elevated");
  r.removeProperty("--bg-hover");
  r.removeProperty("--accent");
  r.removeProperty("--accent-glow");
  r.removeProperty("--text-main");
  r.removeProperty("--text-secondary");
}

function applyTheme() {
  clearInlineCSS();
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  if (currentTheme === "auto") {
    const base = prefersDark ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", base);
  } else {
    const themeDef = presetThemes[currentTheme] || presetThemes.dark;
    const base = themeDef.css?.theme || "dark";
    document.documentElement.setAttribute(
      "data-theme",
      base === "light" ? "light" : "dark"
    );
    if (themeDef.css && Object.keys(themeDef.css).length > 0) {
      const r = document.documentElement.style;
      if (themeDef.css.bg) {
        r.setProperty("--bg-deep", themeDef.css.bg);
        r.setProperty("--bg-surface", lightenColor(themeDef.css.bg, 8));
        r.setProperty("--bg-elevated", lightenColor(themeDef.css.bg, 18));
        r.setProperty("--bg-hover", lightenColor(themeDef.css.bg, 32));
      }
      if (themeDef.css.accent) r.setProperty("--accent", themeDef.css.accent);
      if (themeDef.css.text) r.setProperty("--text-main", themeDef.css.text);
    }
  }

  if (customColors) {
    const r = document.documentElement.style;
    if (customColors.bg) {
      r.setProperty("--bg-deep", customColors.bg);
      r.setProperty("--bg-surface", lightenColor(customColors.bg, 8));
      r.setProperty("--bg-elevated", lightenColor(customColors.bg, 18));
      r.setProperty("--bg-hover", lightenColor(customColors.bg, 32));
    }
    if (customColors.accent) r.setProperty("--accent", customColors.accent);
    if (customColors.accentGlow)
      r.setProperty("--accent-glow", customColors.accentGlow);
    if (customColors.text) r.setProperty("--text-main", customColors.text);
    if (customColors.textSecondary)
      r.setProperty("--text-secondary", customColors.textSecondary);
  }

  populateThemeSelect();
  syncColorPickers();
}

function themeKeyForSelect() {
  if (customColors) return "__custom__";
  return currentTheme;
}

function populateThemeSelect() {
  const sel = document.getElementById("themeSelect");
  if (!sel) return;
  sel.innerHTML =
    '<option value="auto">Auto (follow system)</option><option disabled>-- Presets --</option>';
  Object.entries(presetThemes).forEach(([k, v]) => {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = v.label;
    sel.appendChild(opt);
  });
  if (Array.isArray(savedThemes) && savedThemes.length) {
    const divider = document.createElement("option");
    divider.disabled = true;
    divider.textContent = "-- Saved --";
    sel.appendChild(divider);
    savedThemes.forEach((t, i) => {
      const opt = document.createElement("option");
      opt.value = "__saved_" + i;
      opt.textContent = t.name;
      sel.appendChild(opt);
    });
  }
  if (customColors && currentTheme !== "auto") {
    const div = document.createElement("option");
    div.disabled = true;
    div.textContent = "-- Custom --";
    sel.appendChild(div);
    const c = document.createElement("option");
    c.value = "__custom__";
    c.textContent = "Custom (current)";
    sel.appendChild(c);
  }
  sel.value =
    currentTheme === "auto"
      ? "auto"
      : customColors
        ? "__custom__"
        : currentTheme;
}

function syncColorPickers() {
  const accentInput = document.getElementById("themeAccent");
  const bgInput = document.getElementById("themeBg");
  const textInput = document.getElementById("themeText");
  const cs = getComputedStyle(document.documentElement);
  if (accentInput)
    accentInput.value =
      customColors?.accent ||
      cs.getPropertyValue("--accent").trim() ||
      "#3b82f6";
  if (bgInput)
    bgInput.value =
      customColors?.bg || cs.getPropertyValue("--bg-deep").trim() || "#0a0a0b";
  if (textInput)
    textInput.value =
      customColors?.text ||
      cs.getPropertyValue("--text-main").trim() ||
      "#ffffff";
}

function persistTheme() {
  localStorage.setItem("aspec_theme", currentTheme);
  if (customColors && currentTheme !== "auto") {
    localStorage.setItem("aspec_custom_colors", JSON.stringify(customColors));
  } else {
    localStorage.removeItem("aspec_custom_colors");
  }
  applyTheme();
}

const defaultShortcuts = {
  queueAdd: { key: "KeyQ", mod: "alt", label: "Add to Queue" },
  playPause: { key: "KeyP", mod: "alt", label: "Play / Pause" },
  nextTrack: { key: "ArrowRight", mod: "alt", label: "Next Track" },
  prevTrack: { key: "ArrowLeft", mod: "alt", label: "Previous Track" },
};

function loadShortcuts() {
  if (!shortcutBindings || typeof shortcutBindings !== "object") {
    shortcutBindings = {};
  }
  shortcutBindings = { ...defaultShortcuts, ...shortcutBindings };
}

function persistShortcuts() {
  localStorage.setItem("aspec_shortcuts", JSON.stringify(shortcutBindings));
}

function renderShortcutsList() {
  const container = document.getElementById("shortcutsList");
  if (!container) return;
  loadShortcuts();
  container.innerHTML = "";
  Object.entries(shortcutBindings).forEach(([id, sc]) => {
    const item = document.createElement("div");
    item.className = "shortcut-item";
    const modMap = { alt: "Alt", ctrl: "Ctrl", shift: "Shift" };
    const modLabel = modMap[sc.mod] || sc.mod;
    const keyLabel = sc.key.replace("Key", "").replace("Arrow", "");
    item.innerHTML = `
      <span>${sc.label}</span>
      <span class="shortcut-key" data-shortcut-id="${id}">${modLabel}+${keyLabel}</span>
    `;
    container.appendChild(item);
  });
}

function setupShortcutRecording() {
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-shortcut-id]");
    if (!el) return;
    e.stopPropagation();
    if (recordingShortcut) {
      document
        .querySelectorAll(".shortcut-key.recording")
        .forEach((b) => b.classList.remove("recording"));
    }
    recordingShortcut = el.dataset.shortcutId;
    el.classList.add("recording");
    el.textContent = "press a key...";
  });
}

document.addEventListener("keydown", (e) => {
  if (recordingShortcut) {
    e.preventDefault();
    e.stopPropagation();
    if (!e.altKey && !e.ctrlKey && !e.shiftKey) {
      return;
    }
    const mod = e.altKey ? "alt" : e.ctrlKey ? "ctrl" : "shift";
    if (!e.code) return;
    shortcutBindings[recordingShortcut] = {
      ...shortcutBindings[recordingShortcut],
      key: e.code,
      mod,
    };
    persistShortcuts();
    document
      .querySelectorAll(".shortcut-key.recording")
      .forEach((b) => b.classList.remove("recording"));
    recordingShortcut = null;
    renderShortcutsList();
    return;
  }
  handleQueueAddViaAltQ(e);
  const bindings = shortcutBindings || defaultShortcuts;
  Object.entries(bindings).forEach(([id, sc]) => {
    if (id === "queueAdd") return;
    const modMatch =
      sc.mod === "alt"
        ? e.altKey
        : sc.mod === "ctrl"
          ? e.ctrlKey
          : sc.mod === "shift"
            ? e.shiftKey
            : false;
    if (modMatch && e.code === sc.key) {
      e.preventDefault();
      if (id === "playPause") audio.paused ? playMusic() : pauseMusic();
      if (id === "nextTrack") changeTrack(1);
      if (id === "prevTrack") changeTrack(-1);
    }
  });
});

function initSettings() {
  applyTheme();
  loadShortcuts();
  renderShortcutsList();
  setupShortcutRecording();

  const themeSelect = document.getElementById("themeSelect");
  if (themeSelect) {
    themeSelect.addEventListener("change", () => {
      const v = themeSelect.value;
      if (v === "auto") {
        currentTheme = "auto";
        customColors = null;
      } else if (v.startsWith("__saved_")) {
        const idx = parseInt(v.replace("__saved_", ""));
        const t = savedThemes[idx];
        if (t) {
          currentTheme = t.base || "dark";
          customColors = t.css ? { ...t.css } : null;
        }
      } else if (v === "__custom__") {
        return;
      } else if (presetThemes[v]) {
        currentTheme = v;
        customColors = null;
      }
      persistTheme();
    });
  }

  const accentInput = document.getElementById("themeAccent");
  const bgInput = document.getElementById("themeBg");
  const textInput = document.getElementById("themeText");
  const applyCustom = () => {
    customColors = {
      accent: accentInput?.value || "#3b82f6",
      bg: bgInput?.value || "#0a0a0b",
      text: textInput?.value || "#ffffff",
      textSecondary: textInput?.value ? textInput.value + "99" : "#a0a0a0",
    };
    applyTheme();
    populateThemeSelect();
  };
  accentInput?.addEventListener("input", applyCustom);
  bgInput?.addEventListener("input", applyCustom);
  textInput?.addEventListener("input", applyCustom);

  document.getElementById("resetThemeBtn")?.addEventListener("click", () => {
    customColors = null;
    currentTheme = "dark";
    localStorage.removeItem("aspec_custom_colors");
    persistTheme();
  });

  document.getElementById("saveThemeBtn")?.addEventListener("click", () => {
    const name = prompt("Theme name:");
    if (!name || !name.trim()) return;
    if (!Array.isArray(savedThemes)) savedThemes = [];
    savedThemes.push({
      name: name.trim(),
      base: currentTheme === "auto" ? "dark" : currentTheme,
      css: customColors ? { ...customColors } : null,
    });
    localStorage.setItem("aspec_saved_themes", JSON.stringify(savedThemes));
    populateThemeSelect();
  });

  document.getElementById("resetSessionBtn")?.addEventListener("click", () => {
    if (window.innerWidth > 768 && !confirm("Reset all settings and reload?"))
      return;
    localStorage.clear();
    location.reload();
  });

  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (currentTheme === "auto") applyTheme();
    });
}

if (navSettings) {
  navSettings.addEventListener("click", function () {
    if (queueViewOpen) closeQueueView();
    setActiveNav(this);
    prevView = null;
    showSettingsView();
    renderShortcutsList();
  });
}

volumeBar.addEventListener("input", () => {
  audio.volume = volumeBar.value / 100;
  if (fpVolume) fpVolume.value = volumeBar.value;
});

const timeDisplay = document.querySelector(".time-display");

function seekFromClientX(clientX) {
  if (!audio.duration) return;
  const bar = document.querySelector(".mini-bar-bg");
  if (!bar) return;
  const rect = bar.getBoundingClientRect();
  const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
  audio.currentTime = (x / rect.width) * audio.duration;
}

timeDisplay?.addEventListener("click", (e) => {
  seekFromClientX(e.clientX);
});

timeDisplay?.addEventListener(
  "touchstart",
  (e) => {
    seekFromClientX(e.touches[0].clientX);
  },
  { passive: true }
);

function updateQueueBadge() {
  const queueBtn = document.getElementById("queueBtn");
  persistQueueState();
  prefetchQueueSongs();
  if (queue.length > 0) {
    if (queueBtn) queueBtn.classList.add("active");
  } else {
    if (queueBtn) queueBtn.classList.remove("active");
  }
}

function addToQueue(song) {
  queue.push(song);
  updateQueueBadge();
  flashToast(`Added "${song.title}" to queue`);
}

function playNextInQueue(song) {
  queue.unshift(song);
  updateQueueBadge();
  flashToast(`"${song.title}" will play next`);
}

function playFromQueue() {
  if (queue.length === 0) return;
  const song = queue.shift();
  updateQueueBadge();
  playSong(
    song.videoId,
    song.title,
    song.thumb,
    song.channel || song.artist || ""
  );
  if (queueViewOpen) renderQueueView();
}

function setHoveredQueueSong(song) {
  hoveredQueueSong = song || null;
}

function handleQueueAddViaAltQ(e) {
  const sc = (shortcutBindings || defaultShortcuts).queueAdd;
  if (!sc) return;
  const modMatch =
    sc.mod === "alt"
      ? e.altKey
      : sc.mod === "ctrl"
        ? e.ctrlKey
        : sc.mod === "shift"
          ? e.shiftKey
          : false;
  if (!modMatch || e.code !== sc.key) return;
  const song = hoveredQueueSong;
  if (!song) return;
  e.preventDefault();
  addToQueue(song);
}

function renderQueueView() {
  queueViewOpen = true;
  setHoveredQueueSong(null);
  document.getElementById("viewTitle").innerText = "Queue";
  sectionLabel.innerText = queue.length
    ? `${queue.length} song${queue.length > 1 ? "s" : ""} up next`
    : "Queue is empty";
  const grid = document.getElementById("resultsGrid");
  grid.className = "results-grid";
  grid.innerHTML = "";
  if (!queue.length) {
    grid.innerHTML =
      "<p style='color:var(--text-dim);padding:16px 0;grid-column:1/-1'>Add songs by right-clicking any track or hitting the three dots next to the song duration.</p>";
    return;
  }
  queue.forEach((song, i) => {
    const row = document.createElement("div");
    row.className = "queue-item";
    row.draggable = true;
    row.innerHTML = `
            <span style="color:var(--text-dim);font-size:12px;min-width:18px"><i class="fa-solid fa-grip-lines"></i></span>
            <img src="${song.thumb}" alt="">
            <div class="queue-item-info">
                <h3>${song.title}</h3>
                <p><span class="artist-link" data-artist="${song.channel || song.artist || ""}">${song.channel || song.artist || ""}</span></p>
            </div>
            <div class="queue-item-actions">
                <button class="q-play" title="Play now"><i class="fa-solid fa-play"></i></button>
                <button class="q-remove" title="Remove"><i class="fa-solid fa-xmark"></i></button>
            </div>
        `;
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", i);
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      const dragging = document.querySelector(".dragging");
      if (dragging && dragging !== row) {
        const rect = row.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        if (e.clientY < mid) row.parentNode.insertBefore(dragging, row);
        else row.parentNode.insertBefore(dragging, row.nextSibling);
      }
    });
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      const fromIdx = parseInt(e.dataTransfer.getData("text/plain"));
      const items = Array.from(grid.querySelectorAll(".queue-item"));
      const toIdx = items.indexOf(row);
      if (fromIdx === toIdx) return;
      const [moved] = queue.splice(fromIdx, 1);
      queue.splice(toIdx, 0, moved);
      updateQueueBadge();
      renderQueueView();
    });
    row.querySelector(".q-play").addEventListener("click", (e) => {
      e.stopPropagation();
      queue.splice(i, 1);
      updateQueueBadge();
      playSong(
        song.videoId,
        song.title,
        song.thumb,
        song.channel || song.artist || ""
      );
      renderQueueView();
    });
    row.querySelector(".q-remove").addEventListener("click", (e) => {
      e.stopPropagation();
      queue.splice(i, 1);
      updateQueueBadge();
      renderQueueView();
    });
    row.addEventListener("click", (e) => {
      if (e.target.closest(".artist-link")) return;
      if (e.target.closest(".queue-item-actions")) return;
      queue.splice(i, 1);
      updateQueueBadge();
      playSong(
        song.videoId,
        song.title,
        song.thumb,
        song.channel || song.artist || ""
      );
      renderQueueView();
    });
    grid.appendChild(row);
  });
}

function showHomeView() {
  if (mainArea) mainArea.style.display = "flex";
  if (changelog) changelog.style.display = "none";
  if (settingsContent) settingsContent.style.display = "none";
  if (creditsContent) creditsContent.style.display = "none";
  var existingBack = document.querySelector(".back-btn");
  if (existingBack) existingBack.remove();
  var hl = document.querySelector(".header-left");
  if (hl) hl.style.display = "";
}

function showChangelogView() {
  if (mainArea) mainArea.style.display = "none";
  if (changelog) changelog.style.display = "block";
  if (settingsContent) settingsContent.style.display = "none";
  if (creditsContent) creditsContent.style.display = "none";
}

function showSettingsView() {
  if (mainArea) mainArea.style.display = "none";
  if (changelog) changelog.style.display = "none";
  if (settingsContent) settingsContent.style.display = "block";
  if (creditsContent) creditsContent.style.display = "none";
}

function showCreditsView() {
  if (mainArea) mainArea.style.display = "none";
  if (changelog) changelog.style.display = "none";
  if (settingsContent) settingsContent.style.display = "none";
  if (creditsContent) creditsContent.style.display = "block";
  renderCredits();
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderChangelogMarkdown(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const html = [];
  let listItems = [];

  const flushList = () => {
    if (!listItems.length) return;
    html.push(`<ul>${listItems.join("")}</ul>`);
    listItems = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }
    if (line.startsWith("### ")) {
      flushList();
      html.push(`<h3>${escapeHtml(line.slice(4))}</h3>`);
      continue;
    }
    if (line.startsWith("## ")) {
      flushList();
      html.push(`<h2>${escapeHtml(line.slice(3))}</h2>`);
      continue;
    }
    if (line.startsWith("# ")) {
      flushList();
      html.push(`<h1>${escapeHtml(line.slice(2))}</h1>`);
      continue;
    }
    if (line.startsWith("-") || line.startsWith("*")) {
      listItems.push(`<li>${escapeHtml(line.slice(1).trim())}</li>`);
      continue;
    }
    html.push(`<p>${escapeHtml(line)}</p>`);
  }

  flushList();
  return html.join("");
}

async function ensureChangelogLoaded() {
  if (changelogLoaded || !changelogContent) return;
  changelogContent.innerHTML = "<p>Loading changelog...</p>";
  try {
    const response = await fetch("/api/changelog", { cache: "no-store" });
    if (!response.ok) throw new Error("Failed to load changelog");
    const markdown = await response.text();
    changelogContent.innerHTML = renderChangelogMarkdown(markdown);
    changelogLoaded = true;
  } catch {
    changelogContent.innerHTML =
      "<p style='color:var(--text-dim)'>Could not load changelog.</p>";
  }
}

function getCurrentTab() {
  if (changelog?.style.display === "block") return "changelog";
  if (settingsContent?.style.display === "block") return "settings";
  if (navSearch?.classList.contains("active")) return "search";
  return "home";
}

function captureCurrentResultsView() {
  const grid = document.getElementById("resultsGrid");
  const fragment = document.createDocumentFragment();
  while (grid.firstChild) {
    fragment.appendChild(grid.firstChild);
  }
  return {
    title: document.getElementById("viewTitle").innerText,
    label: sectionLabel.innerText,
    className: grid.className,
    display: grid.style.display,
    fragment,
  };
}

function restoreCapturedResultsView(view) {
  const grid = document.getElementById("resultsGrid");
  document.getElementById("viewTitle").innerText = view.title;
  sectionLabel.innerText = view.label;
  grid.className = view.className || grid.className;
  grid.replaceChildren(view.fragment);
  if (view.display) grid.style.display = view.display;
  else grid.style.removeProperty("display");
  highlightActive();
}

function closeQueueView() {
  queueViewOpen = false;
  if (prevView?.resultsView) {
    restoreCapturedResultsView(prevView.resultsView);
  } else {
    loadRecommendations();
  }

  if (prevView?.tab === "changelog") {
    setActiveNav(navChangelog);
    showChangelogView();
  } else if (prevView?.tab === "search") {
    setActiveNav(navSearch);
    showHomeView();
  } else if (prevView?.tab === "settings") {
    setActiveNav(navSettings);
    showSettingsView();
  } else {
    setActiveNav(navHome);
    showHomeView();
  }

  prevView = null;
}

document.getElementById("queueBtn").addEventListener("click", function () {
  if (queueViewOpen) {
    closeQueueView();
    return;
  }

  prevView = {
    tab: getCurrentTab(),
    resultsView: captureCurrentResultsView(),
  };
  showHomeView();
  setActiveNav(prevView.tab === "search" ? navSearch : navHome);
  renderQueueView();
});

function flashToast(msg) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.style.cssText = `position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:#1e1e1e;border:1px solid rgba(255,255,255,0.1);color:#fff;font-size:13px;font-family:'Inter',sans-serif;padding:9px 16px;border-radius:8px;z-index:9998;box-shadow:0 4px 16px rgba(0,0,0,0.5);opacity:0;transition:opacity 0.2s;pointer-events:none;white-space:nowrap;`;
    document.body.appendChild(t);
  }
  t.innerText = msg;
  t.style.opacity = "1";
  clearTimeout(t._timer);
  t._timer = setTimeout(() => {
    t.style.opacity = "0";
  }, 2000);
}

let ctxTarget = null;
function showCtxMenu(e, song) {
  e.preventDefault();
  e.stopPropagation();
  ctxTarget = song;
  const pad = 8;
  let x = e.clientX,
    y = e.clientY;
  ctxMenu.style.display = "block";
  const mw = ctxMenu.offsetWidth,
    mh = ctxMenu.offsetHeight;
  if (x + mw > window.innerWidth - pad) x = window.innerWidth - mw - pad;
  if (y + mh > window.innerHeight - pad) y = window.innerHeight - mh - pad;
  ctxMenu.style.left = x + "px";
  ctxMenu.style.top = y + "px";
}

function hideCtxMenu() {
  ctxMenu.style.display = "none";
  ctxTarget = null;
}

document.getElementById("ctxPlay").addEventListener("click", () => {
  if (!ctxTarget) return;
  playSong(
    ctxTarget.videoId,
    ctxTarget.title,
    ctxTarget.thumb,
    ctxTarget.channel || ""
  );
  hideCtxMenu();
});
document.getElementById("ctxPlayNext").addEventListener("click", () => {
  if (!ctxTarget) return;
  playNextInQueue(ctxTarget);
  hideCtxMenu();
});
document.getElementById("ctxQueue").addEventListener("click", () => {
  if (!ctxTarget) return;
  addToQueue(ctxTarget);
  hideCtxMenu();
});
document.getElementById("ctxAddToPlaylist").addEventListener("click", () => {
  if (!ctxTarget) return;
  var song = ctxTarget;
  hideCtxMenu();
  showPlaylistPicker(song);
});

var pickerSong = null;
function showPlaylistPicker(song) {
  pickerSong = song;
  var modal = document.getElementById("playlistPickerModal");
  var list = document.getElementById("playlistPickerList");
  list.innerHTML = "";
  var url = currentUser ? "/playlists?username=" + encodeURIComponent(currentUser) : "/playlists";
  fetch(url).then(function (r) { return r.json(); }).then(function (data) {
    var pls = data.playlists || [];
    if (pls.length === 0) {
      list.innerHTML = '<div class="playlist-picker-empty">No playlists yet. Create one first.</div>';
    } else {
      pls.forEach(function (pl) {
        var btn = document.createElement("button");
        btn.className = "playlist-picker-item";
        btn.innerHTML = '<i class="fa-solid fa-list"></i><span>' + pl.name + "</span>";
        btn.addEventListener("click", function () {
          if (!pickerSong) return;
          fetch("/playlists/" + pl.id + "/songs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ videoId: pickerSong.videoId, title: pickerSong.title, thumbnail: pickerSong.thumb || "", artist: pickerSong.channel || "" })
          }).then(function (r) { return r.json(); }).then(function () {
            modal.style.display = "none";
            flashToast("Added to " + pl.name);
          }).catch(function () {
            flashToast("Failed to add song");
          });
        });
        list.appendChild(btn);
      });
    }
  }).catch(function () {
    list.innerHTML = '<div class="playlist-picker-empty">Error loading playlists.</div>';
  });
  modal.style.display = "flex";
}

document.getElementById("playlistPickerClose").addEventListener("click", function () {
  document.getElementById("playlistPickerModal").style.display = "none";
});

document.getElementById("editPlClose").addEventListener("click", function () {
  document.getElementById("editPlaylistModal").style.display = "none";
});
document.getElementById("editPlaylistModal").addEventListener("click", function (e) {
  if (e.target === e.currentTarget) document.getElementById("editPlaylistModal").style.display = "none";
});
document.getElementById("editPlImageInput").addEventListener("change", function (e) {
  var file = e.target.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function (ev) {
    var preview = document.getElementById("editPlImagePreview");
    preview.innerHTML = '<img src="' + ev.target.result + '" style="width:100%;height:100%;object-fit:cover;border-radius:12px">';
    document.getElementById("editPlRemoveImage").style.display = "";
    preview.dataset.imageData = ev.target.result;
  };
  reader.readAsDataURL(file);
});
document.getElementById("editPlRemoveImage").addEventListener("click", function () {
  var preview = document.getElementById("editPlImagePreview");
  preview.innerHTML = '<i class="fa-solid fa-music"></i>';
  preview.dataset.imageData = "";
  document.getElementById("editPlImageInput").value = "";
  this.style.display = "none";
});
document.getElementById("editPlBtn").addEventListener("click", async function () {
  var name = document.getElementById("editPlName").value.trim();
  var desc = document.getElementById("editPlDescription").value.trim();
  var preview = document.getElementById("editPlImagePreview");
  var image = preview.dataset.imageData || "";
  if (!name || !currentPlaylistId) return;
  var body = { name: name };
  body.description = desc;
  if (image) body.image = image;
  var res = await fetch("/playlists/" + currentPlaylistId, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    document.getElementById("editPlaylistModal").style.display = "none";
    openPlaylist(currentPlaylistId);
  }
});

document.getElementById("addSongModalClose").addEventListener("click", function () {
  document.getElementById("addSongModal").style.display = "none";
});

var addSongSearchTimer = null;
document.getElementById("addSongSearchInput").addEventListener("input", function () {
  var q = this.value.trim();
  var resultsEl = document.getElementById("addSongResults");
  var emptyEl = document.getElementById("addSongEmpty");
  if (addSongSearchTimer) clearTimeout(addSongSearchTimer);
  if (!q) {
    resultsEl.innerHTML = "";
    emptyEl.style.display = "block";
    return;
  }
  emptyEl.style.display = "none";
  resultsEl.innerHTML = '<div class="add-song-spinner"><i class="fa-solid fa-spinner fa-spin"></i> Searching...</div>';
  addSongSearchTimer = setTimeout(function () {
    fetch("/api/search?q=" + encodeURIComponent(q)).then(function (r) { return r.json(); }).then(function (data) {
      var tracks = data.tracks || [];
      resultsEl.innerHTML = "";
      if (tracks.length === 0) {
        resultsEl.innerHTML = '<div class="playlist-picker-empty">No results found.</div>';
        return;
      }
      tracks.forEach(function (item) {
        var videoId = String(item.id || "").trim();
        if (!videoId) return;
        var title = item.name || "Unknown";
        var thumb = item.album_pic || "";
        var channel = item.artist || "";
        var wrap = document.createElement("div");
        wrap.className = "list-item-wrap";
        var div = document.createElement("div");
        div.className = "list-item";
        div.style.gridTemplateColumns = "50px 1fr 36px auto";
        div.style.cursor = "default";
        div.innerHTML =
          '<img class="list-thumb" src="' + thumb + '" alt="" loading="lazy">' +
          '<div class="list-info"><div class="list-title">' + title + '</div><div class="list-channel"><span class="artist-link" data-artist="' + channel + '">' + channel + '</span></div></div>' +
          '<button class="add-song-preview" title="Preview" style="justify-self:center"><i class="fa-solid fa-play"></i></button>' +
          '<button class="add-song-add" title="Add to Playlist"><i class="fa-solid fa-plus"></i></button>';
        div.querySelector(".add-song-preview").addEventListener("click", function (e) {
          e.stopPropagation();
          previewSong(videoId, title, thumb, channel);
        });
        div.querySelector(".add-song-add").addEventListener("click", function (e) {
          e.stopPropagation();
          fetch("/playlists/" + currentPlaylistId + "/songs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ videoId: videoId, title: title, thumbnail: thumb, artist: channel, duration: item.duration_formatted || "" })
          }).then(function (r) { return r.json(); }).then(function () {
            openPlaylist(currentPlaylistId);
          }).catch(function () {});
        });
        wrap.appendChild(div);
        resultsEl.appendChild(wrap);
      });
    }).catch(function () {
      resultsEl.innerHTML = '<div class="playlist-picker-empty">Search failed.</div>';
    });
  }, 300);
});

var previewAudioEl = null;
var previewTimer = null;
function previewSong(videoId, title, thumb, channel) {
  if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
  if (previewAudioEl) { previewAudioEl.pause(); previewAudioEl.src = ""; }
  previewAudioEl = new Audio();
  previewAudioEl.volume = audio.volume;
  var previewUrl = "/stream?id=" + encodeURIComponent(videoId);
  previewAudioEl.src = previewUrl;
  previewAudioEl.load();
  previewAudioEl.play().catch(function () {});
  previewTimer = setTimeout(function () {
    if (previewAudioEl) { previewAudioEl.pause(); previewAudioEl.src = ""; }
    previewTimer = null;
  }, 25000);
}

function addSongToPlaylistPicker(videoId, title, thumb) {
  showPlaylistPicker({ videoId: videoId, title: title, thumb: thumb });
}

document.addEventListener("click", hideCtxMenu);
document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest(".song-card") && !e.target.closest(".list-item"))
    hideCtxMenu();
});
document.addEventListener("click", function (e) {
  var link = e.target.closest(".artist-link");
  if (link) {
    e.stopPropagation();
    var artistName = link.dataset.artist;
    if (artistName) window.location.hash = "#artist/" + encodeURIComponent(artistName);
  }
});

function showSkeletons(count = 10) {
  const grid = document.getElementById("resultsGrid");
  setHoveredQueueSong(null);
  grid.className = "results-grid";
  grid.innerHTML = "";
  for (let i = 0; i < count; i++) {
    grid.innerHTML += `<div class="song-card loading"><div class="thumb-wrap"><span class="skeleton"></span></div><div class="skel-title skeleton"></div><div class="skel-sub skeleton"></div></div>`;
  }
}

async function loadRecommendations() {
  history.replaceState(null, "", "/");
  var existingBack = document.querySelector(".back-btn");
  if (existingBack) existingBack.remove();
  var hl = document.querySelector(".header-left");
  if (hl) hl.style.display = "";
  document.getElementById("viewTitle").innerText = "Explore";
  sectionLabel.innerText = "Recommended for You";
  showSkeletons(10);
  try {
    const res = await fetch("/api/recommendations");
    const data = await res.json();
    renderSongs(data.items || []);
  } catch {
    document.getElementById("resultsGrid").innerHTML =
      "<p style='color:var(--text-dim);padding:16px 0'>Could not load recommendations.</p>";
  }
}

let searchActiveTab = "tracks";

function renderEmptySearchView() {
  const grid = document.getElementById("resultsGrid");
  setHoveredQueueSong(null);
  document.getElementById("viewTitle").innerText = "Search";
  sectionLabel.innerText = "Search songs, artists, and more";
  grid.className = "results-grid";
  grid.innerHTML =
    "<p style='color:var(--text-dim);padding:16px 0;grid-column:1/-1'>Search for a song or artist to see results here.</p>";
  const existingTabs = document.getElementById("searchTabs");
  if (existingTabs) existingTabs.remove();
}

function renderSearchTabs() {
  const existingTabs = document.getElementById("searchTabs");
  if (existingTabs) existingTabs.remove();
  const tabs = document.createElement("div");
  tabs.id = "searchTabs";
  tabs.className = "search-tabs";
  ["tracks", "artists", "albums"].forEach((tab) => {
    const btn = document.createElement("button");
    btn.className = "search-tab" + (searchActiveTab === tab ? " active" : "");
    btn.dataset.tab = tab;
    btn.textContent = tab.charAt(0).toUpperCase() + tab.slice(1);
    btn.addEventListener("click", () => {
      searchActiveTab = tab;
      const data = lastSearchResults;
      if (!data) return;
      renderSearchTabContent(tab, data);
      tabs.querySelectorAll(".search-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    });
    tabs.appendChild(btn);
  });
  sectionLabel.after(tabs);
}

function renderSearchTabContent(tab, data) {
  const grid = document.getElementById("resultsGrid");
  setHoveredQueueSong(null);
  grid.innerHTML = "";
  if (tab === "tracks") {
    const songs = renderSongsList(data.tracks || []);
    rebuildSearchPlaybackQueue(songs);
    highlightActive();
  } else if (tab === "artists") {
    grid.className = "results-grid artist-grid";
    (data.artists || []).forEach((artist) => {
      const card = document.createElement("div");
      card.className = "artist-card";
      card.innerHTML = `<img src="${artist.picture || ""}" alt="${artist.name}" loading="lazy"><div>${artist.name}</div>`;
      card.addEventListener("click", () => {
        window.location.hash = `#artist/${encodeURIComponent(artist.name)}`;
      });
      grid.appendChild(card);
    });
    if (!data.artists || data.artists.length === 0) {
      grid.innerHTML = "<p style='color:var(--text-dim);padding:16px 0;grid-column:1/-1'>No artists found.</p>";
    }
  } else if (tab === "albums") {
    grid.className = "results-grid";
    (data.albums || []).forEach((album) => {
      const card = document.createElement("div");
      card.className = "song-card";
      card.innerHTML = `<div class="thumb-wrap"><img src="${album.cover || ""}" alt="${album.title}" loading="lazy"></div><h3>${album.title}</h3><p>${album.artist}${album.year ? " � " + album.year : ""}</p>`;
      card.addEventListener("click", () => {
        if (album.id) window.location.hash = `#album/${album.id}`;
      });
      grid.appendChild(card);
    });
    if (!data.albums || data.albums.length === 0) {
      grid.innerHTML = "<p style='color:var(--text-dim);padding:16px 0;grid-column:1/-1'>No albums found.</p>";
    }
  }
}

function showSearchResults(query, data) {
  document.getElementById("viewTitle").innerText = "Search";
  sectionLabel.innerText = `Results for "${query}"`;
  loadedSearchQuery = query;
  lastSearchResults = data;
  renderSearchTabs();
  renderSearchTabContent(searchActiveTab, data);
}

function showSearchView() {
  showHomeView();
  setActiveNav(navSearch);
  const searchInput = document.getElementById("songSearch");
  if (searchInput && lastSearchQuery) searchInput.value = lastSearchQuery;
  if (!lastSearchQuery || !lastSearchResults || !lastSearchResults.tracks) {
    renderEmptySearchView();
    return;
  }
  showSearchResults(lastSearchQuery, lastSearchResults);
}

function clearSearchState() {
  searchPlaybackQueue = [];
  searchPlaybackIndex = -1;
  lastSearchQuery = "";
  lastSearchResults = null;
  loadedSearchQuery = "";
  pendingSearchQuery = "";
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = 0;
  }
}

async function runSearch(query) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) {
    clearSearchState();
    showHomeView();
    setActiveNav(navHome);
    loadRecommendations();
    return;
  }

  if (queueViewOpen) closeQueueView();
  prevView = null;
  showHomeView();
  setActiveNav(navSearch);
  document.getElementById("viewTitle").innerText = "Search";
  sectionLabel.innerText = `Results for "${normalizedQuery}"`;

  if (
    loadedSearchQuery === normalizedQuery &&
    lastSearchQuery === normalizedQuery &&
    lastSearchResults
  ) {
    showSearchResults(normalizedQuery, lastSearchResults);
    pendingSearchQuery = "";
    return;
  }

  const requestId = ++activeSearchRequestId;
  pendingSearchQuery = normalizedQuery;
  showSkeletons(10);

  try {
    const response = await fetch(
      `/api/search?q=${encodeURIComponent(normalizedQuery)}`
    );
    const data = await response.json();
    if (requestId !== activeSearchRequestId) return;
    lastSearchQuery = normalizedQuery;
    lastSearchResults = data || { tracks: [], artists: [], albums: [] };
    pendingSearchQuery = "";
    showSearchResults(normalizedQuery, lastSearchResults);
  } catch {
    if (requestId !== activeSearchRequestId) return;
    lastSearchQuery = normalizedQuery;
    lastSearchResults = null;
    loadedSearchQuery = "";
    pendingSearchQuery = "";
    document.getElementById("resultsGrid").innerHTML =
      "<p style='color:var(--text-dim);padding:16px 0'>Could not load search results.</p>";
  }
}

function scheduleSearch(query) {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = 0;
    runSearch(query);
  }, 250);
}

loadRecommendations();
restoreQueueFromCookie();
updateQueueBadge();
restoreCurrentSongFromCookie();
prefetchQueueSongs();
loadThemes().then(initSettings);

document.addEventListener('error', function (e) {
  if (e.target.tagName === 'IMG') {
    e.target.src = 'icon.png';
    e.target.style.backgroundColor = 'var(--accent)';
  }
}, true);

const savedUser = localStorage.getItem("aspec_user");
if (savedUser) {
  fetch(`/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: savedUser, password: "" }) })
    .catch(() => {});
  setLoggedInUser(savedUser);
}
setInterval(() => {
  if (!document.hidden) prefetchQueueSongs();
}, queuePrefetchIntervalMs);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) prefetchQueueSongs();
});
window.addEventListener("pagehide", () => {
  persistCurrentSongState();
  persistQueueState();
});

const songSearchInput = document.getElementById("songSearch");

songSearchInput.addEventListener("input", (e) => {
  const query = e.target.value.trim();
  if (!query) {
    clearSearchState();
    showHomeView();
    setActiveNav(navHome);
    loadRecommendations();
    return;
  }
  scheduleSearch(query);
});

songSearchInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const query = e.target.value.trim();
  if (!query) {
    e.preventDefault();
    return;
  }
  if (query === loadedSearchQuery || query === pendingSearchQuery) {
    e.preventDefault();
    return;
  }
  e.preventDefault();
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = 0;
  }
  runSearch(query);
});

function renderSongs(items) {
  currentIndex = -1;
  const grid = document.getElementById("resultsGrid");
  setHoveredQueueSong(null);
  grid.className = "results-grid";
  grid.innerHTML = "";
  const songs = items
    .map((item) => ({
      videoId: String(item.id?.videoId || item.id || "").trim(),
      title: item.snippet?.title || item.name || "Unknown",
      thumb: item.snippet?.thumbnails?.medium?.url || item.album_pic || "",
      channel: item.snippet?.channelTitle || item.artist || "",
    }))
    .filter((song) => song.videoId);
  currentSearchList = songs;
  prefetchLyricsForSongs(currentSearchList, 5);
  songs.forEach((song, index) => {
    const card = document.createElement("div");
    card.dataset.videoId = song.videoId;
    card._song = song;
    card.className = "song-card" + (currentIndex === index ? " active" : "");
    card.innerHTML = `<div class="thumb-wrap"><img src="${song.thumb}" alt="${song.title}" loading="lazy"><div class="play-overlay"><button class="ov-btn"><i class="fa-solid fa-play"></i></button></div></div><h3>${song.title}</h3><p><span class="artist-link" data-artist="${song.channel}">${song.channel}</span></p>`;
    card.addEventListener("click", (e) => {
      if (e.target.closest(".artist-link")) return;
      currentIndex = index;
      playSong(song.videoId, song.title, song.thumb, song.channel);
      highlightActive();
    });
    card.addEventListener("mouseenter", () => setHoveredQueueSong(song));
    card.addEventListener("mouseleave", () => setHoveredQueueSong(null));
    card.addEventListener("contextmenu", (e) => showCtxMenu(e, song));
    grid.appendChild(card);
  });
}

function renderSongsList(items) {
  let artists = [];
  let artistSrcs = [];
  currentIndex = -1;
  const grid = document.getElementById("resultsGrid");
  setHoveredQueueSong(null);
  grid.className = "list-grid";
  grid.innerHTML = "";
  const songs = items
    .map((item) => ({
      videoId: String(item.id || "").trim(),
      title: item.name || "Unknown",
      thumb: item.album_pic || "",
      channel: item.artist || "",
      artistPic: item.artist_pic || "",
      duration: item.duration_formatted || "",
    }))
    .filter((song) => song.videoId);
  currentSearchList = songs;
  prefetchLyricsForSongs(currentSearchList, 5);
  songs.forEach((song, index) => {
    const wrap = document.createElement("div");
    wrap.className = "list-item-wrap";
    const row = document.createElement("div");
    row.dataset.videoId = song.videoId;
    row._song = song;
    row.className = "list-item" + (currentIndex === index ? " active" : "");
    const actionsHtml = song.duration
      ? `<span class="list-duration">${song.duration}</span><i class="fa-solid fa-ellipsis-h dotted"></i>`
      : ``;
    row.innerHTML = `<span class="list-num">${index + 1
      }</span><img class="list-thumb" src="${song.thumb
      }" alt="" loading="lazy"><div class="list-info"><div class="list-title">${song.title
      }</div><div class="list-channel"><span class="artist-link" data-artist="${song.channel}">${song.channel}</span></div></div>${actionsHtml}`;
    row.addEventListener("click", (e) => {
      if (e.target.closest(".artist-link")) return;
      if (getCurrentTab() === "search" && searchPlaybackQueue.length > 0) {
        syncSearchPlaybackIndexBySongId(song.videoId);
      }
      currentIndex = index;
      playSong(song.videoId, song.title, song.thumb, song.channel);
      highlightActive();
    });
    row.addEventListener("mouseenter", () => setHoveredQueueSong(song));
    row.addEventListener("mouseleave", () => setHoveredQueueSong(null));
    row.addEventListener("contextmenu", (e) => showCtxMenu(e, song));
    row.querySelector(".dotted")?.addEventListener("click", (e) => {
      e.stopPropagation();
      showCtxMenu(e, song);
    });
    wrap.appendChild(row);
    grid.appendChild(wrap);
    if (
      song.thumb ==
      "https://resources.tidal.com/images/4e4aec29/deff/466e/9ea1/c47916d5960b/640x640.jpg"
    ) {
      row.querySelector(".list-thumb").style.filter = "blur(2px)";
    }
  });
  return songs;
}

function applyArabicClass() {
  const hasArabic = isArabicText(document.body.innerText);
  document.documentElement.classList.toggle("arabicText", hasArabic);
}

function highlightActive() {
  document
    .querySelectorAll(".song-card")
    .forEach((card, i) =>
      card.classList.toggle(
        "active",
        (currentSongId && card.dataset.videoId === currentSongId) ||
        i === currentIndex
      )
    );
  document
    .querySelectorAll(".list-item")
    .forEach((row, i) =>
      row.classList.toggle(
        "active",
        (currentSongId && row.dataset.videoId === currentSongId) ||
        i === currentIndex
      )
    );
  document
    .querySelectorAll(".artist-track-item")
    .forEach((row) =>
      row.classList.toggle(
        "active",
        currentSongId && row.dataset.videoId === currentSongId
      )
    );
}

function setActiveNav(btn) {
  if (!btn) return;
  document
    .querySelectorAll(".rail-btn")
    .forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
}

if (navHome) {
  navHome.addEventListener("click", function () {
    if (queueViewOpen) {
      closeQueueView();
      return;
    }
    history.replaceState(null, "", "/");
    setActiveNav(this);
    showHomeView();
    loadRecommendations();
  });
}

if (navSearch) {
  navSearch.addEventListener("click", function () {
    if (queueViewOpen) {
      closeQueueView();
      return;
    }
    history.replaceState(null, "", "/");
    showSearchView();
  });
}

if (navChangelog) {
  navChangelog.addEventListener("click", async function () {
    if (queueViewOpen) closeQueueView();
    setActiveNav(this);
    prevView = null;
    showChangelogView();
    await ensureChangelogLoaded();
  });
}

if (navLibrary) {
  navLibrary.addEventListener("click", function () {
    if (!currentUser) { showAuthModal(); return; }
    showHomeView();
    setActiveNav(this);
    queueViewOpen = false;
    document.getElementById("viewTitle").innerText = "Library";
    sectionLabel.innerText = "Your Playlists";
    loadPlaylists(true);
  });
}

if (navCredits) {
  navCredits.addEventListener("click", function () {
    if (queueViewOpen) closeQueueView();
    setActiveNav(this);
    prevView = null;
    showCreditsView();
  });
}

async function loadPlaylists(renderInGrid = false) {
  try {
    const url = currentUser ? `/playlists?username=${encodeURIComponent(currentUser)}` : "/playlists";
    const res = await fetch(url);
    const data = await res.json();
    if (!renderInGrid) return;
    const grid = document.getElementById("resultsGrid");
    grid.className = "results-grid";
    grid.innerHTML = "";
    const header = document.createElement("div");
    header.style.cssText = "grid-column:1/-1;display:flex;align-items:center;gap:12px;margin-bottom:8px";
    header.innerHTML = '<h2 style="margin:0;font-size:18px">Your Playlists</h2><div style="display:flex;gap:6px"><button id="createPlOpenBtn" style="margin:0;padding:6px 14px;font-size:12px;background:var(--accent);color:#fff;border:none;border-radius:10px;cursor:pointer;font-weight:600"><i class="fa-solid fa-plus"></i> New</button><button id="importPlOpenBtn" style="margin:0;padding:6px 14px;font-size:12px;background:transparent;color:var(--accent);border:1px solid var(--accent);border-radius:10px;cursor:pointer;font-weight:600"><i class="fa-solid fa-arrow-down"></i> Import</button></div>';
    grid.appendChild(header);
    document.getElementById("createPlOpenBtn").addEventListener("click", () => {
      document.getElementById("createPlaylistModal").style.display = "flex";
    });
    document.getElementById("importPlOpenBtn").addEventListener("click", () => {
      document.getElementById("importPlaylistModal").style.display = "flex";
    });
    if (!data.playlists.length) {
      const p = document.createElement("p");
      p.style.cssText = "color:var(--text-dim);padding:16px 0;grid-column:1/-1";
      p.textContent = "No playlists yet.";
      grid.appendChild(p);
      return;
    }
    data.playlists.forEach((pl) => {
      const card = document.createElement("div");
      card.className = "song-card";
      var plIconHtml = pl.image
        ? '<img src="' + pl.image + '" style="width:100%;height:100%;object-fit:cover;border-radius:8px">'
        : '<div style="width:100%;height:100%;border-radius:8px;background:linear-gradient(135deg,var(--accent),#8b5cf6);display:flex;align-items:center;justify-content:center"><i class="fa-solid fa-music" style="color:#fff;font-size:32px"></i></div>';
      card.innerHTML = '<div class="thumb-wrap" style="aspect-ratio:1">' + plIconHtml + '</div><h3>' + pl.name + '</h3><p>' + pl.songs.length + ' songs</p>';
      card.addEventListener("click", () => openPlaylist(pl.id));
      grid.appendChild(card);
    });
    applyArabicClass();
  } catch (err) {
    console.error(err);
  }
}

async function openPlaylist(id) {
  currentPlaylistId = id;
  document.getElementById("viewTitle").innerText = "Playlist";
  const url = currentUser ? `/playlists?username=${encodeURIComponent(currentUser)}` : "/playlists";
  const res = await fetch(url);
  const data = await res.json();
  const pl = data.playlists.find((p) => p.id === id);
  if (!pl) return;

  var mappedTracks = pl.songs.map(function (s) {
    return { videoId: s.videoId, title: s.title, thumb: s.thumbnail || s.thumb, channel: s.channel || s.artist || "", duration: s.duration || "" };
  }).filter(function (s) { return s.videoId; });

  currentSearchList = mappedTracks;

  (async function lookupPlaylistArtists() {
    for (var bi = 0; bi < mappedTracks.length; bi += 5) {
      var batch = mappedTracks.slice(bi, bi + 5);
      await Promise.allSettled(batch.map(async function (song) {
        if (!song.videoId) return;
        try {
          var lr = await fetch("/api/search?q=" + encodeURIComponent(song.title));
          var ld = await lr.json();
          if (ld.tracks) {
            for (var li = 0; li < ld.tracks.length; li++) {
              if (String(ld.tracks[li].id).trim() === song.videoId && ld.tracks[li].artist) {
                song.channel = ld.tracks[li].artist;
                return;
              }
            }
          }
        } catch {}
      }));
    }
    document.querySelectorAll(".playlist-track-artist").forEach(function (el) {
      var vid = el.dataset.videoId;
      var match = mappedTracks.find(function (s) { return s.videoId === vid; });
      if (match) el.textContent = match.channel;
    });
    var alinks = document.querySelectorAll(".artist-link");
    alinks.forEach(function (a) {
      var vid = a.dataset.videoId;
      var match = mappedTracks.find(function (s) { return s.videoId === vid; });
      if (match) a.textContent = match.channel;
    });
  })();

  const grid = document.getElementById("resultsGrid");
  grid.className = "list-grid";
  grid.innerHTML = "";

  var albumWrap = document.createElement("div");
  albumWrap.className = "album-page-wrap";

  var hero = document.createElement("div");
  hero.className = "album-spotify-hero";

  var heroInner = document.createElement("div");
  heroInner.className = "album-spotify-inner";

  var artWrap = document.createElement("div");
  artWrap.className = "album-art-wrap";
  if (pl.image) {
    artWrap.innerHTML = '<img src="' + pl.image + '" style="width:200px;height:200px;border-radius:8px;object-fit:cover;box-shadow:0 8px 30px rgba(0,0,0,0.4)">';
  } else {
    artWrap.innerHTML = '<div style="width:200px;height:200px;border-radius:8px;background:linear-gradient(135deg,var(--accent),#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:60px;color:#fff;box-shadow:0 8px 30px rgba(0,0,0,0.4)"><i class="fa-solid fa-music"></i></div>';
  }
  heroInner.appendChild(artWrap);

  var metaWrap = document.createElement("div");
  metaWrap.className = "album-meta-wrap";
  metaWrap.innerHTML =
    '<div class="album-type-label">PLAYLIST</div>' +
    '<h1 class="album-spotify-title">' + (pl.name || "") + '</h1>' +
    '<div class="album-spotify-meta">' +
      '<span>' + pl.songs.length + ' song' + (pl.songs.length !== 1 ? 's' : '') + '</span>' +
    '</div>';
  heroInner.appendChild(metaWrap);

  var ellipsisWrap = document.createElement("div");
  ellipsisWrap.className = "pl-options-wrap";
  ellipsisWrap.innerHTML = '<button class="pl-options-btn" title="More"><i class="fa-solid fa-ellipsis-v"></i></button><div class="pl-options-dropdown"><button class="pl-opt-rename"><i class="fa-solid fa-pencil"></i> Edit</button><button class="pl-opt-del"><i class="fa-solid fa-trash-can"></i> Delete</button></div>';
  heroInner.appendChild(ellipsisWrap);

  hero.appendChild(heroInner);
  albumWrap.appendChild(hero);

  var ellipsisBtn = ellipsisWrap.querySelector(".pl-options-btn");
  var ellipsisDropdown = ellipsisWrap.querySelector(".pl-options-dropdown");
  ellipsisBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    ellipsisDropdown.classList.toggle("show");
  });
  document.addEventListener("click", function closePlDropdown(e) {
    if (!ellipsisWrap.contains(e.target)) ellipsisDropdown.classList.remove("show");
  });
  ellipsisDropdown.querySelector(".pl-opt-rename").addEventListener("click", function () {
    ellipsisDropdown.classList.remove("show");
    document.getElementById("editPlName").value = pl.name || "";
    document.getElementById("editPlDescription").value = pl.description || "";
    document.getElementById("editPlImageInput").value = "";
    var preview = document.getElementById("editPlImagePreview");
    if (pl.image) {
      preview.innerHTML = '<img src="' + pl.image + '" style="width:100%;height:100%;object-fit:cover;border-radius:12px">';
      preview.dataset.imageData = pl.image;
      document.getElementById("editPlRemoveImage").style.display = "";
    } else {
      preview.innerHTML = '<i class="fa-solid fa-music"></i>';
      preview.dataset.imageData = "";
      document.getElementById("editPlRemoveImage").style.display = "none";
    }
    document.getElementById("editPlaylistModal").style.display = "flex";
  });
  ellipsisDropdown.querySelector(".pl-opt-del").addEventListener("click", function () {
    ellipsisDropdown.classList.remove("show");
    if (confirm("Delete this playlist? This cannot be undone.")) {
      fetch("/playlists/" + id, { method: "DELETE" }).then(function (r) { return r.json(); }).then(function () {
        var libNav = document.getElementById("navLibrary");
        if (libNav) libNav.click();
      }).catch(function () {});
    }
  });

  var actions = document.createElement("div");
  actions.className = "album-spotify-actions";
  actions.innerHTML =
    '<button class="album-spotify-play" title="Play All"><i class="fa-solid fa-play"></i></button>' +
    '<button class="album-spotify-shuffle" title="Shuffle"><i class="fa-solid fa-shuffle"></i></button>' +
    '<button class="album-spotify-add-songs" title="Add Songs" style="margin-left:auto;background:none;border:1px solid var(--border);color:var(--text-secondary);padding:6px 14px;border-radius:20px;font-size:13px;cursor:pointer;transition:all 0.15s;display:flex;align-items:center;gap:6px"><i class="fa-solid fa-plus"></i> Add Songs</button>';
  var playAllBtn = actions.querySelector(".album-spotify-play");
  playAllBtn.addEventListener("click", function () {
    if (mappedTracks.length > 0) {
      currentSearchList = mappedTracks;
      currentIndex = 0;
      playSong(mappedTracks[0].videoId, mappedTracks[0].title, mappedTracks[0].thumb, mappedTracks[0].channel);
      highlightActive();
    }
  });
  var shuffleBtn = actions.querySelector(".album-spotify-shuffle");
  shuffleBtn.addEventListener("click", function () {
    if (mappedTracks.length > 0) {
      var shuffled = mappedTracks.slice();
      for (var i = shuffled.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = shuffled[i];
        shuffled[i] = shuffled[j];
        shuffled[j] = tmp;
      }
      currentSearchList = shuffled;
      currentIndex = 0;
      playSong(shuffled[0].videoId, shuffled[0].title, shuffled[0].thumb, shuffled[0].channel);
      highlightActive();
    }
  });
  var addSongsBtn = actions.querySelector(".album-spotify-add-songs");
  addSongsBtn.addEventListener("click", function () {
    document.getElementById("addSongSearchInput").value = "";
    document.getElementById("addSongResults").innerHTML = "";
    document.getElementById("addSongEmpty").style.display = "block";
    document.getElementById("addSongModal").style.display = "flex";
    setTimeout(function () { document.getElementById("addSongSearchInput").focus(); }, 100);
  });
  albumWrap.appendChild(actions);

  if (pl.songs.length === 0) {
    var emptyMsg = document.createElement("p");
    emptyMsg.style.cssText = "color:var(--text-dim);padding:16px 0;margin:0";
    emptyMsg.textContent = "No songs in this playlist yet.";
    albumWrap.appendChild(emptyMsg);
  } else {
    var trackList = document.createElement("div");
    trackList.className = "discog-tracks";

    mappedTracks.forEach(function (song, tIdx) {
      var wrap = document.createElement("div");
      wrap.className = "list-item-wrap";
      var row = document.createElement("div");
      row.className = "list-item";
      row.style.gridTemplateColumns = "40px 50px 1fr 100px 40px 40px";
      row.dataset.videoId = song.videoId;
      row._song = song;
      var actionsHtml = song.duration
        ? '<span class="list-duration">' + song.duration + '</span><button class="list-remove" title="Remove"><i class="fa-solid fa-trash"></i></button><i class="fa-solid fa-ellipsis-h dotted"></i>'
        : '<button class="list-remove" title="Remove"><i class="fa-solid fa-trash"></i></button><i class="fa-solid fa-ellipsis-h dotted"></i>';
      row.innerHTML =
        '<span class="list-num">' + (tIdx + 1) + '</span>' +
        '<img class="list-thumb" src="' + song.thumb + '" alt="" loading="lazy">' +
        '<div class="list-info"><div class="list-title">' + song.title + '</div><div class="list-channel"><span class="artist-link" data-artist="' + song.channel + '">' + song.channel + '</span></div></div>' +
        actionsHtml;
      row.addEventListener("click", function (e) {
        if (e.target.closest(".list-remove") || e.target.closest(".artist-link") || e.target.closest(".dotted")) return;
        currentSearchList = mappedTracks;
        currentIndex = tIdx;
        playSong(song.videoId, song.title, song.thumb, song.channel);
        highlightActive();
      });
      row.addEventListener("contextmenu", function (e) { showCtxMenu(e, song); });
      row.querySelector(".dotted")?.addEventListener("click", function (e) {
        e.stopPropagation();
        showCtxMenu(e, song);
      });
      var removeBtn = row.querySelector(".list-remove");
      if (removeBtn) removeBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        removeSongFromPlaylist(id, song.videoId);
      });
      wrap.appendChild(row);
      trackList.appendChild(wrap);
    });

    albumWrap.appendChild(trackList);
  }

  var recSection = document.createElement("div");
  recSection.style.cssText = "margin-top:40px;padding-top:32px;border-top:1px solid var(--border)";
  recSection.innerHTML = '<h2 style="font-size:1.3rem;font-weight:700;margin-bottom:6px">Add More Songs</h2><p style="color:var(--text-dim);font-size:13px;margin:0 0 16px">Discover and add tracks to this playlist</p><div class="results-grid" id="playlistRecGrid"></div>';
  albumWrap.appendChild(recSection);

  grid.appendChild(albumWrap);
  applyArabicClass();

  fetch("/api/recommendations").then(function (r) { return r.json(); }).then(function (recData) {
    var recGrid = document.getElementById("playlistRecGrid");
    if (!recGrid) return;
    var items = recData.items || [];
    items.forEach(function (item) {
      var videoId = String(item.id?.videoId || item.id || "").trim();
      if (!videoId) return;
      var title = item.snippet?.title || item.name || "Unknown";
      var thumb = item.snippet?.thumbnails?.medium?.url || item.album_pic || "";
      var channel = item.snippet?.channelTitle || item.artist || "";
      var card = document.createElement("div");
      card.className = "song-card";
      card.innerHTML =
        '<div class="thumb-wrap"><img src="' + thumb + '" alt="' + title + '" loading="lazy"><div class="play-overlay"><button class="ov-btn"><i class="fa-solid fa-play"></i></button></div></div>' +
        '<h3>' + title + '</h3>' +
        '<p><span class="artist-link" data-artist="' + channel + '">' + channel + '</span></p>' +
        '<button class="add-to-pl-btn" title="Add to Playlist"><i class="fa-solid fa-plus"></i> Add</button>';
      var playBtn = card.querySelector(".ov-btn");
      playBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        currentIndex = 0;
        playSong(videoId, title, thumb, channel);
        highlightActive();
      });
      card.querySelector(".add-to-pl-btn").addEventListener("click", function (e) {
        e.stopPropagation();
        addSongToPlaylistPicker(videoId, title, thumb);
      });
      card.addEventListener("click", function () {
        currentIndex = 0;
        playSong(videoId, title, thumb, channel);
        highlightActive();
      });
      recGrid.appendChild(card);
    });
  }).catch(function () {});
}

async function removeSongFromPlaylist(playlistId, songId) {
  const res = await fetch(`/playlists/${playlistId}/songs/${songId}`, {
    method: "DELETE",
  });
  if (res.ok) openPlaylist(playlistId);
}

// ====== Spotify Import ======

document.getElementById("importPlClose")?.addEventListener("click", () => {
  document.getElementById("importPlaylistModal").style.display = "none";
  document.getElementById("importPlUrl").value = "";
  document.getElementById("importPlError").textContent = "";
});

document.getElementById("importPlaylistModal")?.addEventListener("click", (e) => {
  if (e.target === e.currentTarget) {
    document.getElementById("importPlaylistModal").style.display = "none";
    document.getElementById("importPlUrl").value = "";
    document.getElementById("importPlError").textContent = "";
  }
});

document.getElementById("importPlBtn")?.addEventListener("click", async () => {
  const url = document.getElementById("importPlUrl").value.trim();
  if (!url) {
    document.getElementById("importPlError").textContent = "Please enter a Spotify playlist URL";
    return;
  }
  document.getElementById("importPlaylistModal").style.display = "none";
  document.getElementById("importPlUrl").value = "";
  document.getElementById("importPlError").textContent = "";
  await processImportPlaylist(url);
});

async function processImportPlaylist(url) {
  const viewTitleEl = document.getElementById("viewTitle");
  const sectionLabelEl = document.getElementById("sectionLabel");
  const resultsGrid = document.getElementById("resultsGrid");

  var existingBack = document.querySelector(".back-btn");
  if (existingBack) existingBack.remove();

  showHomeView();

  var backBtn = document.createElement("button");
  backBtn.className = "back-btn";
  backBtn.innerHTML = '<i class="fa-solid fa-arrow-left"></i>';
  backBtn.addEventListener("click", function () {
    history.replaceState(null, "", "/");
    if (currentUser) {
      document.getElementById("viewTitle").innerText = "Library";
      loadPlaylists(true);
    } else {
      loadRecommendations();
    }
  });
  var headerLeft = document.querySelector(".header-left");
  if (headerLeft) headerLeft.insertBefore(backBtn, headerLeft.firstChild);
  var hl = document.querySelector(".header-left");
  if (hl) hl.style.display = "flex";

  viewTitleEl.innerText = "Import Playlist";
  sectionLabelEl.innerText = "Fetching playlist info...";
  resultsGrid.className = "results-grid";
  resultsGrid.innerHTML = '<p style="color:var(--text-dim);padding:16px 0">Fetching playlist from Spotify...</p>';

  try {
    const res = await fetch(`/api/spotifyinfo/playlist?url=${encodeURIComponent(url)}`);
    if (!res.ok) {
      const errText = await res.text();
      let errMsg = "Failed to fetch playlist";
      try { const errData = JSON.parse(errText); errMsg = errData.error || errMsg; } catch {}
      throw new Error(errMsg);
    }
    const data = await res.json();
    const spotifyTracks = data.tracks || [];

    if (!spotifyTracks.length) {
      sectionLabelEl.innerText = "";
      resultsGrid.innerHTML = '<p style="color:var(--text-dim);padding:16px 0">No tracks found in this playlist.</p>';
      return;
    }

    sectionLabelEl.innerText = `Searching ${spotifyTracks.length} tracks...`;
    resultsGrid.innerHTML = '<p style="color:var(--text-dim);padding:16px 0">Searching for matching tracks in library...</p>';

    var searchResults = await Promise.allSettled(
      spotifyTracks.map(async function (track) {
        var query = (track.name || "") + " " + (track.artists || "");
        try {
          var searchRes = await fetch("/api/search?q=" + encodeURIComponent(query));
          var searchData = await searchRes.json();
          var matched = null;
          var spotifyArtistLower = (track.artists || "").toLowerCase().trim();
          if (searchData.tracks) {
            for (var mi = 0; mi < searchData.tracks.length; mi++) {
              var candidate = searchData.tracks[mi];
              var candidateArtistLower = (candidate.artist || "").toLowerCase().trim();
              if (candidateArtistLower && spotifyArtistLower && (candidateArtistLower === spotifyArtistLower || candidateArtistLower.includes(spotifyArtistLower) || spotifyArtistLower.includes(candidateArtistLower))) {
                matched = candidate;
                break;
              }
            }
          }
          return {
            spotifyName: track.name || "Unknown",
            spotifyArtists: track.artists || "",
            spotifyAlbum: track.albumName || "",
            spotifyImage: track.albumImage || "",
            matched: !!matched,
            videoId: matched ? String(matched.id).trim() : null,
            title: matched ? matched.name : (track.name || ""),
            artist: matched ? matched.artist : (track.artists || ""),
            thumb: matched ? matched.album_pic : (track.albumImage || ""),
          };
        } catch {
          return {
            spotifyName: track.name || "Unknown",
            spotifyArtists: track.artists || "",
            matched: false,
            videoId: null,
            title: track.name || "",
            artist: track.artists || "",
            thumb: track.albumImage || "",
          };
        }
      })
    );

    var importResults = searchResults.map(function (r) {
      return r.status === "fulfilled" ? r.value : {
        spotifyName: "Unknown",
        spotifyArtists: "",
        matched: false,
        videoId: null,
        title: "Unknown",
        artist: "",
        thumb: "",
      };
    });

    renderImportChecklist(importResults);
  } catch (err) {
    sectionLabelEl.innerText = "";
    resultsGrid.innerHTML = "<p style='color:var(--text-dim);padding:16px 0'>Error: " + escapeHtml(err.message) + "</p>";
  }
}

function renderImportChecklist(results) {
  var viewTitleEl = document.getElementById("viewTitle");
  var sectionLabelEl = document.getElementById("sectionLabel");
  var resultsGrid = document.getElementById("resultsGrid");

  viewTitleEl.innerText = "Import Playlist";

  var matchedCount = results.filter(function (r) { return r.matched; }).length;
  var totalCount = results.length;
  sectionLabelEl.innerText = matchedCount + "/" + totalCount + " tracks found";

  resultsGrid.className = "list-grid";
  resultsGrid.innerHTML = "";

  var actionBar = document.createElement("div");
  actionBar.style.cssText = "grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;margin-bottom:12px";
  actionBar.innerHTML =
    '<p style="margin:0;font-size:13px;color:var(--text-dim)">' +
    '<i class="fa-solid fa-circle-info"></i> Uncheck any songs you don\'t want to import' +
    '</p>' +
    '<button id="importSelectedBtn" style="padding:8px 20px;font-size:13px;background:var(--accent);color:#fff;border:none;border-radius:10px;cursor:pointer;font-weight:600">' +
    '<i class="fa-solid fa-download"></i> Import Selected (' + matchedCount + ')' +
    '</button>';
  resultsGrid.appendChild(actionBar);

  results.forEach(function (result, index) {
    var wrap = document.createElement("div");
    wrap.className = "list-item-wrap";
    var row = document.createElement("div");
    row.className = "list-item";
    var checkedAttr = result.matched ? "checked" : "";
    var disabledAttr = result.matched ? "" : "disabled";
    var statusHtml = result.matched
      ? '<span style="font-size:12px;white-space:nowrap;color:var(--accent)"><i class="fa-solid fa-check"></i> Found</span>'
      : '<span style="font-size:12px;white-space:nowrap;color:var(--text-dim)"><i class="fa-solid fa-xmark"></i> Not found</span>';
    row.innerHTML =
      '<span class="list-num" style="min-width:36px">' +
      '<input type="checkbox" class="import-check" data-index="' + index + '" ' + checkedAttr + ' ' + disabledAttr + ' style="width:16px;height:16px;cursor:pointer;accent-color:var(--accent)">' +
      '</span>' +
      '<img class="list-thumb" src="' + (result.thumb || "") + '" alt="" loading="lazy">' +
      '<div class="list-info">' +
      '<div class="list-title">' + escapeHtml(result.spotifyName) + '</div>' +
      '<div class="list-channel">' + escapeHtml(result.spotifyArtists) + '</div>' +
      '</div>' +
      statusHtml;
    wrap.appendChild(row);
    resultsGrid.appendChild(wrap);
  });

  document.querySelectorAll(".import-check:not([disabled])").forEach(function (cb) {
    cb.addEventListener("change", function () {
      var checked = document.querySelectorAll(".import-check:checked").length;
      var btn = document.getElementById("importSelectedBtn");
      if (btn) btn.innerHTML = '<i class="fa-solid fa-download"></i> Import Selected (' + checked + ')';
    });
  });

  document.getElementById("importSelectedBtn")?.addEventListener("click", function () { confirmImportPlaylist(results); });
}

async function confirmImportPlaylist(results) {
  var checkedBoxes = document.querySelectorAll(".import-check:checked");
  var selectedTracks = [];
  checkedBoxes.forEach(function (cb) {
    var idx = parseInt(cb.dataset.index);
    var r = results[idx];
    if (r && r.matched && r.videoId) {
      selectedTracks.push(r);
    }
  });

  if (selectedTracks.length === 0) {
    flashToast("No tracks selected");
    return;
  }

  var name = selectedTracks.length > 0
    ? "Imported: " + selectedTracks[0].spotifyName + (selectedTracks.length > 1 ? " & " + (selectedTracks.length - 1) + " more" : "")
    : "Imported Playlist";

  try {
    var createRes = await fetch("/playlists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, username: currentUser }),
    });
    if (!createRes.ok) throw new Error("Failed to create playlist");
    var playlist = await createRes.json();

    for (var ti = 0; ti < selectedTracks.length; ti++) {
      var track = selectedTracks[ti];
      await fetch("/playlists/" + playlist.id + "/songs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoId: track.videoId,
          title: track.title,
          thumbnail: track.thumb,
          artist: track.artist,
        }),
      }).catch(function () { });
    }

    flashToast("Imported " + selectedTracks.length + " songs to \"" + name + "\"");

    document.getElementById("viewTitle").innerText = "Library";
    sectionLabel.innerText = "Your Playlists";
    loadPlaylists(true);
  } catch (err) {
    flashToast("Failed to import: " + err.message);
  }
}

function showAuthModal() {
  document.getElementById("authModal").style.display = "flex";
}
function hideAuthModal() {
  document.getElementById("authModal").style.display = "none";
}

function setLoggedInUser(username) {
  currentUser = username;
  localStorage.setItem("aspec_user", username);
  const btn = document.getElementById("profileBtn");
  btn.innerHTML = escapeHtml(username.charAt(0).toUpperCase());
  btn.classList.add("logged-in");
  document.getElementById("navLibrary").style.display = "";
  hideAuthModal();
  const grid = document.getElementById("resultsGrid");
  grid.innerHTML = "";
  loadPlaylists(true);
}

function logout() {
  currentUser = null;
  localStorage.removeItem("aspec_user");
  const btn = document.getElementById("profileBtn");
  btn.innerHTML = '<i class="fa-solid fa-user"></i>';
  btn.classList.remove("logged-in");
  document.getElementById("navLibrary").style.display = "none";
  document.getElementById("viewTitle").innerText = "Explore";
  if (navHome) navHome.click();
}

document.getElementById("profileBtn").addEventListener("click", () => {
  if (currentUser) {
    if (confirm(`Logged in as ${currentUser}\n\nPress OK to log out.`)) logout();
  } else {
    showAuthModal();
  }
});

async function loginUser(username, password) {
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(text || "server error"); }
    if (!res.ok) throw new Error(data.error || "login failed");
    setLoggedInUser(data.username);
  } catch (err) {
    document.getElementById("loginError").textContent = err.message;
  }
}

async function signupUser(username, password) {
  try {
    const res = await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(text || "server error"); }
    if (!res.ok) throw new Error(data.error || "signup failed");
    setLoggedInUser(data.username);
  } catch (err) {
    document.getElementById("signupError").textContent = err.message;
  }
}

async function getLyrics(id) {
  const key = getLyricsKey(id);
  if (!key) return null;
  if (lyricsCache.has(key)) {
    return lyricsCache.get(key);
  }

  const lyricsPromise = fetch(`/api/lyrics?id=${encodeURIComponent(key)}`, {
    cache: "no-store",
  })
    .then((res) => {
      if (!res.ok) throw new Error("No lyrics found");
      return res.json();
    })
    .then((data) => {
      const lyrics = data?.lyrics || null;
      if (!lyrics) lyricsCache.delete(key);
      return lyrics
        ? {
          lyrics,
          isRightToLeft: Boolean(data?.isRightToLeft),
        }
        : null;
    })
    .catch(() => {
      lyricsCache.delete(key);
      return null;
    });

  lyricsCache.set(key, lyricsPromise);
  return lyricsPromise;
}

function prefetchLyricsForSongs(songs, limit = 5) {
  if (!Array.isArray(songs)) return;
  songs.slice(0, limit).forEach((song) => {
    getLyrics(song.videoId || song.id).catch(() => { });
  });
}

function renderLyrics(payload) {
  const container = document.getElementById("lyrics-container");
  if (!container) return;
  activeLyricLineIndex = -1;
  lyricsRightToLeft = Boolean(payload?.isRightToLeft);
  container.classList.toggle("rtl", lyricsRightToLeft);
  if (payload === null) {
    syncedLyrics = [];
    container.innerHTML =
      '<div class="lyrics-empty">Play something to get started</div>';
    applyArabicClass();
    return;
  }
  if (payload?.loading) {
    syncedLyrics = [];
    container.innerHTML = '<div class="lyrics-empty">Loading...</div>';
    return;
  }
  if (!payload?.lyrics) {
    syncedLyrics = [];
    container.innerHTML =
      '<div class="lyrics-empty">Lyrics not available for this track.</div>';
    applyArabicClass();
    return;
  }

  const lines = parseSynced(payload.lyrics);
  syncedLyrics = lines;

  if (!lines.length) {
    container.innerHTML =
      '<div class="lyrics-empty">Lyrics not available for this track.</div>';
    applyArabicClass();
    return;
  }

  container.innerHTML = lines
    .map(
      (line, index) =>
        `<div class="lyrics-line" data-index="${index}">${escapeHtml(
          line.text
        )}</div>`
    )
    .join("");
  applyArabicClass();
}

function parseSynced(lyrics) {
  if (!lyrics) return [];
  const lines = String(lyrics)
    .split("\n")
    .filter((line) => line.trim());
  const parsedLines = lines
    .map((line) => {
      const match = line.match(/\[(\d+):(\d+)\.(\d+)\]\s*(.+)/);
      if (match) {
        const [, minutes, seconds, centiseconds, text] = match;
        const timeInSeconds =
          parseInt(minutes) * 60 +
          parseInt(seconds) +
          parseInt(centiseconds) / 100;
        return { time: timeInSeconds, text: text.trim() };
      }
      return null;
    })
    .filter(Boolean);
  return parsedLines;
}

function resetLyricsState() {
  activeLyricLineIndex = -1;
  activeLyricsId = "";
  syncedLyrics = [];
  if (lyricsScrollFrame) {
    cancelAnimationFrame(lyricsScrollFrame);
    lyricsScrollFrame = 0;
  }
  scrollLyricsToTop();
  renderLyrics(null);
}

function scrollLyricsToTop() {
  const container = document.getElementById("lyrics-container");
  if (container) {
    container.scrollTop = 0;
  }
}

async function loadLyricsForTrack(id) {
  activeLyricsId = getLyricsKey(id);
  resetLyricsState();
  activeLyricsId = getLyricsKey(id);
  renderLyrics({ loading: true });
  scrollLyricsToTop();
  const lyricsPayload = await getLyrics(id);
  if (activeLyricsId !== getLyricsKey(id)) return;
  resetLyricsState();
  activeLyricsId = getLyricsKey(id);
  renderLyrics(lyricsPayload);
  scrollLyricsToTop();
}

function getCurrentLine(currentTime) {
  if (!syncedLyrics || syncedLyrics.length === 0) return -1;
  let currentIndex = -1;
  for (let i = 0; i < syncedLyrics.length; i++) {
    if (currentTime >= syncedLyrics[i].time) {
      currentIndex = i;
    } else {
      break;
    }
  }
  return currentIndex;
}

function smoothScrollLyricsTo(index, targetContainer) {
  const container = targetContainer || document.getElementById("lyrics-container");
  const activeLine = container?.querySelector(
    `.lyrics-line[data-index="${index}"]`
  );
  if (!container || !activeLine) return;
  const scrollEl = container === document.getElementById("fpLyricsContainer")
    ? container.parentElement
    : container;
  if (!scrollEl) return;
  const lineRect = activeLine.getBoundingClientRect();
  const scrollRect = scrollEl.getBoundingClientRect();
  const target = Math.max(
    0,
    scrollEl.scrollTop + lineRect.top - scrollRect.top -
    scrollRect.height / 2 +
    lineRect.height / 2
  );
  const start = scrollEl.scrollTop;
  const delta = target - start;
  if (Math.abs(delta) < 2) return;
  if (lyricsScrollFrame) cancelAnimationFrame(lyricsScrollFrame);
  const startTime = performance.now();
  const duration = 420;

  const step = (now) => {
    const progress = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    scrollEl.scrollTop = start + delta * eased;
    if (progress < 1) {
      lyricsScrollFrame = requestAnimationFrame(step);
    } else {
      lyricsScrollFrame = 0;
    }
  };

  lyricsScrollFrame = requestAnimationFrame(step);

  if (container !== document.getElementById("lyrics-container")) return;
  const fpContainer = document.getElementById("fpLyricsContainer");
  if (fpContainer && fpContainer !== container) {
    smoothScrollLyricsTo(index, fpContainer);
  }
}

function startLyricsAnimation() {
  if (lyricsAnimationFrame) cancelAnimationFrame(lyricsAnimationFrame);
  const tick = () => {
    lyricsAnimationFrame = 0;
    updateLyrics(audio.currentTime);
    if (!audio.paused && !audio.ended) {
      lyricsAnimationFrame = requestAnimationFrame(tick);
    }
  };
  lyricsAnimationFrame = requestAnimationFrame(tick);
}

function stopLyricsAnimation() {
  if (!lyricsAnimationFrame) return;
  cancelAnimationFrame(lyricsAnimationFrame);
  lyricsAnimationFrame = 0;
}

function syncLyricsAnimation() {
  updateLyrics(audio.currentTime);
  if (!audio.paused && !audio.ended) startLyricsAnimation();
}

function updateLyrics(currentTime) {
  if (!document.getElementById("lyricsPanel") && !fullPlayer?.classList.contains("open")) return;
  const index = getCurrentLine(currentTime);
  const containers = ["#lyrics-container", "#fpLyricsContainer"];
  containers.forEach((sel) => {
    const lines = document.querySelectorAll(sel + " .lyrics-line");
    lines.forEach((line, lineIndex) =>
      line.classList.toggle("active", lineIndex === index)
    );
  });
  if (index >= 0) {
    if (activeLyricLineIndex !== index) {
      activeLyricLineIndex = index;
      smoothScrollLyricsTo(index);
    }
  } else {
    activeLyricLineIndex = -1;
  }
}

function setLyricsPanel(open) {
  const panel = lyricsPanel || document.getElementById("lyricsPanel");
  const toggle = lyricsToggleBtn || document.getElementById("lyricsToggleBtn");
  const layout = document.querySelector(".content-layout");
  if (!panel || !toggle || !layout) return;
  panel.classList.toggle("closed", !open);
  toggle.classList.toggle("active", open);
  layout.classList.toggle("lyrics-open", open);
}

function toggleLyricsPanel() {
  if (!lyricsPanel) return;
  setLyricsPanel(lyricsPanel.classList.contains("closed"));
}

document.addEventListener("click", (e) => {
  if (e.target.closest("#lyricsToggleBtn")) {
    if (window.innerWidth <= 480 && currentSongId) {
      openFullPlayer();
    } else {
      toggleLyricsPanel();
    }
  }
  if (e.target.closest("#lyricsCloseBtn")) {
    setLyricsPanel(false);
  }
});

function getContrastColor(hexColor) {
  const hex = hexColor.replace("#", "");
  const fullHex =
    hex.length === 3
      ? hex
        .split("")
        .map((c) => c + c)
        .join("")
      : hex;

  const r = parseInt(fullHex.substring(0, 2), 16);
  const g = parseInt(fullHex.substring(2, 4), 16);
  const b = parseInt(fullHex.substring(4, 6), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;

  return yiq >= 128 ? "#000000" : "#ffffff";
}

const accentContrastBtn = document.getElementById("accentContrastBtn");
const bgContrastBtn = document.getElementById("bgContrastBtn");
const textContrastBtn = document.getElementById("textContrastBtn");

if (accentContrastBtn) {
  accentContrastBtn.addEventListener("click", () => {
    const accentInput = document.getElementById("themeAccent");
    if (accentInput) {
      accentInput.value = getContrastColor(accentInput.value);
      accentInput.dispatchEvent(new Event("input"));
    }
  });
}

if (bgContrastBtn) {
  bgContrastBtn.addEventListener("click", () => {
    const accentInput = document.getElementById("themeAccent");
    if (accentInput) {
      accentInput.value = getContrastColor(accentInput.value);
      accentInput.dispatchEvent(new Event("input"));
    }
  });
}

if (textContrastBtn) {
  textContrastBtn.addEventListener("click", () => {
    const accentInput = document.getElementById("themeAccent");
    if (accentInput) {
      accentInput.value = getContrastColor(accentInput.value);
      accentInput.dispatchEvent(new Event("input"));
    }
  });
}

let touchLongPressTimer = null;
let touchLongPressTarget = null;

document.addEventListener(
  "touchstart",
  (e) => {
    const card = e.target.closest(".song-card, .list-item");
    if (!card) return;
    touchLongPressTarget = card;
    touchLongPressTimer = setTimeout(() => {
      if (!touchLongPressTarget) return;
      const song = currentSearchList.find(
        (s) => s.videoId === card.dataset.videoId
      );
      if (song) {
        navigator.vibrate?.(10);
        showCtxMenu(
          {
            clientX: e.touches[0].clientX,
            clientY: e.touches[0].clientY,
            preventDefault: () => { },
            stopPropagation: () => { },
          },
          song
        );
      }
      touchLongPressTimer = null;
    }, 500);
  },
  { passive: true }
);

document.addEventListener(
  "touchend",
  () => {
    if (touchLongPressTimer) {
      clearTimeout(touchLongPressTimer);
      touchLongPressTimer = null;
    }
    touchLongPressTarget = null;
  },
  { passive: true }
);

document.addEventListener(
  "touchmove",
  () => {
    if (touchLongPressTimer) {
      clearTimeout(touchLongPressTimer);
      touchLongPressTimer = null;
    }
    touchLongPressTarget = null;
  },
  { passive: true }
);

let touchStartX = 0;
let touchStartY = 0;
let touchStartTime = 0;

document.addEventListener(
  "touchstart",
  (e) => {
    if (e.target.closest(".list-item, .song-card, .list-item-wrap")) return;
    if (
      e.target.closest(".player-deck") ||
      e.target.closest(".lyrics-container") ||
      e.target.closest(".content-area")
    ) {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchStartTime = Date.now();
    }
  },
  { passive: true }
);

document.addEventListener(
  "touchend",
  (e) => {
    if (!touchStartX || !touchStartTime) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    const dt = Date.now() - touchStartTime;
    if (dt > 300 || Math.abs(dy) > Math.abs(dx) * 2) {
      touchStartX = 0;
      touchStartY = 0;
      touchStartTime = 0;
      return;
    }
    if (Math.abs(dx) > 60) {
      if (dx < 0) changeTrack(1);
      else changeTrack(-1);
    }
    touchStartX = 0;
    touchStartY = 0;
    touchStartTime = 0;
  },
  { passive: true }
);

let swipeItemStartX = 0;
let swipeItemTarget = null;
let swipeItemSlideEl = null;

document.addEventListener(
  "touchstart",
  (e) => {
    const wrap = e.target.closest(".list-item-wrap");
    const card = e.target.closest(".song-card");
    if (window.innerWidth > 768) return;
    if (e.target.closest(".dotted, .list-remove, .play-overlay, .ctrl-btn"))
      return;
    let slideEl;
    if (wrap) {
      slideEl = wrap.querySelector(".list-item");
    } else if (card) {
      slideEl = card;
    }
    if (!slideEl) return;
    swipeItemSlideEl = slideEl;
    swipeItemTarget = wrap || card;
    swipeItemStartX = e.touches[0].clientX;
    slideEl.classList.add("dragging");
  },
  { passive: false }
);

let swipeClickBlock = 0;

document.addEventListener(
  "touchmove",
  (e) => {
    if (!swipeItemSlideEl) return;
    const dx = e.touches[0].clientX - swipeItemStartX;
    if (dx > 5) {
      e.preventDefault();
      swipeClickBlock = Date.now();
    } else return;
    if (dx < 0) {
      swipeItemSlideEl.style.transform = "";
      return;
    }
    swipeItemSlideEl.style.transform = `translateX(${Math.min(dx, 120)}px)`;
  },
  { passive: false }
);

document.addEventListener(
  "touchend",
  (e) => {
    if (!swipeItemSlideEl) return;
    const dx = e.changedTouches[0].clientX - swipeItemStartX;
    if (dx > 5) swipeClickBlock = Date.now();
    const song = swipeItemSlideEl?._song;
    if (song && dx > 80) {
      addToQueue(song);
    }
    swipeItemSlideEl.style.transition = "transform 0.3s ease";
    swipeItemSlideEl.style.transform = "";
    setTimeout(() => {
      if (swipeItemSlideEl) {
        swipeItemSlideEl.style.transition = "";
        swipeItemSlideEl.classList.remove("dragging");
      }
    }, 310);
    setTimeout(() => {
      swipeClickBlock = 0;
    }, 1100);
    swipeItemSlideEl = null;
    swipeItemTarget = null;
    swipeItemStartX = 0;
  },
  { passive: true }
);

document.addEventListener(
  "touchcancel",
  () => {
    if (!swipeItemSlideEl) return;
    swipeItemSlideEl.style.transition = "transform 0.25s ease";
    swipeItemSlideEl.style.transform = "";
    setTimeout(() => {
      if (swipeItemSlideEl) {
        swipeItemSlideEl.style.transition = "";
        swipeItemSlideEl.classList.remove("dragging");
      }
    }, 260);
    swipeClickBlock = 0;
    swipeItemSlideEl = null;
    swipeItemTarget = null;
    swipeItemStartX = 0;
  },
  { passive: true }
);

document.addEventListener(
  "click",
  (e) => {
    if (swipeClickBlock && Date.now() - swipeClickBlock < 1000) {
      if (e.target.closest("#resultsGrid") || e.target.closest("#deckNowPlaying")) {
        e.stopPropagation();
        e.preventDefault();
      }
    }
  },
  { capture: true }
);

document.getElementById("authModalClose").addEventListener("click", hideAuthModal);
document.getElementById("authModal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) hideAuthModal();
});
document.querySelectorAll(".auth-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".auth-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("loginForm").style.display = tab.dataset.tab === "login" ? "" : "none";
    document.getElementById("signupForm").style.display = tab.dataset.tab === "signup" ? "" : "none";
    document.getElementById("loginError").textContent = "";
    document.getElementById("signupError").textContent = "";
  });
});
document.getElementById("loginForm").addEventListener("submit", (e) => {
  e.preventDefault();
  document.getElementById("loginError").textContent = "";
  document.getElementById("loginPass").blur();
  loginUser(document.getElementById("loginUser").value, document.getElementById("loginPass").value);
});
document.getElementById("signupForm").addEventListener("submit", (e) => {
  e.preventDefault();
  document.getElementById("signupError").textContent = "";
  signupUser(document.getElementById("signupUser").value, document.getElementById("signupPass").value);
});
document.getElementById("createPlClose").addEventListener("click", () => {
  document.getElementById("createPlaylistModal").style.display = "none";
});
document.getElementById("createPlaylistModal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) document.getElementById("createPlaylistModal").style.display = "none";
});
document.getElementById("createPlBtn").addEventListener("click", async () => {
  const name = document.getElementById("createPlName").value.trim();
  if (!name) return;
  try {
    await fetch("/playlists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, username: currentUser }),
    });
    document.getElementById("createPlaylistModal").style.display = "none";
    document.getElementById("createPlName").value = "";
    loadPlaylists(true);
  } catch {}
});

function renderCredits() {
  var container = document.getElementById("creditsList");
  if (!container) return;
  container.innerHTML =
    '<div class="credits-section">' +
    '<h2>Developers</h2>' +
    '<p><a href="https://zarcotech.dev" target="_blank">zarcotech</a> - main frontend development/backend</p>' +
    '<p><a href="https://dyamuh.dev" target="_blank">dyamuh</a> - main backend development/frontend</p>' +
    "</div>";
}

if (typeof audio !== 'undefined' && audio) {
  audio.addEventListener('play', () => {
    if (window.median?.audio) window.median.audio.setState({"state": "playing"});
    else if (window.gonative?.audio) window.gonative.audio.setState({"state": "playing"});
  });

  audio.addEventListener('pause', () => {
    if (window.median?.audio) window.median.audio.setState({"state": "paused"});
    else if (window.gonative?.audio) window.gonative.audio.setState({"state": "paused"});
  });
}
