/* SynTech Music — ฝั่งไคลเอนต์
   โฮสต์ = เครื่องที่มีเสียง (โหลด YouTube player จริง)
   เครื่องอื่น = รีโมท (ไม่โหลด player เลย จึงไม่มีเสียงซ้อนและไม่กินเน็ต) */
(() => {
  const $ = (id) => document.getElementById(id);

  let ws = null;
  let player = null;
  let playerReady = false;
  let ytApiReady = false;
  let wantPlayer = false;      // ต้องการ player แต่ YT API อาจยังไม่พร้อม
  let isHost = null;           // null = ยังไม่รู้บทบาท ต้องตั้ง UI ครั้งแรกให้ครบ
  let clientId = null;
  let state = null;            // snapshot ล่าสุดจากเซิร์ฟเวอร์
  let stateTs = 0;             // เวลาเซิร์ฟเวอร์ (ms) ที่ snapshot ถูกสร้าง
  let clockOffset = 0;         // serverNow ≈ Date.now() + clockOffset
  let blockedTicks = 0;        // นับรอบที่สั่งเล่นแล้วเบราว์เซอร์ไม่เล่นตาม
  let loadedVideoId = null;
  let roomCode = "";
  let myName = "";
  let leaving = false;         // กันไม่ให้ต่อใหม่ตอนกดออกจากห้องเอง
  let draggingVolume = false;  // ระหว่างลากแถบเสียง อย่าให้เซิร์ฟเวอร์ดึงกลับ
  let dragState = null;        // ระหว่างลากย้ายลำดับเพลงในคิว

  const DRIFT_LIMIT = 1.2;     // วินาที — เกินกว่านี้ถึงจะ seek แก้

  const serverNow = () => Date.now() + clockOffset;
  const currentTrack = () => (state ? state.queue[0] || null : null);   // คิวไหลจากหัวแถว

  function targetPosition() {
    if (!state) return 0;
    if (!state.playing) return state.position;
    return state.position + (serverNow() - stateTs) / 1000;
  }

  const fmt = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  };

  function errorText(code) {
    if (code === 101 || code === 150) {
      return "เจ้าของคลิปปิดการเล่นแบบฝัง — ข้ามให้แล้ว ต้องเลือกคลิปอื่นหรือเปิดใน YouTube เอง";
    }
    if (code === 100) return "คลิปนี้ถูกลบ เป็นส่วนตัว หรือถูกจำกัดพื้นที่ — ข้ามให้แล้ว";
    if (code === 5) return "เบราว์เซอร์นี้เล่นคลิปดังกล่าวไม่ได้ — ข้ามให้แล้ว";
    if (code === 2) return "ลิงก์คลิปไม่ถูกต้อง — ข้ามให้แล้ว";
    return "เล่นคลิปนี้ไม่ได้ (error " + code + ") — ข้ามให้แล้ว";
  }

  let volumeConfirmTimer = null;
  let volumeConfirmValue = null;
  let localVolume = null;      // ค่าที่เครื่องนี้เพิ่งสั่ง รอเซิร์ฟเวอร์ยืนยัน
  let localVolumeAt = 0;
  let localVolumeSeq = -1;     // ค่า volumeSeq ตอนที่เครื่องนี้สั่ง

  // ค่าที่ควรใช้จริง: ของที่เพิ่งลางเองมาก่อน ไม่ให้ sync รอบถัดไปดึงกลับค่าเก่า
  function wantedVolume() {
    if (localVolume !== null) return localVolume;
    return state ? state.volume : 70;
  }

  function reconcileVolume() {
    if (localVolume === null) return;
    // seq เดินหน้าแล้ว = มีคำสั่งใหม่ถูกบันทึก (ของเราเองหรือของเครื่องอื่น) ให้ค่าห้องเป็นใหญ่
    // ถ้า seq ยังเท่าเดิม แปลว่า state นี้เป็นภาพเก่าที่ยังไม่รู้จักคำสั่งเรา อย่าให้ดึงเสียงกลับ
    if (state.volumeSeq > localVolumeSeq || Date.now() - localVolumeAt > 3000) localVolume = null;
  }

  function applyVolume(value) {
    if (!playerReady || !player.setVolume) return;
    if (value <= 0) {
      // ที่ 0 ตัว player ถือว่าตัวเองอยู่ในสถานะ mute — ต้องปล่อยให้ mute ค้างไว้
      // ถ้าเผลอสั่ง unMute จะโดน YouTube คืนระดับเสียงเดิมที่จำไว้กลับมา เสียงจะโผล่เป็นจังหวะ
      player.setVolume(0);
      if (player.mute) player.mute();
    } else {
      // mute กับระดับเสียงเป็นของแยกกัน ถ้ายัง mute อยู่ setVolume จะตั้งค่าให้จริงแต่ไม่มีเสียงออก
      if (player.isMuted && player.isMuted()) player.unMute();
      player.setVolume(value);
    }
    reportVolume(value);

    // unMute อาจคืนค่าเสียงเดิมที่ YouTube จำไว้มาทับของเรา จึงต้องอ่านกลับมาตรวจแล้วตอกซ้ำ
    if (volumeConfirmTimer === null || volumeConfirmValue !== value) {
      clearTimeout(volumeConfirmTimer);
      volumeConfirmValue = value;
      volumeConfirmTimer = setTimeout(() => {
        volumeConfirmTimer = null;
        confirmVolume(value);
      }, 300);
    }
  }

  function confirmVolume(value) {
    if (!playerReady || !player.getVolume) return;
    if (volumeOff(value)) {
      player.setVolume(0);
      if (player.mute) player.mute();
    } else if (volumeWrong(value)) {
      if (player.isMuted && player.isMuted()) player.unMute();
      player.setVolume(value);       // ตอกย้ำอีกรอบหลังรู้ว่าไม่ตรง
    }
    reportVolume(value);
  }

  // ที่ 0 ต้องเงียบจริง (mute หรือระดับเสียงเป็น 0) ไม่ใช่แค่ค่าตรง
  function volumeOff(value) {
    if (value > 0) return false;
    const muted = !!(player.isMuted && player.isMuted());
    return !muted && Math.round(player.getVolume() || 0) > 0;
  }

  function volumeWrong(value) {
    if (value <= 0) return false;
    const muted = !!(player.isMuted && player.isMuted());
    return muted || Math.abs(Math.round(player.getVolume() || 0) - value) > 1;
  }

  function reportVolume(wanted) {
    const el = $("volActual");
    if (el) el.hidden = true;
  }

  // เติมสีรางแถบเสียงให้เห็นระดับที่เลือก (สภาพแวดล้อมทดสอบไม่มี setProperty จึงเช็คก่อน)
  function paintVolume(value) {
    const slider = $("volume");
    if (slider.style && slider.style.setProperty) {
      slider.style.setProperty("--fill", Math.max(0, Math.min(100, value)) + "%");
    }
  }

  // ลากแถบเสียงทีเดียวยิงได้เป็นสิบ event — รวบส่งเป็นชุดกัน broadcast ท่วม
  let volumeTimer = null;
  let volumePending = null;

  function sendVolume(value, flush) {
    volumePending = value;
    if (flush) {
      clearTimeout(volumeTimer);
      volumeTimer = null;
      send({ type: "setVolume", value: volumePending });
      return;
    }
    if (volumeTimer) return;
    volumeTimer = setTimeout(() => {
      volumeTimer = null;
      send({ type: "setVolume", value: volumePending });
    }, 150);
  }

  let rejectedUrl = null;

  function showAddNotice(message, url) {
    rejectedUrl = url;
    $("addNoticeText").textContent = message;
    $("addNotice").hidden = false;
  }

  function hideAddNotice() {
    rejectedUrl = null;
    $("addNotice").hidden = true;
  }

  const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

  function looksLikeLink(text) {
    const lower = text.toLowerCase();
    if (lower.indexOf("http://") === 0 || lower.indexOf("https://") === 0) return true;
    if (lower.includes("youtube.com") || lower.includes("youtu.be")) return true;
    if (lower.includes("list=")) return true;
    // อาจเป็น videoId ล้วน ๆ 11 ตัว
    return text.length === 11 && [...text].every((ch) => ID_CHARS.includes(ch));
  }

  let searchAbortController = null;

  async function doSearch(query) {
    if (searchAbortController) {
      searchAbortController.abort();
    }
    searchAbortController = new AbortController();

    $("searchPanel").hidden = false;
    $("searchTitle").textContent = "กำลังค้นหา “" + query + "” …";
    $("searchResults").innerHTML = "";
    let data;
    try {
      const resp = await fetch("/api/search?q=" + encodeURIComponent(query), {
        signal: searchAbortController.signal
      });
      data = await resp.json();
    } catch (err) {
      if (err.name === "AbortError") return;
      $("searchTitle").textContent = "ค้นหาไม่สำเร็จ ลองอีกครั้ง";
      return;
    }
    if (!data.results || !data.results.length) {
      $("searchResults").innerHTML = "";
      $("searchTitle").textContent = data.message || "ไม่พบผลค้นหา";
      return;
    }
    showResults("ผลค้นหา “" + query + "” — กดเพิ่มเข้าคิวได้เลย", data.results);
  }

  function showResults(headline, results) {
    $("searchPanel").hidden = false;
    $("searchTitle").textContent = headline;
    const list = $("searchResults");
    list.innerHTML = "";
    results.forEach((item) => {
      const li = document.createElement("li");

      const art = document.createElement("img");
      art.src = "https://i.ytimg.com/vi/" + item.videoId + "/default.jpg";
      art.alt = "";

      const text = document.createElement("span");
      text.className = "t";
      const title = document.createElement("span");
      title.className = "title";
      title.textContent = item.title;
      const meta = document.createElement("small");
      meta.className = "meta";
      meta.textContent = item.length + (item.channel ? " · " + item.channel : "");
      text.append(title, meta);

      const button = document.createElement("button");
      button.className = "ghost small";
      button.dataset.vid = item.videoId;
      button.textContent = "+ เพิ่ม";

      li.append(art, text, button);
      list.appendChild(li);
    });
  }

  let toastTimer = null;

  function toast(msg, duration = 4500) {
    const el = $("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastTimer = null;
      el.classList.remove("show");
    }, duration);
  }

  // ---------- YouTube player (สร้างเฉพาะเครื่องโฮสต์) ----------
  function checkYtApiReady() {
    if (window.YT && window.YT.Player) {
      ytApiReady = true;
      if (wantPlayer && !player) createPlayer();
    }
  }

  // ดักทั้งกรณีที่ API โหลดเสร็จจากแคชก่อนที่ app.js จะรัน
  if (typeof YT !== "undefined" && YT && YT.Player) {
    ytApiReady = true;
  }
  window.onYouTubeIframeAPIReady = () => {
    ytApiReady = true;
    if (wantPlayer) createPlayer();
  };

  function createPlayer() {
    if (!ytApiReady && typeof YT !== "undefined" && YT && YT.Player) {
      ytApiReady = true;
    }
    if (player || !ytApiReady) return;
    const stage = $("playerStage");
    if (!stage) return;
    let mount = $("ytMount");
    if (!mount) {
      mount = document.createElement("div");
      mount.id = "ytMount";
      stage.appendChild(mount);
    }
    player = new YT.Player(mount, {
      height: "100%",
      width: "100%",
      playerVars: {
        autoplay: 1,
        controls: 0,
        disablekb: 1,
        enablejsapi: 1,
        modestbranding: 1,
        rel: 0,
        playsinline: 1,
        cc_load_policy: 0,
        iv_load_policy: 3,
      },
      events: {
        onReady: () => {
          playerReady = true;
          if (state) applyVolume(wantedVolume());
          sync();
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.PLAYING) {
            if (state) applyVolume(wantedVolume());
            // ปิดคำบรรยาย/ซับไตเติลให้อัตโนมัติโดยไม่ทำให้ตัวเล่นค้าง
            try {
              if (player && player.setOption) {
                player.setOption("captions", "track", {});
                player.setOption("cc", "track", {});
              }
            } catch (_) {}
            try {
              if (player && player.unloadModule) {
                player.unloadModule("captions");
              }
            } catch (_) {}
          }
          if (e.data === YT.PlayerState.ENDED) {
            const track = currentTrack();
            if (track) send({ type: "ended", videoId: track.videoId });
          }
        },
        onError: (e) => {
          toast(errorText(e.data));
          const track = currentTrack();
          if (track) send({ type: "trackError", videoId: track.videoId, code: e.data });
        },
      },
    });
  }

  function destroyPlayer() {
    wantPlayer = false;
    if (player) {
      try { player.destroy(); } catch (_) { }
    }
    player = null;
    playerReady = false;
    loadedVideoId = null;
    blockedTicks = 0;
    const mount = $("ytMount");
    if (mount) mount.remove();
    if ($("unblockBtn")) $("unblockBtn").hidden = true;
    if ($("unblockModal")) $("unblockModal").hidden = true;
  }

  function applyRole() {
    const nowHost = state.hostId === clientId;
    if (nowHost === isHost) return;
    const firstTime = isHost === null;
    isHost = nowHost;
    const remoteOverlay = $("remoteOverlay");
    if (remoteOverlay) remoteOverlay.hidden = isHost;
    const claimBtn = $("claimBtn");
    if (claimBtn) claimBtn.hidden = isHost;
    if (isHost) {
      wantPlayer = true;
      createPlayer();
      if (!firstTime) toast("เครื่องนี้เป็นลำโพงของห้องแล้ว");
    } else {
      destroyPlayer();
      if (!firstTime) toast("ลำโพงย้ายไปเครื่องอื่นแล้ว เครื่องนี้เป็นรีโมท");
    }
  }

  // ---------- WebSocket ----------
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(proto + "://" + location.host + "/ws/" + roomCode);

    ws.onopen = () => {
      badge("เชื่อมต่อแล้ว", "ok");
      send({ type: "hello", name: myName });
      measureClock();
    };
    ws.onclose = () => {
      if (leaving) return;
      badge("หลุดการเชื่อมต่อ — กำลังต่อใหม่…", "warn");
      setTimeout(() => { if (!leaving) connect(); }, 1500);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "welcome") {
        clientId = msg.clientId;
      } else if (msg.type === "pong") {
        const rtt = Date.now() - msg.t0;
        clockOffset = msg.ts + rtt / 2 - Date.now();
      } else if (msg.type === "state") {
        stateTs = msg.ts;
        state = msg.room;
        reconcileVolume();
        applyRole();
        render();
        sync();
      } else if (msg.type === "error" || msg.type === "notice") {
        toast(msg.message);
      } else if (msg.type === "addRejected") {
        showAddNotice(msg.message, msg.url);
      } else if (msg.type === "altResults") {
        showResults("“" + msg.blockedTitle + "” ฝังไม่ได้ — เวอร์ชันเพลงเดียวกันที่เล่นได้",
          msg.results);
      }
    };
  }

  function send(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  function measureClock() {
    send({ type: "ping", t0: Date.now() });
  }

  function badge(text, kind) {
    const el = $("syncBadge") || $("roleBadge");
    if (!el) return;
    el.textContent = text;
    el.className = "badge " + (kind || "");
  }

  // ---------- ตัวซิงก์ (ทำงานเฉพาะเครื่องโฮสต์) ----------
  function sync() {
    if (!isHost || !state) return;
    if (!player || !playerReady) {
      if (wantPlayer) {
        if (!ytApiReady && typeof YT !== "undefined" && YT && YT.Player) ytApiReady = true;
        if (ytApiReady && !player) createPlayer();
      }
      return;
    }
    const track = currentTrack();

    if (!track) {
      if (loadedVideoId) { player.stopVideo(); loadedVideoId = null; }
      return;
    }

    applyVolume(wantedVolume());
    const target = targetPosition();

    if (loadedVideoId !== track.videoId) {
      loadedVideoId = track.videoId;
      player.loadVideoById({ videoId: track.videoId, startSeconds: target });
      setTimeout(() => { if (state) applyVolume(wantedVolume()); }, 800);
      return;
    }

    // รายงานความยาวเพลงให้เครื่องรีโมทใช้วาดแถบเวลา
    const duration = player.getDuration() || 0;
    if (duration && Math.abs((track.duration || 0) - duration) > 1) {
      send({ type: "duration", videoId: track.videoId, seconds: duration });
    }

    const actual = player.getCurrentTime() || 0;
    if (Math.abs(actual - target) > DRIFT_LIMIT) player.seekTo(target, true);

    const ps = player.getPlayerState();
    if (state.playing && ps !== YT.PlayerState.PLAYING && ps !== YT.PlayerState.BUFFERING) {
      player.playVideo();
      // สั่งเล่นแล้วยังไม่ขยับ = เบราว์เซอร์บล็อกเสียงอยู่ แสดง popup แจ้งเตือนทันที
      if (++blockedTicks >= 1) {
        if ($("unblockModal")) $("unblockModal").hidden = false;
        if ($("unblockBtn")) $("unblockBtn").hidden = false;
      }
    } else {
      blockedTicks = 0;
      if ($("unblockModal")) $("unblockModal").hidden = true;
      if ($("unblockBtn")) $("unblockBtn").hidden = true;
    }
    if (!state.playing && ps === YT.PlayerState.PLAYING) player.pauseVideo();
  }

  // ---------- UI ในห้อง ----------
  function render() {
    if (!state) return;
    const track = currentTrack();

    $("nowTitle").textContent = track ? track.title : "ยังไม่มีเพลงในคิว";
    const link = $("ytLink");
    link.hidden = !track;
    if (track) link.href = "https://www.youtube.com/watch?v=" + track.videoId;
    $("playBtn").textContent = state.playing ? "⏸" : "▶";
    $("queueCount").textContent = "(" + state.queue.length + ")";
    $("listenerCount").textContent = "(" + state.listeners.length + ")";
    const canControl = isHost || state.openControl;
    $("shuffleBtn").disabled = !canControl || state.queue.length <= 1;
    $("clearQueueBtn").disabled = !canControl || state.queue.length === 0;
    $("roleBadge").textContent = isHost ? "🔊 เครื่องนี้คือลำโพง" : "🎛 รีโมท (ไม่มีเสียง)";
    $("roleBadge").className = "badge " + (isHost ? "ok" : "");

    const host = state.listeners.find((l) => l.host);
    $("remoteWho").textContent = host
      ? "เสียงออกที่เครื่องของ " + host.name
      : "ยังไม่มีเครื่องไหนเป็นลำโพง";
    const art = track ? "https://i.ytimg.com/vi/" + track.videoId + "/mqdefault.jpg" : "";
    $("remoteArt").src = art;
    $("remoteArt").hidden = !track;
    $("app").classList[state.playing && track ? "add" : "remove"]("is-playing");

    const vol = wantedVolume();
    const muteBtn = $("muteBtn");
    if (muteBtn) {
      muteBtn.textContent = vol === 0 ? "🔇" : "🔊";
      muteBtn.classList[vol === 0 ? "add" : "remove"]("is-muted");
    }

    const rMode = state.repeatMode || "off";
    const rBtn = $("repeatBtn");
    if (rBtn) {
      if (rMode === "one") {
        rBtn.textContent = "🔂 วนซ้ำเพลงนี้";
        rBtn.className = "ghost small is-repeat-one";
      } else if (rMode === "all") {
        rBtn.textContent = "🔁 วนซ้ำคิว";
        rBtn.className = "ghost small is-repeat-all";
      } else {
        rBtn.textContent = "➡️ ไม่ซ้ำ";
        rBtn.className = "ghost small";
      }
      rBtn.disabled = !canControl;
    }

    const autoDjBtn = $("autoDjBtn");
    if (autoDjBtn) {
      autoDjBtn.textContent = state.autoDj ? "🤖 Auto DJ: เปิด" : "🤖 Auto DJ: ปิด";
      autoDjBtn.className = state.autoDj ? "ghost small active" : "ghost small";
      autoDjBtn.disabled = !canControl;
    }

    if (!draggingVolume) {
      const shown = wantedVolume();
      $("volume").value = shown;
      $("volLabel").textContent = shown;
      paintVolume(shown);
    }

    $("openControl").checked = state.openControl;
    $("openControl").disabled = !isHost;

    // ระหว่างลากอยู่ ห้ามวาดคิวใหม่ ไม่งั้น DOM ที่กำลังลากหายกลางทาง
    if (!dragState) renderQueue();
    renderHistory();
    if ($("statsModal") && !$("statsModal").hidden) renderStats();

    const listeners = $("listeners");
    listeners.innerHTML = "";
    state.listeners.forEach((l) => {
      const li = document.createElement("li");
      li.textContent = (l.host ? "🔊 " : "🎛 ") + l.name + (l.id === clientId ? " (คุณ)" : "");
      listeners.appendChild(li);
    });
  }

  function renderQueue() {
    const queue = $("queue");
    queue.innerHTML = "";
    state.queue.forEach((t, i) => {
      const li = document.createElement("li");
      li.className = i === 0 ? "current" : "";
      li.dataset.id = t.id;
      li.dataset.index = i;

      const grip = document.createElement("span");
      grip.className = "grip";
      grip.title = "ลากเพื่อย้ายลำดับ";
      grip.textContent = "≡";
      grip.dataset.id = t.id;
      grip.dataset.index = i;

      const mark = document.createElement("span");
      mark.className = "mark";
      mark.textContent = i === 0 ? "♪" : String(i);

      const text = document.createElement("span");
      text.className = "t";
      const title = document.createElement("span");
      title.className = "title";
      title.textContent = t.title;
      const by = document.createElement("small");
      by.className = "by";
      by.textContent = "เพิ่มโดย " + t.addedBy + (t.duration ? " · " + fmt(t.duration) : "");
      text.append(title, by);

      const actions = document.createElement("span");
      actions.className = "acts";
      if (i > 0) actions.appendChild(rowButton("now", t.id, "▶", "เล่นเพลงนี้เลย"));
      actions.appendChild(rowButton("del", t.id, "✕", "เอาออกจากคิว"));

      li.append(grip, mark, text, actions);
      queue.appendChild(li);
    });
  }

  function rowButton(act, id, label, title) {
    const button = document.createElement("button");
    button.className = "ghost small";
    button.dataset.act = act;
    button.dataset.id = id;
    button.title = title;
    button.textContent = label;
    return button;
  }

  function renderHistory() {
    const list = $("historyList");
    if (!list || !state) return;
    const history = state.history || [];
    $("historyCount").textContent = "(" + history.length + ")";
    list.innerHTML = "";
    if (!history.length) return;
    history.forEach((t) => {
      const li = document.createElement("li");
      const title = document.createElement("span");
      title.className = "title";
      title.textContent = t.title;

      const btn = document.createElement("button");
      btn.className = "ghost small";
      btn.textContent = "+ เล่นอีกครั้ง";
      btn.addEventListener("click", () => {
        send({ type: "add", url: t.videoId });
        toast("เพิ่ม “" + t.title + "” เข้าคิวอีกครั้งแล้ว");
      });

      li.append(title, btn);
      list.appendChild(li);
    });
  }

  function renderStats() {
    if (!state) return;
    const djStats = state.djStats || {};
    const totalPlayed = state.totalPlayed || 0;
    if ($("statTotalSongs")) $("statTotalSongs").textContent = totalPlayed;

    let totalDuration = 0;
    let topDj = "-";
    let topSongs = 0;

    const entries = Object.entries(djStats);
    entries.forEach(([name, data]) => {
      totalDuration += data.duration || 0;
      if ((data.songs || 0) > topSongs) {
        topSongs = data.songs;
        topDj = name;
      }
    });

    const mins = Math.round(totalDuration / 60);
    const hrs = (totalDuration / 3600).toFixed(1);
    if ($("statTotalTime")) {
      $("statTotalTime").textContent = totalDuration >= 3600 ? hrs + " ชม." : mins + " นาที";
    }
    if ($("statTopDj")) $("statTopDj").textContent = topDj;

    // จัดอันดับ Leaderboard
    entries.sort((a, b) => (b[1].songs || 0) - (a[1].songs || 0));
    const list = $("leaderboardList");
    if (!list) return;
    list.innerHTML = "";

    if (!entries.length) {
      const li = document.createElement("li");
      li.className = "muted tiny";
      li.style.textAlign = "center";
      li.style.padding = "1rem";
      li.textContent = "ยังไม่มีสถิติ DJ ในห้องนี้";
      list.appendChild(li);
      return;
    }

    entries.forEach(([name, data], idx) => {
      const li = document.createElement("li");
      li.className = "leaderboard-item rank-" + (idx + 1);

      const left = document.createElement("div");
      left.className = "dj-rank-name";
      const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : "#" + (idx + 1);
      const badge = document.createElement("span");
      badge.className = "dj-badge";
      badge.textContent = medal;
      const djName = document.createElement("span");
      djName.textContent = name;
      left.append(badge, djName);

      const right = document.createElement("div");
      right.className = "dj-stats-info";
      const songsCount = document.createElement("span");
      songsCount.textContent = (data.songs || 0) + " เพลง";
      const durText = document.createElement("span");
      durText.className = "mono tiny";
      durText.textContent = fmt(data.duration || 0);
      right.append(songsCount, durText);

      li.append(left, right);
      list.appendChild(li);
    });
  }

  let lastTimeText = "";
  let lastProgressPct = -1;

  function tick() {
    if (!state) return;
    const track = currentTrack();
    const duration = isHost && playerReady
      ? player.getDuration() || 0
      : (track && track.duration) || 0;
    const pos = duration ? Math.min(targetPosition(), duration) : targetPosition();
    const timeText = fmt(pos) + " / " + fmt(duration);
    if (timeText !== lastTimeText) {
      $("timeLabel").textContent = timeText;
      lastTimeText = timeText;
    }
    const pct = duration ? Math.min(100, Math.round((pos / duration) * 1000) / 10) : 0;
    if (pct !== lastProgressPct) {
      $("progress").style.width = pct + "%";
      lastProgressPct = pct;
    }
  }

  // ---------- หน้าเลือกห้อง ----------
  let roomsTimer = null;

  async function loadRooms() {
    try {
      const data = await (await fetch("/api/rooms")).json();
      const list = $("roomList");
      list.innerHTML = "";
      if (!data.rooms.length) {
        $("roomsHint").textContent = "ยังไม่มีห้องเปิดอยู่";
        return;
      }
      $("roomsHint").textContent = data.rooms.length + " ห้อง";
      data.rooms.forEach((r) => {
        const card = document.createElement("button");
        card.className = "room-card";
        card.dataset.code = r.code;

        const top = document.createElement("div");
        top.className = "room-top";
        const code = document.createElement("strong");
        code.textContent = r.code;
        const who = document.createElement("small");
        who.textContent = (r.playing ? "▶ " : "⏸ ") + r.listeners + " เครื่อง"
          + (r.hostName ? " · ลำโพง: " + r.hostName : "");
        top.append(code, who);

        const now = document.createElement("small");
        now.className = "room-now";
        now.textContent = r.nowPlaying || "ยังไม่มีเพลงในคิว";

        card.append(top, now);
        list.appendChild(card);
      });
    } catch (_) {
      $("roomsHint").textContent = "ต่อเซิร์ฟเวอร์ไม่ได้";
    }
  }

  function startRoomPolling() {
    loadRooms();
    if (!roomsTimer) roomsTimer = setInterval(loadRooms, 3000);
  }

  function stopRoomPolling() {
    clearInterval(roomsTimer);
    roomsTimer = null;
  }

  function joinRoom(code) {
    myName = ($("nameInput").value || "").trim() || "ผู้ฟัง";
    localStorage.setItem("syntech.name", myName);
    roomCode = code.toUpperCase();
    leaving = false;
    stopRoomPolling();
    history.replaceState(null, "", "#" + roomCode);
    $("roomCode").textContent = roomCode;
    $("gate").hidden = true;
    $("app").hidden = false;
    badge("กำลังเชื่อมต่อ…", "");
    connect();
  }

  function leaveRoom() {
    leaving = true;
    if (ws) ws.close();
    ws = null;
    destroyPlayer();
    isHost = null;
    state = null;
    clientId = null;
    history.replaceState(null, "", location.pathname);
    $("app").hidden = true;
    $("gate").hidden = false;
    startRoomPolling();
  }

  function on(id, evt, fn) {
    const el = $(id);
    if (el) el.addEventListener(evt, fn);
  }

  // ---------- events ----------
  on("roomList", "click", (e) => {
    const card = e.target.closest(".room-card");
    if (card) joinRoom(card.dataset.code);
  });

  on("newRoomBtn", "click", async () => {
    const data = await (await fetch("/api/new-room")).json();
    joinRoom(data.code);
  });

  on("leaveBtn", "click", leaveRoom);
  on("addAnywayBtn", "click", () => {
    if (rejectedUrl) send({ type: "add", url: rejectedUrl, force: true });
    hideAddNotice();
  });
  on("dismissNoticeBtn", "click", hideAddNotice);
  on("claimBtn", "click", () => send({ type: "claimHost" }));

  on("copyLinkBtn", "click", async () => {
    try {
      await navigator.clipboard.writeText(location.origin + "/#" + roomCode);
      toast("คัดลอกลิงก์ห้องแล้ว ส่งให้เพื่อนได้เลย");
    } catch (_) {
      toast("คัดลอกไม่ได้ ใช้รหัสห้อง " + roomCode + " แทนได้");
    }
  });

  on("statsBtn", "click", () => {
    const modal = $("statsModal");
    if (modal) {
      modal.hidden = false;
      renderStats();
    }
  });
  on("closeStatsBtn", "click", () => {
    const modal = $("statsModal");
    if (modal) modal.hidden = true;
  });
  on("statsModal", "click", (e) => {
    if (e.target === $("statsModal")) $("statsModal").hidden = true;
  });

  on("autoDjBtn", "click", () => {
    if (state) send({ type: "setAutoDj", value: !state.autoDj });
  });

  on("playBtn", "click", () => {
    if (playerReady && wantedVolume() > 0 && player.isMuted && player.isMuted()) player.unMute();
    send({ type: state && state.playing ? "pause" : "play" });
  });
  on("nextBtn", "click", () => send({ type: "next" }));
  on("prevBtn", "click", () => send({ type: "seek", position: 0 }));
  on("shuffleBtn", "click", () => send({ type: "shuffle" }));
  on("repeatBtn", "click", () => {
    if (!state) return;
    const cur = state.repeatMode || "off";
    const next = cur === "off" ? "all" : (cur === "all" ? "one" : "off");
    send({ type: "setRepeatMode", mode: next });
  });
  on("clearQueueBtn", "click", () => {
    if (!state || !state.queue || state.queue.length === 0) return;
    if (confirm("คุณต้องการล้างคิวเพลงทั้งหมดในห้องนี้ใช่หรือไม่?")) {
      send({ type: "clearQueue" });
    }
  });

  let lastNonZeroVolume = 70;
  function toggleMute() {
    const cur = wantedVolume();
    if (cur > 0) {
      lastNonZeroVolume = cur;
      applyVolume(0);
      sendVolume(0, true);
    } else {
      const restore = lastNonZeroVolume || 70;
      applyVolume(restore);
      sendVolume(restore, true);
    }
  }

  on("muteBtn", "click", toggleMute);

  on("toggleHistoryBtn", "click", () => {
    const list = $("historyList");
    if (list) list.hidden = !list.hidden;
  });

  let liveSearchTimer = null;
  $("urlInput").addEventListener("input", (e) => {
    const text = e.target.value.trim();
    clearTimeout(liveSearchTimer);
    if (!text) {
      if (searchAbortController) searchAbortController.abort();
      $("searchPanel").hidden = true;
      return;
    }
    if (looksLikeLink(text)) return;
    if (text.length >= 3) {
      liveSearchTimer = setTimeout(() => {
        doSearch(text);
      }, 550);
    }
  });

  $("addForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("urlInput").value.trim();
    if (!text) return;
    hideAddNotice();
    if (looksLikeLink(text)) {
      send({ type: "add", url: text });
      $("urlInput").value = "";
      $("searchPanel").hidden = true;
    } else {
      doSearch(text);
    }
  });

  $("searchResults").addEventListener("click", (e) => {
    const button = e.target.closest("button[data-vid]");
    if (!button || button.disabled) return;
    send({ type: "add", url: button.dataset.vid });
    button.textContent = "เพิ่มแล้ว";
    button.disabled = true;
  });

  $("closeSearchBtn").addEventListener("click", () => {
    $("searchPanel").hidden = true;
    $("searchResults").innerHTML = "";
  });

  // ---------- ลากย้ายลำดับในคิว (ใช้ pointer event จึงลากได้ทั้งเมาส์และนิ้ว) ----------
  function queueRows() {
    return [...$("queue").children];
  }

  function dropSlotFor(clientY) {
    const rows = queueRows();
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return rows.length;
  }

  function markDropSlot(slot) {
    const rows = queueRows();
    rows.forEach((row, i) => {
      if (i === slot) row.classList.add("drop-before");
      else row.classList.remove("drop-before");
      // ปล่อยใต้แถวสุดท้าย ต้องมีเส้นให้เห็นเหมือนกัน
      if (slot === rows.length && i === rows.length - 1) row.classList.add("drop-after");
      else row.classList.remove("drop-after");
    });
  }

  function autoScrollQueue(clientY) {
    const list = $("queue");
    const rect = list.getBoundingClientRect();
    if (clientY < rect.top + 28) list.scrollTop = (list.scrollTop || 0) - 14;
    else if (clientY > rect.bottom - 28) list.scrollTop = (list.scrollTop || 0) + 14;
  }

  function endDrag(commit) {
    if (!dragState) return;
    const from = dragState.from;
    const slot = dragState.slot;
    const id = dragState.id;
    dragState = null;
    markDropSlot(-1);
    queueRows().forEach((row) => row.classList.remove("dragging"));

    if (!commit) { render(); return; }
    // slot คือ "แทรกก่อนแถวที่ slot" ต้องหักหนึ่งถ้าย้ายลงข้างล่าง เพราะตัวเองถูกดึงออกก่อน
    let target = slot > from ? slot - 1 : slot;
    target = Math.max(1, target);   // ไม่ให้แทรกทับเพลงที่กำลังเล่น (ใช้ปุ่ม ▶ แทน)
    if (target === from) { render(); return; }
    send({ type: "move", id: id, to: target });
  }

  $("queue").addEventListener("pointerdown", (e) => {
    const grip = e.target.closest && e.target.closest(".grip");
    if (!grip) return;
    if (e.preventDefault) e.preventDefault();
    dragState = { id: grip.dataset.id, from: Number(grip.dataset.index), slot: Number(grip.dataset.index) };
    const row = queueRows()[dragState.from];
    if (row) row.classList.add("dragging");
    if (grip.setPointerCapture && e.pointerId !== undefined) grip.setPointerCapture(e.pointerId);
  });

  $("queue").addEventListener("pointermove", (e) => {
    if (!dragState) return;
    if (e.preventDefault) e.preventDefault();
    autoScrollQueue(e.clientY);
    dragState.slot = dropSlotFor(e.clientY);
    markDropSlot(dragState.slot);
  });

  $("queue").addEventListener("pointerup", () => endDrag(true));
  $("queue").addEventListener("pointercancel", () => endDrag(false));
  // เผื่อปล่อยนิ้ว/เมาส์นอกลิสต์ ไม่ให้สถานะลากค้างจนคิวไม่อัปเดตอีกเลย
  document.addEventListener("pointerup", () => endDrag(true));

  $("queue").addEventListener("click", (e) => {
    const button = e.target.closest("button[data-act]");
    if (!button) return;
    const id = button.dataset.id;
    if (button.dataset.act === "now") send({ type: "move", id: id, to: 0 });
    else if (button.dataset.act === "next") send({ type: "move", id: id, to: 1 });
    else if (button.dataset.act === "del") send({ type: "remove", id: id });
  });

  $("openControl").addEventListener("change", (e) => {
    send({ type: "setOpenControl", value: e.target.checked });
  });

  // แถบเสียงคุมลำโพงของโฮสต์ ปรับจากเครื่องไหนก็ได้
  $("volume").addEventListener("pointerdown", () => { draggingVolume = true; });
  $("volume").addEventListener("input", (e) => {
    draggingVolume = true;
    const value = Number(e.target.value);
    localVolume = value;
    localVolumeAt = Date.now();
    if (state) localVolumeSeq = state.volumeSeq;
    $("volLabel").textContent = value;
    paintVolume(value);
    applyVolume(value);        // เครื่องโฮสต์ได้ยินผลทันที ไม่ต้องรอเซิร์ฟเวอร์ตอบ
    sendVolume(value, false);
  });
  $("volume").addEventListener("change", (e) => {
    draggingVolume = false;
    const value = Number(e.target.value);
    localVolume = value;
    localVolumeAt = Date.now();
    if (state) localVolumeSeq = state.volumeSeq;
    sendVolume(value, true);   // ค่าสุดท้ายส่งทันที ไม่ตกหล่น
  });

  function unlockAudio() {
    blockedTicks = 0;
    if ($("unblockBtn")) $("unblockBtn").hidden = true;
    if ($("unblockModal")) $("unblockModal").hidden = true;
    if (isHost && player && playerReady) {
      applyVolume(wantedVolume());
      if (player.isMuted && player.isMuted()) player.unMute();
      player.playVideo();
    }
  }

  on("unblockBtn", "click", unlockAudio);
  on("unblockModalBtn", "click", unlockAudio);
  on("unblockModal", "click", unlockAudio);

  // ปลดบล็อกเสียงอัตโนมัติทันทีที่ผู้ใช้สัมผัสหรือคลิกตรงไหนก็ได้บนหน้าจอ (User Gesture Auto-unlock)
  document.addEventListener("pointerdown", () => {
    if (isHost && player && playerReady) {
      if (blockedTicks > 0 || ($("unblockModal") && !$("unblockModal").hidden)) {
        unlockAudio();
      } else {
        const ps = (player.getPlayerState && player.getPlayerState()) ?? -1;
        if (state && state.playing && ps !== YT.PlayerState.PLAYING && ps !== YT.PlayerState.BUFFERING) {
          unlockAudio();
        }
      }
    }
  }, { passive: true });

  // คลิกบนแถบเวลาเพื่อ seek — ส่งขึ้นเซิร์ฟเวอร์ให้ทุกเครื่องกระโดดตาม
  document.querySelector(".bar").addEventListener("click", (e) => {
    const track = currentTrack();
    const duration = isHost && playerReady
      ? player.getDuration() || 0
      : (track && track.duration) || 0;
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    send({ type: "seek", position: ((e.clientX - rect.left) / rect.width) * duration });
  });

  // ---------- คีย์บอร์ดลัด (Keyboard Shortcuts) ----------
  document.addEventListener("keydown", (e) => {
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    const key = e.key;
    if (key === " " || key === "k" || key === "K") {
      e.preventDefault();
      $("playBtn").click();
    } else if (key === "m" || key === "M") {
      e.preventDefault();
      toggleMute();
    } else if (key === "n" || key === "N") {
      e.preventDefault();
      $("nextBtn").click();
    } else if (key === "r" || key === "R") {
      e.preventDefault();
      $("repeatBtn").click();
    } else if (key === "s" || key === "S") {
      e.preventDefault();
      $("shuffleBtn").click();
    } else if (key === "ArrowUp") {
      e.preventDefault();
      const newVol = Math.min(100, wantedVolume() + 5);
      applyVolume(newVol);
      sendVolume(newVol, true);
    } else if (key === "ArrowDown") {
      e.preventDefault();
      const newVol = Math.max(0, wantedVolume() - 5);
      applyVolume(newVol);
      sendVolume(newVol, true);
    }
  });

  // ---------- init ----------
  $("nameInput").value = localStorage.getItem("syntech.name") || localStorage.getItem("synhub.name") || "";
  setInterval(sync, 2000);          // แก้ drift ทุก 2 วินาที
  setInterval(tick, 250);           // อัปเดตแถบเวลา
  setInterval(measureClock, 15000); // ปรับนาฬิกาให้ตรงกับเซิร์ฟเวอร์

  if (location.hash.length > 1) {
    joinRoom(location.hash.slice(1));   // เปิดจากลิงก์ที่เพื่อนส่งมา = เข้าห้องเลย
  } else {
    startRoomPolling();
  }
})();
