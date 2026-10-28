/* SynTech Music — ฝั่งไคลเอนต์
   โฮสต์ = เครื่องที่มีเสียง (โหลด YouTube player จริง)
   เครื่องอื่น = รีโมท (ไม่โหลด player เลย จึงไม่มีเสียงซ้อนและไม่กินเน็ต) */
(() => {
  const $ = (id) => document.getElementById(id);

  /* ไอคอนลำโพงของปุ่ม mute — วาดเป็น SVG เส้นเดียวกับไอคอนอื่นในหน้า
     .wave กับ .slash ถูกสลับซ่อน/โชว์ด้วยคลาส .is-muted ใน CSS */
  const MUTE_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"' +
    ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M11 5 6 9H3v6h3l5 4z"/>' +
    '<path class="wave" d="M15.4 9.6a3.4 3.4 0 0 1 0 4.8"/>' +
    '<path class="wave" d="M18 7a7 7 0 0 1 0 10"/>' +
    '<path class="slash" d="M16 9.5l5 5m0-5l-5 5"/>' +
    '</svg>';

  let ws = null;
  let player = null;
  let playerReady = false;
  let ytApiReady = false;
  let wantPlayer = false;      // ต้องการ player แต่ YT API อาจยังไม่พร้อม
  let isHost = false;          // โฮสต์ = เจ้าของสิทธิ์ตั้งค่าห้อง (ไม่จำเป็นต้องเป็นลำโพง)
  let isSpeaker = null;        // เครื่องนี้เปิดเสียงเพลงอยู่ไหม — null = ยังไม่รู้ ต้องตั้ง UI ครั้งแรกให้ครบ
  let wantSelfSpeaker = false; // โหมดเลือกบางเครื่อง: ต่อใหม่แล้วขอเป็นลำโพงต่อ เพราะ id เครื่องเปลี่ยนทุกครั้งที่ต่อ
  let clientId = null;
  let state = null;            // snapshot ล่าสุดจากเซิร์ฟเวอร์
  let stateTs = 0;             // เวลาเซิร์ฟเวอร์ (ms) ที่ snapshot ถูกสร้าง
  let clockOffset = 0;         // serverNow ≈ Date.now() + clockOffset
  let blockedTicks = 0;        // นับรอบที่สั่งเล่นแล้วเบราว์เซอร์ไม่เล่นตาม
  let selfActionAt = 0;        // เวลาที่ "เรา" สั่ง play/pause ตัว player เอง
  let awaitingLoad = false;    // เพิ่งสั่งโหลดเพลงใหม่ ยังไม่นับ event แรกเป็นการกดของผู้ใช้
  let loadedVideoId = null;
  let roomCode = "";
  let myName = "";
  let leaving = false;         // กันไม่ให้ต่อใหม่ตอนกดออกจากห้องเอง
  let draggingVolume = false;  // ระหว่างลากแถบเสียง อย่าให้เซิร์ฟเวอร์ดึงกลับ
  let dragState = null;        // ระหว่างลากย้ายลำดับเพลงในคิว

  const DRIFT_LIMIT = 1.2;     // วินาที — เกินกว่านี้ถึงจะ seek แก้
  const LOAD_GRACE_MS = 8000;  // หลังสั่งโหลดเพลงใหม่ ยังไม่เล่นภายในช่วงนี้ถือว่ากำลังโหลด ไม่ใช่โดนบล็อก
  let loadStartedAt = 0;

  const serverNow = () => Date.now() + clockOffset;
  // ลำโพงหลัก = เครื่องเดียวที่รายงานเพลงจบ/เล่นไม่ได้ ไม่งั้นหลายลำโพงจะสั่งข้ามเพลงซ้อนกัน
  const isLeader = () => !!state && state.leaderId === clientId;
  // โหมดหลายลำโพง ต่างคนต่างใส่หูฟัง ระดับเสียงจึงเป็นของแต่ละเครื่อง ไม่ใช่ของห้อง
  const personalVolume = () => !!state && state.speakerMode !== "single";
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
      return "YouTube ไม่ยอมให้เล่นคลิปนี้ (เจ้าของปิดการฝัง หรือถูกจำกัดชั่วคราว) ลองใหม่แล้วไม่ผ่าน — ข้ามให้แล้ว";
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

  let myVolume = 50;           // ระดับเสียงของเครื่องนี้เอง ใช้ในโหมดหลายลำโพง
  try {
    const saved = Number(localStorage.getItem("syntech.myVolume"));
    if (localStorage.getItem("syntech.myVolume") !== null && Number.isFinite(saved)) myVolume = saved;
  } catch (_) { }

  // ค่าที่ควรใช้จริง: ของที่เพิ่งลางเองมาก่อน ไม่ให้ sync รอบถัดไปดึงกลับค่าเก่า
  function wantedVolume() {
    if (personalVolume()) return myVolume;
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

  /* ผู้ใช้ปรับเสียงเอง (แถบเสียง ปุ่ม mute คีย์ลัด) ทุกทางต้องผ่านตรงนี้
     โหมดหลายลำโพงปรับเฉพาะเครื่องนี้ ไม่ส่งขึ้นห้อง ไม่งั้นคนเดียวเร่งเสียงจะดังเข้าหูฟังทุกคน */
  function userVolume(value, flush) {
    if (personalVolume()) {
      myVolume = value;
      try { localStorage.setItem("syntech.myVolume", String(value)); } catch (_) { }
      applyVolumeClamped(value);
      if (!draggingVolume) render();   // ไม่มี broadcast กลับมา ต้องวาดแถบเสียงเอง
      return;
    }
    localVolume = value;
    localVolumeAt = Date.now();
    if (state) localVolumeSeq = state.volumeSeq;
    applyVolumeClamped(value);
    sendVolume(value, flush);
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

  /* ---------- ประกาศเสียงตามสาย ----------
     ระหว่างประกาศ เครื่องโฮสต์จะ "หรี่" เพลงลงเฉย ๆ ไม่ได้ส่ง setVolume ขึ้นเซิร์ฟเวอร์
     เพราะถ้าส่ง ระดับเสียงของห้องจะถูกเขียนทับจริง แถบเสียงบนมือถือทุกเครื่องจะกระตุก
     และถ้ามีคนเลื่อนแถบเสียงระหว่างประกาศพอดี ค่าจะตีกันจนคืนค่าผิด
     การหรี่จึงเป็นผลเฉพาะที่เครื่องโฮสต์ และ effectiveVolume() คำนวณใหม่ทุกครั้งที่ sync
     ทำให้ค่าที่ผู้ใช้เพิ่งสั่งยังเป็นใหญ่เสมอ — หรี่ได้แต่ไม่มีทางดังเกินที่ผู้ใช้ตั้งไว้ */
  let announceId = null;       // id ประกาศที่เครื่องนี้จัดการไปแล้ว กันเล่นซ้ำทุกครั้งที่ state เด้ง
  let announceDuck = 0;        // ระดับเสียงที่หรี่ลงระหว่างประกาศ (0 = ไม่ได้ประกาศอยู่)
  let audioCtx = null;
  let announceAudio = null;    // คลิปเสียงประกาศที่กำลังเล่นอยู่ที่ลำโพงเครื่องนี้

  /* ประกาศเป็นเสียงล้วน — อัดเสียงพูดเองหรือเลือกไฟล์จากเครื่อง คลิปพักไว้ที่เครื่องผู้ประกาศ
     จนกว่าจะกดส่ง ค่อยอัปโหลดขึ้นเซิร์ฟเวอร์ แล้วแนบ clipId ไปกับประกาศ ลำโพงดึงคลิปไปเล่น */
  const REC_MAX_MS = 60000;
  const REC_MAX_BYTES = 12000000;        // ต้องตรงกับ CLIP_MAX_BYTES ฝั่งเซิร์ฟเวอร์
  // นามสกุล -> ชนิด เผื่อเบราว์เซอร์ไม่บอก type ของไฟล์ที่เลือก (Windows เจอบ่อยกับ .m4a/.flac)
  const AUDIO_EXT = { mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac",
                      wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", webm: "audio/webm",
                      flac: "audio/flac" };
  let recorder = null;         // MediaRecorder ระหว่างอัด (null = ไม่ได้อัดอยู่)
  let recChunks = [];
  let recStart = 0;
  let recTimer = null;
  let recClip = null;          // {blob, mime, ms, url} คลิปที่อัดเสร็จแล้ว รอส่ง
  let sendingAnnounce = false;

  // ระดับเสียงที่ควรใช้จริงตอนนี้ — หรี่แล้วต้องไม่ดังเกินค่าที่ผู้ใช้ตั้งไว้
  function effectiveVolume() {
    const want = wantedVolume();
    return announceDuck > 0 ? Math.min(announceDuck, want) : want;
  }

  function applyVolumeClamped(value) {
    applyVolume(announceDuck > 0 ? Math.min(announceDuck, value) : value);
  }

  function endDuck(forId) {
    if (forId !== null && forId !== announceId) return;   // ประกาศเก่าถูกแทนที่ไปแล้ว อย่าไปแตะของใหม่
    announceDuck = 0;
    if (isSpeaker) applyVolume(effectiveVolume());
  }

  /* เสียงเตือนก่อนประกาศ สร้างด้วย WebAudio ไม่ต้องมีไฟล์ mp3 ให้โหลด
     สองโน้ตไล่ขึ้น เลียนเสียงออดตามสายของจริง */
  function playChime() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const t0 = audioCtx.currentTime;
      [[880, 0], [1174.7, 0.32]].forEach((pair) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.value = pair[0];
        gain.gain.setValueAtTime(0.0001, t0 + pair[1]);
        gain.gain.exponentialRampToValueAtTime(0.3, t0 + pair[1] + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + pair[1] + 0.4);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t0 + pair[1]);
        osc.stop(t0 + pair[1] + 0.45);
      });
    } catch (_) { }
  }

  function stopClip() {
    if (!announceAudio) return;
    try { announceAudio.pause(); } catch (_) { }
    announceAudio.onended = announceAudio.onerror = null;
    announceAudio = null;
  }

  // ลำโพงเล่นคลิปเสียงที่ผู้ประกาศส่งมา วนตามจำนวนรอบที่ตั้งไว้ เว้นช่วงสั้น ๆ ระหว่างรอบ
  function playClip(url, delayMs, forId, repeat, gapMs) {
    const rounds = Math.max(1, Math.min(3, Number(repeat) || 1));
    setTimeout(() => {
      if (forId !== announceId) return;      // มีประกาศใหม่แซงมาก่อน อันนี้ตกรุ่นแล้ว
      stopClip();
      const audio = new Audio(url);
      audio.preload = "auto";
      audio.volume = 1;
      announceAudio = audio;
      let round = 1;
      const finish = () => {
        if (announceAudio === audio) announceAudio = null;
        endDuck(forId);
      };
      const fail = () => {
        toast("ลำโพงเครื่องนี้เล่นคลิปเสียงประกาศไม่ได้", 7000);
        finish();
      };
      const start = () => {
        const p = audio.play();
        if (p && p.catch) p.catch(fail);
      };
      audio.onended = () => {
        if (round >= rounds || announceAudio !== audio) { finish(); return; }
        round += 1;
        setTimeout(() => {
          if (announceAudio !== audio || forId !== announceId) return;   // โดนกดหยุดระหว่างเว้นช่วง
          audio.currentTime = 0;
          start();
        }, gapMs || 700);
      };
      audio.onerror = fail;
      start();
    }, delayMs || 0);
  }

  function recSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }

  /* Chrome/Edge/Firefox อัดเป็น webm/opus, Safari (iPhone/iPad/Mac) อัดได้แค่ mp4/AAC
     ต้องไล่ถามทีละชนิด ไม่งั้น MediaRecorder จะโยน error ตั้งแต่สร้าง */
  function recMime() {
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    try {
      return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || "";
    } catch (_) { return ""; }
  }

  function updateRecUi() {
    const btn = $("recBtn");
    const status = $("recStatus");
    const preview = $("recPreview");
    if (!btn) return;
    const recording = recorder !== null;
    btn.classList.toggle("recording", recording);
    btn.textContent = recording ? "หยุดอัด" : (recClip ? "อัดใหม่" : "อัดเสียงพูดเอง");
    btn.disabled = sendingAnnounce;
    if ($("recFileBtn")) $("recFileBtn").disabled = sendingAnnounce || recording;
    if (preview) preview.hidden = recording || !recClip;
    if (recClip && $("recAudio") && $("recAudio").src !== recClip.url) $("recAudio").src = recClip.url;
    if (!recording) {
      status.textContent = recClip
        ? (recClip.name ? "ไฟล์ " + recClip.name + " ยาว " : "คลิปยาว ")
          + (recClip.ms / 1000).toFixed(1) + " วินาที — ฟังทวนได้ก่อนส่ง"
        : (recSupported() ? "ยังไม่มีคลิป"
          : (window.isSecureContext ? "เบราว์เซอร์นี้อัดเสียงไม่ได้"
            : "อัดเสียงได้เฉพาะเมื่อเปิดผ่าน https หรือ localhost"));
    }
  }

  function discardClip() {
    if (recClip && recClip.url) { try { URL.revokeObjectURL(recClip.url); } catch (_) { } }
    recClip = null;
    if ($("recAudio")) $("recAudio").removeAttribute("src");
    updateRecUi();
  }

  async function startRecording() {
    if (!recSupported()) {
      toast(window.isSecureContext
        ? "เบราว์เซอร์นี้อัดเสียงไม่ได้ ลองใช้ Chrome, Edge หรือ Safari รุ่นใหม่"
        : "อัดเสียงได้เฉพาะเมื่อเปิดผ่าน https หรือ localhost เท่านั้น", 7000);
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (_) {
      toast("ไม่ได้รับอนุญาตให้ใช้ไมค์ — กดอนุญาตที่แถบที่อยู่ของเบราว์เซอร์แล้วลองใหม่", 7000);
      return;
    }
    const mime = recMime();
    let rec;
    try {
      rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (_) {
      stream.getTracks().forEach((t) => t.stop());
      toast("เบราว์เซอร์นี้อัดเสียงไม่ได้", 6000);
      return;
    }
    discardClip();
    recorder = rec;
    recChunks = [];
    recStart = performance.now();
    rec.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    rec.onstop = () => {
      const ms = Math.round(performance.now() - recStart);
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(recTimer);
      recTimer = null;
      const type = rec.mimeType || mime || "audio/webm";
      const blob = new Blob(recChunks, { type: type });
      recorder = null;
      recChunks = [];
      if (ms < 500 || blob.size < 200) {
        toast("คลิปสั้นเกินไป กดอัดแล้วพูดสักครู่ก่อนกดหยุด");
      } else {
        recClip = { blob: blob, mime: type.split(";")[0], ms: Math.min(ms, REC_MAX_MS),
                    url: URL.createObjectURL(blob) };
      }
      updateRecUi();
    };
    rec.start(250);
    recTimer = setInterval(() => {
      const sec = (performance.now() - recStart) / 1000;
      $("recStatus").textContent = "กำลังอัด… " + sec.toFixed(0) + " / " + (REC_MAX_MS / 1000) + " วินาที";
      if (sec * 1000 >= REC_MAX_MS) stopRecording();
    }, 200);
    updateRecUi();
  }

  /* เลือกไฟล์เสียงจากเครื่องแทนการอัด — ใช้ช่องทางอัปโหลดเดียวกับคลิปที่อัด
     ต้องวัดความยาวด้วย <audio> ก่อน เพราะเซิร์ฟเวอร์ไม่แกะไฟล์เสียง และคลิปยาวเกินจะหรี่เพลงนานเกินไป */
  function pickClipFile(file) {
    if (!file) return;
    if (recorder) stopRecording();
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const mime = ((file.type || "").split(";")[0] || AUDIO_EXT[ext] || "").toLowerCase();
    if (!mime.startsWith("audio/")) {
      toast("ไฟล์นี้ไม่ใช่ไฟล์เสียง ใช้ได้เฉพาะ mp3, m4a, wav, ogg, webm, aac, flac", 7000);
      return;
    }
    if (file.size > REC_MAX_BYTES) {
      toast("ไฟล์ใหญ่เกิน " + Math.round(REC_MAX_BYTES / 1e6) + " MB ลองแปลงเป็น mp3 ก่อน", 7000);
      return;
    }
    const url = URL.createObjectURL(file);
    const probe = new Audio();
    probe.preload = "metadata";
    const fail = (msg) => { try { URL.revokeObjectURL(url); } catch (_) { } toast(msg, 7000); };
    probe.onloadedmetadata = () => {
      const sec = probe.duration;
      if (!Number.isFinite(sec) || sec <= 0) { fail("อ่านความยาวไฟล์นี้ไม่ได้ ลองแปลงเป็น mp3 ก่อน"); return; }
      if (sec * 1000 > REC_MAX_MS + 500) {
        fail("ไฟล์ยาว " + sec.toFixed(0) + " วินาที เกินกำหนด " + (REC_MAX_MS / 1000) + " วินาที ตัดให้สั้นลงก่อน");
        return;
      }
      discardClip();
      recClip = { blob: file, mime: mime, ms: Math.min(Math.round(sec * 1000), REC_MAX_MS),
                  url: url, name: file.name };
      updateRecUi();
    };
    probe.onerror = () => fail("เบราว์เซอร์นี้เปิดไฟล์เสียงนี้ไม่ได้ ลองแปลงเป็น mp3 ก่อน");
    probe.src = url;
  }

  function stopRecording() {
    if (!recorder) return;
    try { recorder.stop(); } catch (_) { recorder = null; updateRecUi(); }
  }

  async function uploadClip(clip) {
    const res = await fetch("/api/announce-audio", {
      method: "POST",
      headers: { "Content-Type": clip.mime },
      body: clip.blob,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "อัปโหลดคลิปเสียงไม่สำเร็จ");
    return data.clipId;
  }

  function handleAnnouncement() {
    const ann = state ? state.announcement : null;
    const banner = $("announceBanner");

    if (!ann) {
      if (announceId !== null) {
        announceId = null;
        announceDuck = 0;
        stopClip();
        if (isSpeaker) applyVolume(effectiveVolume());
      }
      if (banner) banner.hidden = true;
      return;
    }

    // แบนเนอร์ขึ้นทุกเครื่อง คนที่ไม่ได้อยู่ใกล้ลำโพงก็รู้ว่ามีประกาศอยู่ และกดหยุดได้
    $("announceFrom").textContent = ann.by + (ann.scope === "all" ? " · ทุกห้อง" : "");
    $("announceText").textContent = "กำลังเล่นเสียงประกาศ"
      + (ann.repeat > 1 ? " (" + ann.repeat + " รอบ)" : "");
    if (banner) banner.hidden = false;

    if (ann.id === announceId) return;
    announceId = ann.id;
    announceDuck = ann.duck || 0;
    if (!isSpeaker) return;

    applyVolume(effectiveVolume());
    // เพิ่งรับช่วงเป็นโฮสต์ตอนประกาศใกล้จบ เล่นใหม่ตั้งแต่ต้นจะกวนกว่าเงียบ
    if (ann.endsAt - serverNow() < 1000) { endDuck(ann.id); return; }
    if (ann.chime) playChime();
    if (ann.audio) playClip(ann.audio, ann.chime ? 850 : 0, ann.id, ann.repeat, ann.repeatGapMs);
    else setTimeout(() => endDuck(ann.id), Math.max(0, ann.endsAt - serverNow()));
  }

  async function sendAnnouncement() {
    if (sendingAnnounce) return;
    if (recorder) { toast("กำลังอัดอยู่ กดหยุดอัดก่อนแล้วค่อยส่ง"); return; }
    if (!recClip) { toast("ยังไม่ได้อัดเสียงหรือเลือกไฟล์เสียงประกาศ"); return; }
    const repeat = Number($("announceRepeat").value) || 1;
    localStorage.setItem("syntech.announceRepeat", String(repeat));

    // อัปโหลดคลิปก่อน ได้ id แล้วค่อยส่งประกาศ ถ้าอัปโหลดล้ม คลิปยังอยู่ กดส่งใหม่ได้
    sendingAnnounce = true;
    $("sendAnnounceBtn").disabled = true;
    updateRecUi();
    let clipId;
    try {
      clipId = await uploadClip(recClip);
    } catch (err) {
      toast(err.message || "อัปโหลดคลิปเสียงไม่สำเร็จ", 7000);
      return;
    } finally {
      sendingAnnounce = false;
      $("sendAnnounceBtn").disabled = false;
      updateRecUi();
    }
    send({
      type: "announce",
      clipId: clipId,
      clipMs: recClip.ms,
      repeat: repeat,
      scope: $("announceScope").value,
      chime: $("announceChime").checked,
    });
    discardClip();
    $("announceModal").hidden = true;
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
    if (lower.includes("spotify.com")) return true;
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
      // โหลดรูปเฉพาะที่เลื่อนมาถึง และถอดรหัสนอกเธรดหลัก — ลิสต์ยาวๆ จะไม่หน่วง
      art.loading = "lazy";
      art.decoding = "async";
      art.width = 68;
      art.height = 38;

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
          const isPlay = e.data === YT.PlayerState.PLAYING;
          const isPause = e.data === YT.PlayerState.PAUSED;

          // event แรกหลังสั่งโหลดเพลงใหม่เป็นผลของการโหลด ไม่ใช่ผู้ใช้กด
          if (awaitingLoad && (isPlay || isPause)) {
            awaitingLoad = false;
          } else if (state && !isSelfAction()) {
            /* โฮสต์กดเล่น/หยุดจากในกรอบ YouTube โดยตรง — ต้องบอกเซิร์ฟเวอร์ด้วย
               ถ้าไม่บอก เซิร์ฟเวอร์จะยังคิดว่าเล่นอยู่ แล้ว sync() จะสั่ง playVideo()
               ซ้ำทุก 2 วินาที จนไปเข้าเงื่อนไข "เบราว์เซอร์บล็อกเสียง" ทั้งที่ผู้ใช้ตั้งใจหยุด */
            if (isPause && state.playing) {
              markSelfAction();
              send({ type: "pause" });
            } else if (isPlay && !state.playing) {
              markSelfAction();
              send({ type: "play" });
            }
          }

          if (isPlay) {
            if (retry.videoId === loadedVideoId && retry.count > 0) {
              reportPlayError(loadedVideoId, -1, retry.count, "recovered");   // ลองใหม่แล้วเล่นได้
            }
            retry = { videoId: null, count: 0 };
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
            awaitingLoad = false;
            const track = currentTrack();
            if (track && isLeader()) send({ type: "ended", videoId: track.videoId });
          }
        },
        onError: (e) => handlePlayerError(e.data),
      },
    });
  }

  /* error 101/150 ไม่ได้แปลว่าเจ้าของปิดการฝังเสมอไป YouTube ใช้รหัสเดียวกันตอนจำกัดการเล่นชั่วคราว
     (โหลดถี่จาก IP เดียวกัน, เงื่อนไขลิขสิทธิ์ของค่ายเพลง) ซึ่งลองใหม่มักเล่นได้
     จึงลองโหลดใหม่ก่อน RETRY_MAX ครั้ง เว้นระยะห่างขึ้นเรื่อย ๆ ไม่ให้ไปกระหน่ำโหลดจนโดนจำกัดหนักกว่าเดิม
     error 5 (HTML5 player ขัดข้อง) ก็ชั่วคราวได้เหมือนกัน ส่วน 2/100 คือลิงก์ผิด/คลิปหาย ลองไปก็ไม่ได้ */
  const RETRY_CODES = [5, 101, 150];
  const RETRY_MAX = 2;
  let retry = { videoId: null, count: 0 };
  let retryTimer = null;

  function reportPlayError(videoId, code, attempt, outcome) {
    send({ type: "playError", videoId: videoId, code: code, attempt: attempt, outcome: outcome });
  }

  function handlePlayerError(code) {
    const track = currentTrack();
    if (!track) return;
    if (retry.videoId !== track.videoId) retry = { videoId: track.videoId, count: 0 };

    if (RETRY_CODES.includes(code) && retry.count < RETRY_MAX) {
      retry.count += 1;
      reportPlayError(track.videoId, code, retry.count, "retry");
      toast("YouTube ยังไม่ยอมเล่นคลิปนี้ กำลังลองใหม่ (" + retry.count + "/" + RETRY_MAX + ")…", 3500);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        const now = currentTrack();
        // ระหว่างรอ เพลงอาจถูกข้ามไปแล้ว หรือเครื่องนี้เลิกเป็นลำโพงแล้ว
        if (!now || now.videoId !== retry.videoId || !isSpeaker || !playerReady) return;
        loadStartedAt = Date.now();
        awaitingLoad = true;
        markSelfAction();
        player.loadVideoById({ videoId: now.videoId, startSeconds: targetPosition() });
      }, 2500 * retry.count);
      return;
    }

    reportPlayError(track.videoId, code, retry.count, "gave-up");
    if (!isLeader()) {
      // ลำโพงรองเล่นไม่ได้ ไม่ได้แปลว่าเครื่องอื่นเล่นไม่ได้ อย่าสั่งข้ามเพลงของทั้งห้อง
      toast("เครื่องนี้เล่นคลิปนี้ไม่ได้ (error " + code + ") — เครื่องอื่นยังเล่นต่อ");
      return;
    }
    toast(errorText(code));
    send({ type: "trackError", videoId: track.videoId, code: code });
  }

  /* YouTube ยิง event PLAYING/PAUSED ทั้งตอนผู้ใช้กดเอง และตอนที่เราสั่งผ่าน API
     สองกรณีนี้ต้องแยกกันให้ออก ไม่งั้นคำสั่งของเราจะเด้งกลับเป็นคำสั่งซ้ำวนไม่จบ
     จึงจับเวลาไว้: event ที่มาภายใน SELF_ACTION_MS หลังเราสั่ง = ผลของเราเอง ไม่ต้องส่งต่อ */
  const SELF_ACTION_MS = 1500;

  function markSelfAction() {
    selfActionAt = Date.now();
  }

  function isSelfAction() {
    return Date.now() - selfActionAt < SELF_ACTION_MS;
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
    clearTimeout(retryTimer);
    retryTimer = null;
    retry = { videoId: null, count: 0 };
    const mount = $("ytMount");
    if (mount) mount.remove();
    if ($("unblockBtn")) $("unblockBtn").hidden = true;
    if ($("unblockModal")) $("unblockModal").hidden = true;
  }

  function applyRole() {
    isHost = state.hostId === clientId;
    const nowSpeaker = (state.speakers || []).includes(clientId);
    if (state.speakerMode === "selected") wantSelfSpeaker = nowSpeaker;
    if (nowSpeaker === isSpeaker) return;
    const firstTime = isSpeaker === null;
    isSpeaker = nowSpeaker;
    const remoteOverlay = $("remoteOverlay");
    if (remoteOverlay) remoteOverlay.hidden = isSpeaker;
    if (isSpeaker) {
      wantPlayer = true;
      createPlayer();
      if (!firstTime) toast("เครื่องนี้เปิดเสียงเพลงแล้ว");
    } else {
      destroyPlayer();
      if (!firstTime) toast("เครื่องนี้หยุดเปิดเสียงแล้ว เป็นรีโมท");
    }
  }

  // ปุ่มบนหัวจอเปลี่ยนหน้าที่ตามโหมด: ย้ายลำโพง / เปิด-ปิดเสียงเครื่องนี้ / ไม่ต้องมี
  function renderClaimBtn() {
    const btn = $("claimBtn");
    if (!btn) return;
    const mode = state.speakerMode || "single";
    if (mode === "all" || (mode === "single" && isSpeaker)) {
      btn.hidden = true;
      return;
    }
    btn.hidden = false;
    if (mode === "single") {
      btn.textContent = "ย้ายลำโพงมาเครื่องนี้";
      btn.title = "ย้ายลำโพงมาเปิดที่เครื่องนี้";
    } else {
      btn.textContent = isSpeaker ? "ปิดเสียงที่เครื่องนี้" : "เปิดเสียงที่เครื่องนี้";
      btn.title = "เลือกว่าเครื่องนี้จะเป็นลำโพงด้วยไหม";
    }
  }

  // ---------- WebSocket ----------
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(proto + "://" + location.host + "/ws/" + roomCode);

    ws.onopen = () => {
      badge("เชื่อมต่อแล้ว", "ok");
      send({ type: "hello", name: myName });
      if (wantSelfSpeaker) send({ type: "setSpeaker", value: true });
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
        handleAnnouncement();
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
    if (!isSpeaker || !state) return;
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

    applyVolume(effectiveVolume());
    const target = targetPosition();

    // กำลังรอลองโหลดคลิปที่ error ใหม่ อย่าเพิ่งสั่ง play/seek ซ้ำ ไม่งั้นจะเข้าเงื่อนไข "โดนบล็อกเสียง"
    if (retryTimer && retry.videoId === track.videoId) return;

    if (loadedVideoId !== track.videoId) {
      loadedVideoId = track.videoId;
      loadStartedAt = Date.now();
      awaitingLoad = true;
      markSelfAction();
      player.loadVideoById({ videoId: track.videoId, startSeconds: target });
      setTimeout(() => { if (state) applyVolume(effectiveVolume()); }, 800);
      return;
    }

    // รายงานความยาวเพลงให้เครื่องรีโมทใช้วาดแถบเวลา
    const duration = player.getDuration() || 0;
    if (isLeader() && duration && Math.abs((track.duration || 0) - duration) > 1) {
      send({ type: "duration", videoId: track.videoId, seconds: duration });
    }

    const actual = player.getCurrentTime() || 0;
    if (Math.abs(actual - target) > DRIFT_LIMIT) player.seekTo(target, true);

    const ps = player.getPlayerState();
    /* เพลงจบแล้ว กำลังรอเซิร์ฟเวอร์ขึ้นเพลงถัดไป — ไม่ใช่โดนบล็อก และห้ามสั่ง playVideo()
       ไม่งั้นเพลงที่จบไปจะเด้งกลับมาเล่นตั้งแต่ต้นแวบหนึ่ง
       เจอบ่อยในโหมดหลายลำโพง เพราะลำโพงรองจบก่อนลำโพงหลักได้เกือบวินาที
       (ถ้าเซิร์ฟเวอร์สั่งกลับไปต้นเพลง เช่น วนซ้ำเพลงเดียว target จะต่ำกว่า actual มาก จึงไม่เข้าเงื่อนไขนี้) */
    const waitingNext = ps === YT.PlayerState.ENDED && target >= actual - DRIFT_LIMIT;
    if (state.playing && !waitingNext && ps !== YT.PlayerState.PLAYING && ps !== YT.PlayerState.BUFFERING) {
      markSelfAction();
      player.playVideo();
      /* สั่งเล่นแล้วยังไม่ขยับ = น่าจะโดนบล็อกเสียงอยู่
         ต้องรอ 2 รอบ (~4 วิ) ก่อนขึ้น popup — รอบเดียวมันเร็วเกินไป
         จังหวะที่ผู้ใช้เพิ่งกดหยุดเองแล้ว state ฝั่งเซิร์ฟเวอร์ยังตามไม่ทัน
         จะโดนเหมารวมว่าโดนบล็อกทั้งที่ไม่ใช่
         ไม่นับช่วงที่เพิ่งโหลดเพลงใหม่ (เน็ตช้า/โฆษณากำลังโหลด) และตอนแท็บถูกซ่อน */
      const loading = Date.now() - loadStartedAt < LOAD_GRACE_MS;
      if (!loading && !document.hidden && ++blockedTicks >= 2) {
        if ($("unblockModal")) $("unblockModal").hidden = false;
        if ($("unblockBtn")) $("unblockBtn").hidden = false;
      }
    } else {
      blockedTicks = 0;
      if ($("unblockModal")) $("unblockModal").hidden = true;
      if ($("unblockBtn")) $("unblockBtn").hidden = true;
    }
    if (!state.playing && ps === YT.PlayerState.PLAYING) {
      markSelfAction();
      player.pauseVideo();
    }
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
    const mode = state.speakerMode || "single";
    $("roleBadge").textContent = !isSpeaker ? "รีโมท (ไม่มีเสียง)"
      : mode === "single" ? "เครื่องนี้คือลำโพง" : "เครื่องนี้เปิดเสียงอยู่";
    $("roleBadge").className = "badge " + (isSpeaker ? "ok" : "");
    renderClaimBtn();

    const speakers = state.listeners.filter((l) => l.speaker);
    $("remoteWho").textContent = !speakers.length ? "ยังไม่มีเครื่องไหนเป็นลำโพง"
      : speakers.length === 1 ? "เสียงออกที่เครื่องของ " + speakers[0].name
      : "เสียงออก " + speakers.length + " เครื่อง";

    const modeSel = $("speakerMode");
    // อย่าเขียนทับตอนผู้ใช้กำลังเลือกอยู่ ไม่งั้นรายการจะเด้งกลับ
    if (modeSel && document.activeElement !== modeSel) modeSel.value = mode;
    const speakerHint = $("speakerHint");
    if (speakerHint) {
      speakerHint.textContent = mode === "single" ? "เสียงออกเครื่องเดียว เครื่องอื่นเป็นรีโมท"
        : mode === "all" ? "ทุกเครื่องเปิดเสียงพร้อมกัน เหมาะกับต่างคนต่างใส่หูฟัง · แถบเสียงปรับเฉพาะเครื่องตัวเอง"
        : "แตะป้ายลำโพง/รีโมทหลังชื่อเพื่อสลับ · แถบเสียงปรับเฉพาะเครื่องตัวเอง";
    }
    const volHint = $("volHint");
    if (volHint) {
      volHint.textContent = (personalVolume() ? "แถบเสียงปรับเฉพาะเครื่องนี้" : "แถบเสียงคุมลำโพงของห้อง")
        + " · คลิกแถบเวลาเพื่อเลื่อน";
    }
    // ตั้ง src เฉพาะตอนที่เปลี่ยนเพลงจริง ไม่งั้นทุกครั้งที่ render จะสั่งโหลดรูปใหม่
    const artEl = $("remoteArt");
    artEl.decoding = "async";
    if (track) {
      const art = "https://i.ytimg.com/vi/" + track.videoId + "/mqdefault.jpg";
      if (artEl.getAttribute("src") !== art) artEl.setAttribute("src", art);
    } else {
      artEl.removeAttribute("src");
    }
    artEl.hidden = !track;
    $("app").classList[state.playing && track ? "add" : "remove"]("is-playing");

    const vol = wantedVolume();
    const muteBtn = $("muteBtn");
    if (muteBtn) {
      // วาด SVG ครั้งเดียวตอนแรก จากนั้นสลับแค่คลาส — CSS เป็นคนซ่อน/โชว์คลื่นเสียงกับขีดทับ
      if (!muteBtn.firstElementChild) muteBtn.innerHTML = MUTE_ICON;
      muteBtn.classList[vol === 0 ? "add" : "remove"]("is-muted");
      muteBtn.title = vol === 0 ? "เปิดเสียง (กด M)" : "ปิดเสียง (กด M)";
    }

    const rMode = state.repeatMode || "off";
    const rBtn = $("repeatBtn");
    if (rBtn) {
      if (rMode === "one") {
        rBtn.textContent = "วนซ้ำเพลงนี้";
        rBtn.className = "ghost small is-repeat-one";
      } else if (rMode === "all") {
        rBtn.textContent = "วนซ้ำคิว";
        rBtn.className = "ghost small is-repeat-all";
      } else {
        rBtn.textContent = "ไม่ซ้ำ";
        rBtn.className = "ghost small";
      }
      rBtn.disabled = !canControl;
    }

    const autoDjBtn = $("autoDjBtn");
    if (autoDjBtn) {
      autoDjBtn.textContent = state.autoDj ? "Auto DJ: เปิด" : "Auto DJ: ปิด";
      autoDjBtn.className = state.autoDj ? "ghost small active" : "ghost small";
      autoDjBtn.disabled = !canControl;
    }
    const autoDjMode = $("autoDjMode");
    if (autoDjMode) {
      // ไม่ทับค่าตอนผู้ใช้กำลังกางเมนูเลือกอยู่ ไม่งั้นเมนูเด้งปิดทุกครั้งที่ state เข้า
      if (document.activeElement !== autoDjMode) autoDjMode.value = state.autoDjMode || "genre";
      autoDjMode.disabled = !canControl;
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
      if (l.speaker) li.className = "is-speaker";
      const nm = document.createElement("span");
      nm.className = "ln";
      nm.textContent = l.name + (l.id === clientId ? " (คุณ)" : "");
      // โหมดเลือกบางเครื่อง ป้ายกลายเป็นปุ่มสลับ ใครก็กดให้เครื่องไหนเป็นลำโพงได้
      const tag = document.createElement(mode === "selected" ? "button" : "small");
      tag.className = "role-tag";
      tag.textContent = l.speaker ? "ลำโพง" : "รีโมท";
      if (mode === "selected") {
        tag.type = "button";
        tag.dataset.speaker = l.id;
        tag.dataset.on = l.speaker ? "1" : "";
        tag.title = l.speaker ? "แตะเพื่อปิดเสียงเครื่องนี้" : "แตะเพื่อให้เครื่องนี้เปิดเสียง";
      }
      li.append(nm, tag);
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
      const badge = document.createElement("span");
      badge.className = "dj-badge";
      badge.textContent = String(idx + 1);
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
    const duration = isSpeaker && playerReady
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
    announceId = null;
    announceDuck = 0;
    stopClip();
    stopRecording();
    if ($("announceBanner")) $("announceBanner").hidden = true;
    if ($("announceModal")) $("announceModal").hidden = true;
    if (ws) ws.close();
    ws = null;
    destroyPlayer();
    isHost = false;
    isSpeaker = null;
    wantSelfSpeaker = false;
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
  on("claimBtn", "click", () => {
    if (state && state.speakerMode === "selected") send({ type: "setSpeaker", value: !isSpeaker });
    else send({ type: "claimHost" });
  });
  on("speakerMode", "change", (e) => send({ type: "setSpeakerMode", mode: e.target.value }));
  on("listeners", "click", (e) => {
    const tag = e.target.closest("button[data-speaker]");
    if (tag) send({ type: "setSpeaker", id: tag.dataset.speaker, value: !tag.dataset.on });
  });

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
  on("autoDjMode", "change", (e) => {
    send({ type: "setAutoDjMode", mode: e.target.value });
    e.target.blur();
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
      userVolume(0, true);
    } else {
      userVolume(lastNonZeroVolume || 70, true);
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
    // แตะ ≡ เฉย ๆ ไม่ได้ลาก ต้องไม่ส่งอะไร — ต้องเช็คก่อนบีบค่า ไม่งั้นแตะเพลงที่กำลังเล่นจะกลายเป็นข้ามเพลง
    if (target === from) { render(); return; }
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
    $("volLabel").textContent = value;
    paintVolume(value);
    userVolume(value, false);  // เครื่องลำโพงได้ยินผลทันที ไม่ต้องรอเซิร์ฟเวอร์ตอบ
  });
  $("volume").addEventListener("change", (e) => {
    draggingVolume = false;
    userVolume(Number(e.target.value), true);   // ค่าสุดท้ายส่งทันที ไม่ตกหล่น
  });

  function unlockAudio() {
    blockedTicks = 0;
    if ($("unblockBtn")) $("unblockBtn").hidden = true;
    if ($("unblockModal")) $("unblockModal").hidden = true;
    if (isSpeaker && player && playerReady) {
      applyVolume(effectiveVolume());
      if (player.isMuted && player.isMuted()) player.unMute();
      markSelfAction();
      player.playVideo();
    }
  }

  on("unblockBtn", "click", unlockAudio);
  on("unblockModalBtn", "click", unlockAudio);
  on("unblockModal", "click", unlockAudio);

  // ปลดบล็อกเสียงอัตโนมัติทันทีที่ผู้ใช้สัมผัสหรือคลิกตรงไหนก็ได้บนหน้าจอ (User Gesture Auto-unlock)
  document.addEventListener("pointerdown", () => {
    // เพิ่งมีคำสั่ง play/pause ของเราเองค้างอยู่ อย่าเพิ่งไปสั่งเล่นทับ
    // ไม่งั้นจังหวะที่ผู้ใช้กดหยุดในกรอบ YouTube แล้วมาแตะหน้าจอ เพลงจะเด้งกลับมาเล่น
    if (isSelfAction()) return;
    if (isSpeaker && player && playerReady) {
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
    const duration = isSpeaker && playerReady
      ? player.getDuration() || 0
      : (track && track.duration) || 0;
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    send({ type: "seek", position: ((e.clientX - rect.left) / rect.width) * duration });
  });

  // ---------- คีย์บอร์ดลัด (Keyboard Shortcuts) ----------
  document.addEventListener("keydown", (e) => {
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA"
      || active.tagName === "SELECT" || active.isContentEditable)) return;
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
      userVolume(Math.min(100, wantedVolume() + 5), true);
    } else if (key === "ArrowDown") {
      e.preventDefault();
      userVolume(Math.max(0, wantedVolume() - 5), true);
    }
  });

  // ---------- ประกาศเสียงตามสาย ----------
  on("announceBtn", "click", () => {
    const modal = $("announceModal");
    if (!modal) return;
    const savedRepeat = localStorage.getItem("syntech.announceRepeat");
    if (savedRepeat && $("announceRepeat")) $("announceRepeat").value = savedRepeat;
    updateRecUi();
    modal.hidden = false;
  });
  // ปิดหน้าต่างระหว่างอัดอยู่ = หยุดอัดด้วย ไม่งั้นไมค์ค้างเปิดทั้งที่มองไม่เห็นอะไร
  on("closeAnnounceBtn", "click", () => { stopRecording(); $("announceModal").hidden = true; });
  on("announceModal", "click", (e) => {
    if (e.target === $("announceModal")) { stopRecording(); $("announceModal").hidden = true; }
  });
  on("recBtn", "click", () => { if (recorder) stopRecording(); else startRecording(); });
  on("recDiscardBtn", "click", discardClip);
  on("recFileBtn", "click", () => { const f = $("recFile"); if (f) { f.value = ""; f.click(); } });
  on("recFile", "change", (e) => pickClipFile(e.target.files && e.target.files[0]));
  on("sendAnnounceBtn", "click", sendAnnouncement);
  on("announceStopBtn", "click", () => send({ type: "announceStop" }));

  // ---------- init ----------
  $("nameInput").value = localStorage.getItem("syntech.name") || localStorage.getItem("synhub.name") || "";
  setInterval(sync, 2000);          // แก้ drift ทุก 2 วินาที
  // กลับมาที่แท็บ/เปิดจอมือถือ ซิงก์ทันที ไม่ต้องรอรอบถัดไป
  document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
  setInterval(tick, 250);           // อัปเดตแถบเวลา
  setInterval(measureClock, 15000); // ปรับนาฬิกาให้ตรงกับเซิร์ฟเวอร์

  if (location.hash.length > 1) {
    joinRoom(location.hash.slice(1));   // เปิดจากลิงก์ที่เพื่อนส่งมา = เข้าห้องเลย
  } else {
    startRoomPolling();
  }
})();
