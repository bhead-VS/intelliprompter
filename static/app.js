// Intelliprompter cockpit: speech -> transcript -> Jev -> checklist.
(() => {
  const $ = (id) => document.getElementById(id);
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
  };

  const CHECK_INTERVAL_MS = 500;
  const WARM_SCORE = 0.4;

  const state = {
    topics: [],            // {id, text, detail, done, score, manual}
    segments: [],          // finalized speech: {t, text}
    partials: new Map(),   // item_id -> in-progress text
    lastCheckedText: "",
    inFlight: false,
    live: false,
    startedAt: 0,
    stt: null,
    config: {},
  };

  // ---------- topics & plans ----------
  function parseTopics(raw) {
    return raw.split("\n").map((l) => l.trim()).filter(Boolean).map((line, i) => {
      const [text, ...rest] = line.split("::");
      return { id: `t${i}`, text: text.trim(), detail: rest.join("::").trim() || null, done: false, score: 0 };
    });
  }

  function refreshPlanSelect() {
    const plans = store.get("ip.plans", {});
    const sel = $("planSelect");
    sel.innerHTML = '<option value="">—</option>' +
      Object.keys(plans).sort().map((n) => `<option>${escapeHtml(n)}</option>`).join("");
  }

  $("savePlan").onclick = () => {
    const name = $("planName").value.trim() || $("planSelect").value;
    if (!name) return $("planName").focus();
    const plans = store.get("ip.plans", {});
    plans[name] = $("topicsInput").value;
    store.set("ip.plans", plans);
    refreshPlanSelect();
    $("planSelect").value = name;
  };
  $("deletePlan").onclick = () => {
    const name = $("planSelect").value;
    if (!name) return;
    const plans = store.get("ip.plans", {});
    delete plans[name];
    store.set("ip.plans", plans);
    refreshPlanSelect();
  };
  $("planSelect").onchange = (e) => {
    const plans = store.get("ip.plans", {});
    if (plans[e.target.value] !== undefined) {
      $("topicsInput").value = plans[e.target.value];
      $("planName").value = e.target.value;
    }
  };

  // ---------- views ----------
  function showSetup() {
    $("setup").hidden = false;
    $("cockpit").hidden = true;
  }

  function showCockpit() {
    const raw = $("topicsInput").value;
    store.set("ip.draft", raw);
    state.topics = parseTopics(raw);
    if (!state.topics.length) return $("topicsInput").focus();
    resetTranscript();
    $("setup").hidden = true;
    $("cockpit").hidden = false;
    renderChecklist();
  }

  $("goBtn").onclick = showCockpit;
  $("setupBtn").onclick = () => { if (state.live) stopLive(); showSetup(); };

  function renderChecklist() {
    const list = $("checklist");
    list.innerHTML = "";
    const nextId = state.topics.find((t) => !t.done)?.id;
    for (const t of state.topics) {
      const li = document.createElement("li");
      li.className = "item";
      li.dataset.id = t.id;
      li.innerHTML = `
        <div class="box">✓</div>
        <div>
          <div class="title">${escapeHtml(t.text)}<span class="tag" ${t.id === nextId ? "" : "hidden"}>UP NEXT</span></div>
          ${t.detail ? `<div class="detail">${escapeHtml(t.detail)}</div>` : ""}
        </div>
        <div class="meter" title="Jev confidence"><i></i></div>`;
      li.onclick = () => { t.done = !t.done; t.manual = true; updateItems(); };
      list.appendChild(li);
    }
    updateItems();
  }

  function updateItems(justDone = []) {
    const threshold = Number($("threshold").value);
    const nextId = state.topics.find((t) => !t.done)?.id;
    for (const t of state.topics) {
      const li = document.querySelector(`.item[data-id="${t.id}"]`);
      if (!li) continue;
      li.classList.toggle("done", t.done);
      li.classList.toggle("warm", !t.done && t.score >= WARM_SCORE && t.score < threshold);
      li.classList.toggle("next", t.id === nextId);
      li.querySelector(".tag").hidden = t.id !== nextId;
      li.querySelector(".meter i").style.width = `${Math.round(t.score * 100)}%`;
      if (justDone.includes(t.id)) {
        li.classList.remove("just-done");
        void li.offsetWidth;
        li.classList.add("just-done");
      }
    }
    const done = state.topics.filter((t) => t.done).length;
    $("progress").textContent = `${done} / ${state.topics.length}`;
  }

  // ---------- transcript ----------
  function resetTranscript() {
    state.segments = [];
    state.partials.clear();
    state.lastCheckedText = "";
    renderTranscript();
  }

  function addFinal(text, itemId) {
    if (itemId) state.partials.delete(itemId);
    text = (text || "").trim();
    if (text) state.segments.push({ t: Date.now(), text });
    renderTranscript();
  }

  function setPartial(itemId, text) {
    state.partials.set(itemId, text);
    renderTranscript();
  }

  function windowText() {
    const cutoff = Date.now() - Number($("windowSecs").value || 60) * 1000;
    const finals = state.segments.filter((s) => s.t >= cutoff).map((s) => s.text);
    return [...finals, ...state.partials.values()].join(" ").trim();
  }

  function renderTranscript() {
    const el = $("transcript");
    const finals = state.segments.slice(-3).map((s) => escapeHtml(s.text)).join(" ");
    const partial = [...state.partials.values()].map(escapeHtml).join(" ");
    el.innerHTML = finals || partial
      ? `<div>${finals} <span class="partial">${partial}</span></div>`
      : '<span class="muted">Transcript will stream here…</span>';
  }

  $("simForm").onsubmit = (e) => {
    e.preventDefault();
    const v = $("simInput").value;
    $("simInput").value = "";
    if ($("cockpit").hidden) showCockpit();
    addFinal(v);
  };

  // ---------- Jev checking loop ----------
  async function checkLoop() {
    if (state.inFlight || $("cockpit").hidden) return;
    const text = windowText();
    const pending = state.topics.filter((t) => !t.done);
    if (!text || text === state.lastCheckedText || !pending.length) return;
    state.inFlight = true;
    state.lastCheckedText = text;
    const started = performance.now();
    try {
      const res = await api("/api/check", {
        transcript: text,
        topics: pending.map(({ id, text, detail }) => ({ id, text, detail })),
      });
      const ms = Math.round(performance.now() - started);
      setPill("jevStatus", `Jev: ${ms} ms`, "ok");
      const threshold = Number($("threshold").value);
      const justDone = [];
      for (const t of pending) {
        const score = res.scores[t.id];
        if (score === undefined || t.done) continue;
        t.score = score;
        if (score >= threshold) { t.done = true; justDone.push(t.id); }
      }
      updateItems(justDone);
    } catch (err) {
      setPill("jevStatus", `Jev: ${err.message}`, "err");
    } finally {
      state.inFlight = false;
    }
  }
  setInterval(checkLoop, CHECK_INTERVAL_MS);

  // ---------- speech-to-text ----------
  async function startOpenAI() {
    const { token, api: apiVersion } = await api("/api/stt-token", {});
    const protocols = ["realtime", `openai-insecure-api-key.${token}`];
    if (apiVersion === "beta") protocols.push("openai-beta.realtime-v1");
    const ws = new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", protocols);

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const ctx = new AudioContext({ sampleRate: 24000 });
    await ctx.audioWorklet.addModule("/static/pcm-worklet.js");
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "pcm16-capture");
    source.connect(node);

    node.port.onmessage = (e) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: toBase64(e.data) }));
      }
    };

    ws.onopen = () => setPill("sttStatus", "STT: OpenAI live", "ok");
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case "conversation.item.input_audio_transcription.delta":
          setPartial(msg.item_id, (state.partials.get(msg.item_id) || "") + msg.delta);
          break;
        case "conversation.item.input_audio_transcription.completed":
          addFinal(msg.transcript, msg.item_id);
          break;
        case "error":
          setPill("sttStatus", `STT: ${msg.error?.message || "error"}`, "err");
          break;
      }
    };
    ws.onclose = (e) => {
      if (state.live) setPill("sttStatus", `STT: closed (${e.code})`, "err");
    };

    return () => {
      ws.close();
      node.disconnect();
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      ctx.close();
    };
  }

  function startBrowser() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) throw new Error("this browser has no built-in speech recognition");
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    let stopped = false;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const key = `b${i}`;
        if (r.isFinal) addFinal(r[0].transcript, key);
        else setPartial(key, r[0].transcript);
      }
    };
    rec.onerror = (e) => setPill("sttStatus", `STT: ${e.error}`, "err");
    rec.onend = () => { if (!stopped) rec.start(); };   // Chrome stops after silence
    rec.start();
    setPill("sttStatus", "STT: browser live", "ok");
    return () => { stopped = true; rec.stop(); };
  }

  async function startLive() {
    if ($("cockpit").hidden) showCockpit();
    if ($("cockpit").hidden) return;
    const source = $("sttSource").value;
    store.set("ip.stt", source);
    $("micBtn").disabled = true;
    try {
      if (source === "openai") state.stt = await startOpenAI();
      else if (source === "browser") state.stt = startBrowser();
      else { state.stt = () => {}; setPill("sttStatus", "STT: typing only"); }
      state.live = true;
      state.startedAt = Date.now();
      $("micBtn").textContent = "■ Stop";
      $("micBtn").classList.add("live");
    } catch (err) {
      setPill("sttStatus", `STT: ${err.message}`, "err");
    } finally {
      $("micBtn").disabled = false;
    }
  }

  function stopLive() {
    state.live = false;
    if (state.stt) state.stt();
    state.stt = null;
    $("micBtn").textContent = "● Start";
    $("micBtn").classList.remove("live");
    setPill("sttStatus", "STT: off");
  }

  $("micBtn").onclick = () => (state.live ? stopLive() : startLive());

  setInterval(() => {
    if (!state.live) return;
    const s = Math.floor((Date.now() - state.startedAt) / 1000);
    $("timer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }, 250);

  // ---------- helpers ----------
  async function api(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Access-Code": $("accessCode").value },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : `HTTP ${res.status}`);
    return data;
  }

  function setPill(id, text, cls) {
    const el = $(id);
    el.textContent = text.length > 60 ? text.slice(0, 57) + "…" : text;
    el.title = text;
    el.className = `pill ${cls || ""}`;
  }

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- init ----------
  $("threshold").oninput = (e) => { $("thresholdVal").textContent = Number(e.target.value).toFixed(2); store.set("ip.threshold", e.target.value); };
  $("accessCode").onchange = (e) => store.set("ip.access", e.target.value);
  $("topicsInput").value = store.get("ip.draft", "");
  $("sttSource").value = store.get("ip.stt", "openai");
  $("threshold").value = store.get("ip.threshold", "0.7");
  $("thresholdVal").textContent = Number($("threshold").value).toFixed(2);
  $("accessCode").value = store.get("ip.access", "");
  refreshPlanSelect();

  fetch("/api/config").then((r) => r.json()).then((cfg) => {
    state.config = cfg;
    $("accessWrap").hidden = !cfg.accessCodeRequired;
    if (!cfg.jevConfigured) setPill("jevStatus", "Jev: no key on server", "err");
    if (!cfg.openaiConfigured && $("sttSource").value === "openai") $("sttSource").value = "browser";
  }).catch(() => {});
})();
