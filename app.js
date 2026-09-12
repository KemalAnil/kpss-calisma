/* KPSS Ön Lisans 2026 — Çalışma Platformu
   Tüm veriler tarayıcının yerel veritabanında (IndexedDB) saklanır.
   İnternet/sunucu/API gerekmez. */

(function () {
  "use strict";

  // ---------- IndexedDB yardımcıları ----------
  const DB_NAME = "kpss_onlisans";
  const DB_VERSION = 2;
  let db = null;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains("questions")) {
          const s = d.createObjectStore("questions", { keyPath: "id" });
          s.createIndex("topicKey", "topicKey", { unique: false });
        }
        if (!d.objectStoreNames.contains("videos")) {
          const s = d.createObjectStore("videos", { keyPath: "id" });
          s.createIndex("topicKey", "topicKey", { unique: false });
        }
        if (!d.objectStoreNames.contains("meta")) {
          d.createObjectStore("meta", { keyPath: "key" });
        }
        // v2: soru bazlı "çözüldü" durumu (soru paketinden bağımsız, ayrı store)
        if (!d.objectStoreNames.contains("progress")) {
          d.createObjectStore("progress", { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode) {
    return db.transaction(store, mode).objectStore(store);
  }
  function dbAll(store, indexName, value) {
    return new Promise((resolve, reject) => {
      const os = tx(store, "readonly");
      const src = indexName ? os.index(indexName) : os;
      const req = value !== undefined ? src.getAll(value) : src.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function dbPut(store, obj) {
    return new Promise((resolve, reject) => {
      const req = tx(store, "readwrite").put(obj);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
  function dbDelete(store, id) {
    return new Promise((resolve, reject) => {
      const req = tx(store, "readwrite").delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
  function metaGet(key, fallback) {
    return new Promise((resolve) => {
      const req = tx("meta", "readonly").get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : fallback);
      req.onerror = () => resolve(fallback);
    });
  }
  function metaSet(key, value) {
    return dbPut("meta", { key, value });
  }

  // ---------- Durum ----------
  const state = {
    subject: null,
    topic: null,
    tab: "questions",
    who: "O",
    qView: null,          // Sorular sekmesi: null → ızgara, soru id → odak pencere
    examDate: "2026-10-03"
  };
  const topicKey = (subject, topic) => subject + "||" + topic;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const esc = (s) => (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---------- Çözüldü (iki kişi: Keziban=turuncu, Gülcan=mavi, ikisi=yeşil) ----------
  const PEOPLE = [
    { key: "Keziban", label: "Keziban", cls: "kez" },
    { key: "Gulcan", label: "Gülcan", cls: "gul" }
  ];
  let progressById = {};   // soru id -> { id, solvedBy:{Keziban,Gulcan}, updatedAt }
  const getSolved = (id) => (progressById[id] && progressById[id].solvedBy) || {};
  function solvedClass(id) {
    const s = getSolved(id), k = !!s.Keziban, g = !!s.Gulcan;
    return k && g ? "both" : k ? "kez" : g ? "gul" : "";
  }
  async function setSolved(id, personKey, val) {
    const row = progressById[id] || { id, solvedBy: {} };
    row.solvedBy = Object.assign({}, row.solvedBy, { [personKey]: val });
    row.updatedAt = Date.now();
    progressById[id] = row;
    await dbPut("progress", row);
  }

  // ---------- Görsel küçültme ----------
  function fileToResizedDataURL(file, maxDim = 1400, quality = 0.82) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            const r = Math.min(maxDim / width, maxDim / height);
            width = Math.round(width * r);
            height = Math.round(height * r);
          }
          const canvas = document.createElement("canvas");
          canvas.width = width; canvas.height = height;
          canvas.getContext("2d").drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ---------- YouTube ----------
  function parseYouTube(url) {
    if (!url) return null;
    url = url.trim();
    let m;
    if ((m = url.match(/[?&]list=([\w-]+)/))) {
      // önce oynatma listesi (bir video da içerebilir ama listeyi önceliyoruz)
      const vid = (url.match(/[?&]v=([\w-]+)/) || [])[1];
      return { type: "playlist", id: m[1], videoId: vid || null };
    }
    if ((m = url.match(/youtu\.be\/([\w-]+)/))) return { type: "video", id: m[1] };
    if ((m = url.match(/[?&]v=([\w-]+)/))) return { type: "video", id: m[1] };
    if ((m = url.match(/youtube\.com\/embed\/([\w-]+)/))) return { type: "video", id: m[1] };
    if ((m = url.match(/youtube\.com\/shorts\/([\w-]+)/))) return { type: "video", id: m[1] };
    return null;
  }
  function ytEmbedSrc(parsed) {
    if (parsed.type === "playlist") return "https://www.youtube.com/embed/videoseries?list=" + parsed.id;
    return "https://www.youtube.com/embed/" + parsed.id;
  }

  // ---------- Elemanlar ----------
  const el = (id) => document.getElementById(id);
  const subjectBar = el("subjectBar");
  const topicList = el("topicList");
  const panel = el("panel");

  // ---------- Ders çubuğu ----------
  function renderSubjects() {
    subjectBar.innerHTML = "";
    Object.entries(window.SUBJECT_GROUPS).forEach(([group, subjects]) => {
      const label = document.createElement("span");
      label.className = "subject-group-label";
      label.textContent = group;
      subjectBar.appendChild(label);
      subjects.forEach((subj) => {
        const chip = document.createElement("button");
        chip.className = "subject-chip" + (subj === state.subject ? " active" : "");
        chip.textContent = subj;
        chip.onclick = () => selectSubject(subj);
        subjectBar.appendChild(chip);
      });
    });
  }

  async function counts(subject) {
    const [qs, vs] = await Promise.all([dbAll("questions"), dbAll("videos")]);
    const map = {};
    const add = (arr, k) => arr.forEach((x) => {
      if (x.subject !== subject) return;
      map[x.topic] = map[x.topic] || { q: 0, v: 0 };
      map[x.topic][k]++;
    });
    add(qs, "q"); add(vs, "v");
    return map;
  }

  async function renderTopics() {
    el("currentSubjectTitle").textContent = state.subject || "Konular";
    topicList.innerHTML = "";
    if (!state.subject) return;
    const cmap = await counts(state.subject);
    (window.SYLLABUS[state.subject] || []).forEach((topic) => {
      const li = document.createElement("li");
      li.className = "topic-item" + (topic === state.topic ? " active" : "");
      const c = cmap[topic] || { q: 0, v: 0 };
      const n = (notesData[topicKey(state.subject, topic)] || []).length;
      const badge = (c.q || c.v || n)
        ? `<span class="topic-badge">${c.q}📝 ${n}📌 ${c.v}🎬</span>` : "";
      li.innerHTML = `<span>${esc(topic)}</span>${badge}`;
      li.onclick = () => selectTopic(topic);
      topicList.appendChild(li);
    });
  }

  // ---------- Sunucudan konu bazlı yükleme ----------
  // Served over http(s) the app can fetch its own question packs, so there is nothing to
  // import by hand. On file:// fetch is blocked by CORS, so İçe Aktar stays the route.
  let manifest = null;
  let notesData = {};              // özgün bilgi notları (topicKey -> [{id,text}, ...])
  let analysisData = {};           // soru analizleri (soru id -> {catch, solve, relatedFactIds})
  let factById = {};               // hızlı arama: fact id -> {text, topicKey}

  async function loadManifest() {
    if (location.protocol === "file:") return null;
    try {
      const r = await fetch("data/manifest.json", { cache: "no-cache" });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { return null; }
  }

  async function loadNotes() {
    if (location.protocol === "file:") return {};   // fetch file:// üzerinde engelli
    try {
      const r = await fetch("data/notes.json", { cache: "no-cache" });
      if (!r.ok) return {};
      return (await r.json()).notes || {};
    } catch (e) { return {}; }
  }

  async function loadAnalysis() {
    if (location.protocol === "file:") return {};   // fetch file:// üzerinde engelli
    try {
      const r = await fetch("data/analysis.json", { cache: "no-cache" });
      if (!r.ok) return {};
      return (await r.json()).analysis || {};
    } catch (e) { return {}; }
  }

  // notesData'dan fact id -> {text, topicKey} indeksini kur (soru-bilgi bağlantısı için)
  function buildFactIndex() {
    factById = {};
    for (const [key, facts] of Object.entries(notesData)) {
      for (const f of facts) {
        if (f && f.id) factById[f.id] = { text: f.text, topicKey: key };
      }
    }
  }

  async function ensureSubjectLoaded(subject) {
    if (!manifest) return;
    const entry = (manifest.subjects || []).find((s) => s.subject === subject);
    if (!entry) return;
    const ver = manifest.version || 1;
    if ((await metaGet("loaded:" + subject, 0)) >= ver) return;
    panel.innerHTML = `<div class="empty"><p>⏳ <b>${esc(subject)}</b> soruları indiriliyor…</p>
      <p class="hint">${entry.count} soru • ${entry.mb} MB • yalnızca ilk seferde</p></div>`;
    try {
      const data = await (await fetch(entry.file)).json();
      await new Promise((res, rej) => {
        const tx = db.transaction("questions", "readwrite");
        const os = tx.objectStore("questions");
        for (const q of data.questions) os.put(q);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      await metaSet("loaded:" + subject, ver);
    } catch (err) {
      panel.innerHTML = `<div class="empty"><p class="danger-text">${esc(subject)} yüklenemedi.</p>
        <p class="hint">${esc(err.message)}</p></div>`;
    }
  }

  async function selectSubject(subj) {
    state.subject = subj;
    state.topic = null;
    document.body.classList.remove("mobile-content");   // back to the topic list
    renderSubjects();
    el("topicTitle").textContent = "Bir konu seç";
    el("breadcrumb").textContent = subj;
    el("tabs").hidden = true;
    el("toolbar").hidden = true;
    panel.innerHTML = `<div class="empty"><p>👈 <b>${esc(subj)}</b> için bir konu seç.</p></div>`;
    await ensureSubjectLoaded(subj);
    renderTopics();
    if (!state.topic && state.subject === subj) {
      panel.innerHTML = `<div class="empty"><p>👈 <b>${esc(subj)}</b> için bir konu seç.</p></div>`;
    }
  }

  function selectTopic(topic) {
    state.topic = topic;
    state.tab = "questions";
    state.qView = null;   // her yeni konuda soru ızgarasıyla başla
    // On phones only one pane is on screen; switch to the questions view.
    document.body.classList.add("mobile-content");
    renderTopics();
    el("topicTitle").textContent = topic;
    el("breadcrumb").textContent = state.subject + " › " + topic;
    el("tabs").hidden = false;
    el("toolbar").hidden = false;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === "questions"));
    renderContent();
  }

  // ---------- İçerik ----------
  async function renderContent() {
    if (!state.topic) return;
    const key = topicKey(state.subject, state.topic);
    const [qs, vs] = await Promise.all([
      dbAll("questions", "topicKey", key),
      dbAll("videos", "topicKey", key)
    ]);
    const facts = notesData[key] || [];
    el("qCount").textContent = qs.length;
    el("vCount").textContent = vs.length;
    el("nCount").textContent = facts.length;
    el("addQuestionBtn").hidden = state.tab !== "questions";
    el("addVideoBtn").hidden = state.tab !== "videos";

    panel.innerHTML = "";
    if (state.tab === "notes") { renderNotes(facts); return; }

    if (state.tab === "questions") {
      if (qs.length === 0) {
        panel.innerHTML = `<div class="empty"><p>Bu konuda henüz soru yok.</p>
          <p class="hint">Yukarıdaki <b>+ Soru Ekle</b> ile başla.</p></div>`;
        return;
      }
      qs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));  // sabit sınav sırası
      if (state.qView && qs.some((q) => q.id === state.qView)) renderQuestionFocus(qs);
      else { state.qView = null; renderQuestionGrid(qs); }
      return;
    }

    // videolar
    if (vs.length === 0) {
      panel.innerHTML = `<div class="empty"><p>Bu konuda henüz video yok.</p>
        <p class="hint">Yukarıdaki <b>+ Video Ekle</b> ile başla.</p></div>`;
      return;
    }
    vs.sort((a, b) => b.createdAt - a.createdAt);
    vs.forEach(renderVideoCard);
  }

  // Soru numarasını ref'ten al ("… SORU 12" → "12"); yoksa boş.
  const qNo = (q) => ((q.ref || "").match(/SORU\s*(\d+)/i) || [])[1] || "";

  // ---------- Soru ızgarası (küçük görseller + çözüldü renkleri) ----------
  function renderQuestionGrid(qs) {
    const n = qs.length;
    let kez = 0, gul = 0, both = 0;
    qs.forEach((q) => { const c = solvedClass(q.id); if (c === "both") both++; else if (c === "kez") kez++; else if (c === "gul") gul++; });
    const head = document.createElement("div");
    head.className = "grid-head";
    head.innerHTML = `
      <div class="grid-summary">
        <span class="chip chip-kez">Keziban ${kez + both}</span>
        <span class="chip chip-gul">Gülcan ${gul + both}</span>
        <span class="chip chip-both">İkisi ${both}</span>
        <span class="grid-total">${n} soru</span>
      </div>
      <p class="grid-legend">Dokun → soruyu çöz. Renk: <b class="lg lg-kez">Keziban</b> · <b class="lg lg-gul">Gülcan</b> · <b class="lg lg-both">ikisi</b></p>`;
    panel.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "q-grid";
    qs.forEach((q, i) => {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "q-cell " + solvedClass(q.id);
      cell.title = q.ref || ("Soru " + (i + 1));
      cell.innerHTML = `
        <span class="q-cell-no">${i + 1}</span>
        ${q.image ? `<img src="${q.image}" alt="" loading="lazy">` : `<span class="q-cell-txt">${esc((q.text || "").slice(0, 40))}</span>`}
        <span class="q-cell-dot"></span>`;
      cell.onclick = () => { state.qView = q.id; renderContent(); window.scrollTo(0, 0); };
      grid.appendChild(cell);
    });
    panel.appendChild(grid);
  }

  // ---------- Odak pencere: tek soru + gezinme + çözüldü ----------
  function renderQuestionFocus(qs) {
    const idx = qs.findIndex((q) => q.id === state.qView);
    const q = qs[idx];
    const nav = document.createElement("div");
    nav.className = "focus-nav";
    nav.innerHTML = `
      <button type="button" class="btn ghost small f-back">‹ Sorular</button>
      <span class="f-pos">${idx + 1} / ${qs.length}</span>
      <span class="f-move">
        <button type="button" class="btn ghost small f-prev"${idx <= 0 ? " disabled" : ""}>‹ Önceki</button>
        <button type="button" class="btn ghost small f-next"${idx >= qs.length - 1 ? " disabled" : ""}>Sonraki ›</button>
      </span>`;
    panel.appendChild(nav);
    nav.querySelector(".f-back").onclick = () => { state.qView = null; renderContent(); window.scrollTo(0, 0); };
    nav.querySelector(".f-prev").onclick = () => { if (idx > 0) { state.qView = qs[idx - 1].id; renderContent(); window.scrollTo(0, 0); } };
    nav.querySelector(".f-next").onclick = () => { if (idx < qs.length - 1) { state.qView = qs[idx + 1].id; renderContent(); window.scrollTo(0, 0); } };

    renderQuestionCard(q);   // görsel+highlight, hızlı cevap, adım adım çöz, ilgili bilgi

    const bar = document.createElement("div");
    bar.className = "solved-bar";
    bar.innerHTML = `<span class="solved-label">Çözdüm:</span>` + PEOPLE.map((p) => {
      const on = !!getSolved(q.id)[p.key];
      return `<button type="button" class="solved-btn ${p.cls}${on ? " on" : ""}" data-person="${p.key}">
        ${on ? "✓" : "○"} ${esc(p.label)} çözdü</button>`;
    }).join("");
    panel.appendChild(bar);
    PEOPLE.forEach((p) => {
      const btn = bar.querySelector(`.solved-btn[data-person="${p.key}"]`);
      btn.onclick = async () => {
        const now = !getSolved(q.id)[p.key];
        await setSolved(q.id, p.key, now);
        btn.classList.toggle("on", now);
        btn.textContent = `${now ? "✓" : "○"} ${p.label} çözdü`;
      };
    });
  }

  // **kalın** işaretlerini güvenle <strong>'a çevirir (önce kaçış, sonra biçim)
  function fmtNote(s) {
    return esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }

  function renderNotes(facts) {
    if (!facts.length) {
      panel.innerHTML = `<div class="empty"><p>Bu konu için bilgi notu henüz eklenmedi.</p>
        <p class="hint">Notlar konu konu ekleniyor.</p></div>`;
      return;
    }
    const card = document.createElement("div");
    card.className = "card notes-card";
    card.innerHTML = `<div class="card-top"><span class="card-tag">📌 Bilgi Notları</span></div>
      <ul class="notes-list">${facts.map((f) => `<li>${fmtNote(f.text)}</li>`).join("")}</ul>`;
    panel.appendChild(card);
  }

  // Adım ya düz metin ("...") ya da nesne ({text, rect?|rects?}) olabilir.
  const stepText = (s) => (typeof s === "string" ? s : (s && s.text) || "");
  // rect/rects'i [[x,y,w,h], ...] (yüzde) dizisine normalize et.
  function stepRects(s) {
    if (!s || typeof s === "string") return [];
    if (Array.isArray(s.rects)) return s.rects.filter((r) => Array.isArray(r) && r.length === 4);
    if (Array.isArray(s.rect) && s.rect.length === 4) return [s.rect];
    return [];
  }

  // İnteraktif adım adım çözüm iskeleti (spoiler-safe: panel gizli başlar).
  // Adımlar `wireSolve` ile tıklandıkça birer birer, üst üste (stack) açılır.
  function solveHtml(q) {
    const steps = (analysisData[q.id] || {}).steps || [];
    if (!steps.length) return "";
    return `<div class="solve-box">
      <button type="button" class="solve-start">🧩 Adım adım çöz</button>
      <div class="solve-panel" hidden>
        <ol class="solve-steps"></ol>
        <div class="solve-related" hidden></div>
        <div class="solve-controls">
          <button type="button" class="solve-next">Sonraki ipucu →</button>
          <button type="button" class="solve-all">Hepsini göster</button>
          <span class="solve-progress"></span>
        </div>
      </div>
    </div>`;
  }

  // Çözüm kutusunu işlevsel hale getir: adımları sırayla ekle, ilgili görsel bölgesini işaretle.
  function wireSolve(card, q) {
    const box = card.querySelector(".solve-box");
    if (!box) return;
    const a = analysisData[q.id] || {};
    const steps = a.steps || [];
    const rectsByStep = steps.map(stepRects);
    const related = (a.relatedFactIds || []).map((id) => factById[id]).filter(Boolean);
    const startBtn = box.querySelector(".solve-start");
    const panel = box.querySelector(".solve-panel");
    const list = box.querySelector(".solve-steps");
    const relBox = box.querySelector(".solve-related");
    const nextBtn = box.querySelector(".solve-next");
    const allBtn = box.querySelector(".solve-all");
    const prog = box.querySelector(".solve-progress");
    const figure = card.querySelector(".q-figure");
    const hlLayer = figure ? figure.querySelector(".q-hl-layer") : null;
    let shown = 0;

    // Görselde yalnız verilen bölgeleri (yüzde) çerçevele; öncekileri temizle.
    function setHighlight(rects) {
      if (!hlLayer) return;
      hlLayer.innerHTML = "";
      (rects || []).forEach(([x, y, w, h]) => {
        const b = document.createElement("div");
        b.className = "q-hl";
        b.style.cssText = `left:${x}%;top:${y}%;width:${w}%;height:${h}%`;
        hlLayer.appendChild(b);
      });
    }
    // i. adımı aktif yap: bölgesini işaretle, satırı vurgula, dar ekranda görseli göster.
    function activate(i) {
      list.querySelectorAll(".solve-steps > li").forEach((el) => el.classList.toggle("active", +el.dataset.idx === i));
      setHighlight(rectsByStep[i]);
      if (figure && rectsByStep[i].length && window.matchMedia("(max-width: 819px)").matches) {
        figure.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }

    const finish = () => {
      if (box.dataset.done) return;
      box.dataset.done = "1";
      if (related.length) {
        relBox.innerHTML = `<span class="analysis-label">📌 İlgili Bilgi</span>
          <ul class="notes-list">${related.map((f) => `<li>${fmtNote(f.text)}</li>`).join("")}</ul>`;
        relBox.hidden = false;
      }
      nextBtn.hidden = true;
      allBtn.hidden = true;
      prog.textContent = "✓ Çözüm tamamlandı";
      prog.classList.add("done");
    };
    const revealOne = () => {
      if (shown >= steps.length) return;
      const idx = shown;
      const li = document.createElement("li");
      li.dataset.idx = idx;
      li.innerHTML = fmtNote(stepText(steps[idx]));
      if (rectsByStep[idx].length) li.classList.add("has-rect");
      li.onclick = () => activate(idx);   // açılmış adıma dokununca bölgesi geri gelir
      list.appendChild(li);
      shown++;
      activate(idx);
      if (shown >= steps.length) finish();
      else prog.textContent = shown + " / " + steps.length;
    };

    startBtn.onclick = () => {
      startBtn.hidden = true;
      panel.hidden = false;
      card.classList.add("solving");      // görseli sabitle (sticky)
      revealOne();
    };
    nextBtn.onclick = revealOne;
    allBtn.onclick = () => { while (shown < steps.length) revealOne(); };  // son adımda kalır (aktif = son)
  }

  function whoBadge(who) {
    const label = who === "O" ? "O 💗" : (who || "Ben");
    return `<span class="who-badge">${esc(label)}</span>`;
  }

  function renderQuestionCard(q) {
    const card = document.createElement("div");
    card.className = "card";
    let html = `<div class="card-top"><span class="card-tag">📝 Soru ${whoBadge(q.who)}</span></div>`;
    if (q.image) html += `<figure class="q-figure"><img class="q-image" src="${q.image}" alt="soru" data-full="${q.image}"><div class="q-hl-layer" aria-hidden="true"></div></figure>`;
    if (q.text) html += `<div class="q-text">${esc(q.text)}</div>`;
    // Analiz overlay'i hatalı bir cevap anahtarını düzeltebilir (büyük paketi yeniden indirmeden).
    const ansOverride = (analysisData[q.id] || {}).answer;
    const answer = ansOverride || q.answer;
    if (answer) html += `<div class="answer-box hidden-answer" title="Cevabı görmek için tıkla"><b>Cevap:</b> ${esc(answer)}</div>`;
    html += solveHtml(q);
    if (q.notes) html += `<div class="note-box">🗒️ ${esc(q.notes)}</div>`;
    if (q.ref) html += `<div class="q-ref">${esc(q.ref)}</div>`;
    html += `<div class="card-actions">
      <button class="btn ghost small" data-move>↔ Konu Değiştir</button>
      <button class="btn ghost small danger-text" data-del>Sil</button>
    </div>`;
    card.innerHTML = html;
    const img = card.querySelector(".q-image");
    if (img) img.onclick = () => openLightbox(img.dataset.full);
    const ans = card.querySelector(".answer-box");
    if (ans) ans.onclick = () => ans.classList.toggle("hidden-answer");
    wireSolve(card, q);
    card.querySelector("[data-move]").onclick = () => openMover(card, q);
    card.querySelector("[data-del]").onclick = async () => {
      if (!confirm("Bu soru silinsin mi?")) return;
      await dbDelete("questions", q.id);
      renderContent(); renderTopics();
    };
    panel.appendChild(card);
  }

  function renderVideoCard(v) {
    const card = document.createElement("div");
    card.className = "card video-card";
    const parsed = { type: v.ytType, id: v.ytId };
    card.innerHTML = `
      <div class="card-top"><span class="card-tag">🎬 Video ${whoBadge(v.who)}</span></div>
      <iframe src="${ytEmbedSrc(parsed)}" allowfullscreen loading="lazy"></iframe>
      <div class="video-meta">
        ${v.title ? `<h4>${esc(v.title)}</h4>` : ""}
        ${v.notes ? `<div class="note-box">🗒️ ${esc(v.notes)}</div>` : ""}
        <div class="card-actions">
          <a class="btn ghost small" href="${esc(v.url)}" target="_blank" rel="noopener">YouTube'da Aç ↗</a>
          <button class="btn ghost small danger-text" data-del>Sil</button>
        </div>
      </div>`;
    card.querySelector("[data-del]").onclick = async () => {
      if (!confirm("Bu video silinsin mi?")) return;
      await dbDelete("videos", v.id);
      renderContent(); renderTopics();
    };
    panel.appendChild(card);
  }

  function openLightbox(src) {
    el("lightboxImg").src = src;
    el("lightbox").hidden = false;
  }

  // Move a question to a different subject/topic (fixes stray tags without re-import)
  function openMover(card, q) {
    if (card.querySelector(".mover")) return;
    const subjects = Object.values(window.SUBJECT_GROUPS).flat();
    const subjOpts = subjects.map((s) =>
      `<option value="${esc(s)}"${s === q.subject ? " selected" : ""}>${esc(s)}</option>`).join("");
    const div = document.createElement("div");
    div.className = "mover";
    div.innerHTML = `
      <span class="mover-label">Taşı →</span>
      <select class="mv-subject">${subjOpts}</select>
      <select class="mv-topic"></select>
      <button class="btn primary small mv-save">Kaydet</button>
      <button class="btn ghost small mv-cancel">İptal</button>`;
    card.appendChild(div);
    const subjSel = div.querySelector(".mv-subject");
    const topSel = div.querySelector(".mv-topic");
    const fillTopics = (subject, selected) => {
      topSel.innerHTML = (window.SYLLABUS[subject] || []).map((t) =>
        `<option value="${esc(t)}"${t === selected ? " selected" : ""}>${esc(t)}</option>`).join("");
    };
    fillTopics(q.subject, q.topic);
    subjSel.onchange = () => fillTopics(subjSel.value, null);
    div.querySelector(".mv-cancel").onclick = () => div.remove();
    div.querySelector(".mv-save").onclick = async () => {
      const ns = subjSel.value, nt = topSel.value;
      if (!nt) return;
      q.subject = ns; q.topic = nt; q.topicKey = topicKey(ns, nt);
      await dbPut("questions", q);
      renderContent(); renderTopics();
    };
  }

  // ---------- Soru modalı ----------
  let pendingImage = null;
  function openQuestionModal() {
    if (!state.topic) return;
    pendingImage = null;
    el("qImageInput").value = "";
    el("qText").value = ""; el("qAnswer").value = ""; el("qNotes").value = "";
    el("qImagePreviewWrap").hidden = true;
    el("questionModal").hidden = false;
  }
  el("qImageInput").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    pendingImage = await fileToResizedDataURL(file);
    el("qImagePreview").src = pendingImage;
    el("qImagePreviewWrap").hidden = false;
  };
  el("qImageClear").onclick = () => {
    pendingImage = null;
    el("qImageInput").value = "";
    el("qImagePreviewWrap").hidden = true;
  };
  el("qSaveBtn").onclick = async () => {
    const text = el("qText").value.trim();
    if (!pendingImage && !text) { alert("En az bir fotoğraf ya da soru metni ekle."); return; }
    await dbPut("questions", {
      id: uid(),
      subject: state.subject, topic: state.topic, topicKey: topicKey(state.subject, state.topic),
      image: pendingImage, text,
      answer: el("qAnswer").value.trim(),
      notes: el("qNotes").value.trim(),
      who: state.who, createdAt: Date.now()
    });
    el("questionModal").hidden = true;
    renderContent(); renderTopics();
  };

  // ---------- Video modalı ----------
  function openVideoModal() {
    if (!state.topic) return;
    el("vUrl").value = ""; el("vTitle").value = ""; el("vNotes").value = "";
    el("vHint").textContent = "";
    el("videoModal").hidden = false;
  }
  el("vUrl").oninput = () => {
    const p = parseYouTube(el("vUrl").value);
    el("vHint").textContent = p
      ? (p.type === "playlist" ? "✔ Oynatma listesi algılandı." : "✔ Video algılandı.")
      : (el("vUrl").value ? "⚠ Geçerli bir YouTube bağlantısı görünmüyor." : "");
  };
  el("vSaveBtn").onclick = async () => {
    const url = el("vUrl").value.trim();
    const p = parseYouTube(url);
    if (!p) { alert("Geçerli bir YouTube bağlantısı yapıştır."); return; }
    await dbPut("videos", {
      id: uid(),
      subject: state.subject, topic: state.topic, topicKey: topicKey(state.subject, state.topic),
      url, ytType: p.type, ytId: p.id,
      title: el("vTitle").value.trim(),
      notes: el("vNotes").value.trim(),
      who: state.who, createdAt: Date.now()
    });
    el("videoModal").hidden = true;
    renderContent(); renderTopics();
  };

  // ---------- Dışa / İçe aktarma ----------
  async function exportData() {
    const [questions, videos, progress] = await Promise.all([dbAll("questions"), dbAll("videos"), dbAll("progress")]);
    const blob = new Blob([JSON.stringify({ app: "kpss_onlisans", version: 2, exportedAt: Date.now(), questions, videos, progress }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "kpss-yedek-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  }
  async function importData(file) {
    const data = JSON.parse(await file.text());
    if (!data || data.app !== "kpss_onlisans") throw new Error(file.name + ": bu uygulamaya ait bir dosya değil");
    let added = 0;
    for (const q of (data.questions || [])) { if (q && q.id) { await dbPut("questions", q); added++; } }
    for (const v of (data.videos || [])) { if (v && v.id) { await dbPut("videos", v); added++; } }
    // Çözüldü durumu: iki kişinin işaretleri BİRLEŞİR (OR) — biri diğerini silmez.
    for (const p of (data.progress || [])) {
      if (!p || !p.id) continue;
      const cur = progressById[p.id] || { id: p.id, solvedBy: {}, updatedAt: 0 };
      const a = cur.solvedBy || {}, b = p.solvedBy || {};
      const merged = {
        id: p.id,
        solvedBy: { Keziban: !!(a.Keziban || b.Keziban), Gulcan: !!(a.Gulcan || b.Gulcan) },
        updatedAt: Math.max(cur.updatedAt || 0, p.updatedAt || 0)
      };
      progressById[p.id] = merged;
      await dbPut("progress", merged);
      added++;
    }
    return added;
  }
  async function importFiles(files) {
    let total = 0, ok = 0, errors = [];
    for (const f of files) {
      try { total += await importData(f); ok++; }
      catch (err) { errors.push(err.message); }
    }
    let msg = ok + " dosyadan toplam " + total + " kayıt içe aktarıldı.";
    if (errors.length) msg += "\n\nAtlanan: " + errors.join("\n");
    alert(msg);
    renderTopics(); if (state.topic) renderContent();
  }

  // ---------- Geri sayım ----------
  function updateCountdown() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const exam = new Date(state.examDate + "T00:00:00");
    const diff = Math.round((exam - today) / 86400000);
    el("cdNum").textContent = diff >= 0 ? diff : "0";
    el("countdown").title = "Sınav: " + state.examDate + " (değiştirmek için tıkla)";
  }

  // ---------- Olaylar ----------
  document.querySelectorAll(".tab").forEach((t) => {
    t.onclick = () => {
      state.tab = t.dataset.tab;
      state.qView = null;   // sekme değişince soru ızgarasına dön
      document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
      renderContent();
    };
  });
  el("addQuestionBtn").onclick = openQuestionModal;
  el("addVideoBtn").onclick = openVideoModal;
  el("backBtn").onclick = () => {
    document.body.classList.remove("mobile-content");
    window.scrollTo(0, 0);
  };
  document.querySelectorAll("[data-close]").forEach((b) => b.onclick = () => {
    el("questionModal").hidden = true; el("videoModal").hidden = true;
  });
  document.querySelectorAll(".overlay").forEach((o) => o.addEventListener("click", (e) => {
    if (e.target === o) o.hidden = true;
  }));
  el("lightbox").onclick = () => { el("lightbox").hidden = true; };
  el("exportBtn").onclick = exportData;
  el("importBtn").onclick = () => el("importFile").click();
  el("importFile").onchange = (e) => { if (e.target.files.length) importFiles([...e.target.files]); e.target.value = ""; };

  el("whoSelect").onchange = async (e) => { state.who = e.target.value; await metaSet("who", state.who); };

  el("countdown").onclick = async () => {
    const v = prompt("Sınav tarihi (YYYY-AA-GG):", state.examDate);
    if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      state.examDate = v; await metaSet("examDate", v); updateCountdown();
    } else if (v) {
      alert("Tarih formatı: 2026-10-03 gibi olmalı.");
    }
  };

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      el("questionModal").hidden = true; el("videoModal").hidden = true; el("lightbox").hidden = true;
    }
  });

  // ---------- Başlat ----------
  (async function init() {
    try {
      db = await openDB();
    } catch (err) {
      alert("Veritabanı açılamadı. Lütfen Chrome/Edge ile açmayı dene.\n\n" + err);
      return;
    }
    state.who = await metaGet("who", "O");
    state.examDate = await metaGet("examDate", "2026-10-03");
    el("whoSelect").value = state.who;
    updateCountdown();
    setInterval(updateCountdown, 3600000);
    [manifest, notesData, analysisData] = await Promise.all([loadManifest(), loadNotes(), loadAnalysis()]);
    buildFactIndex();
    (await dbAll("progress")).forEach((r) => { progressById[r.id] = r; });
    renderSubjects();
    // ilk dersi otomatik seç
    await selectSubject(window.SUBJECT_GROUPS["Genel Yetenek"][0]);
  })();
})();
