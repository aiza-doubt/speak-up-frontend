/* Speak Up - OpenAI adapter
 * Plugs real AI into the existing website WITHOUT changing its design or features.
 * The website asks for "sample" (AI text), "dictation" (microphone -> text) and "tts" (voice).
 * Here those three are provided by this site's own backend (/api/...), which talks to OpenAI.
 * "db" and "user" are left empty on purpose: the site then saves progress in this browser, as before.
 */
(function () {
  "use strict";
  // Address of the backend (set in config.js). Empty = same website.
  var API = String(window.SPEAKUP_API || "").replace(/\/+$/, "");
  var SILENT = "data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";

  function postJSON(url, body, ms) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, ms || 100000);
    return fetch(API + url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: ctl.signal,
    }).finally(function () { clearTimeout(timer); });
  }
  function codeFromStatus(res, fallback) {
    if (res.status === 429) return "rate_limited";
    if (res.status === 503) return "not_granted";       // key missing/rejected -> the site shows "AI not available"
    return fallback;
  }

  /* ---------- AI text: conversation partner, feedback reports, live tips, word meanings ---------- */
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function retryable(e) { return !e || !e.code || e.code === "ai_unavailable" || e.code === "unknown"; }
  var sample = function (prompt, opts) {
    var messages = typeof prompt === "string" ? [{ role: "user", content: prompt }] : prompt;
    function once() {
      return postJSON("/api/chat", { messages: messages, tier: (opts && opts.modelTier) || "default" })
        .then(function (res) {
          if (!res.ok) throw { code: codeFromStatus(res, "ai_unavailable") };
          return res.json();
        })
        .then(function (j) { return { text: j.text || "" }; })
        .catch(function (e) { throw e && e.code ? e : { code: "ai_unavailable" }; });
    }
    return once().catch(function (e) {                      // one automatic retry (a sleeping server wakes up)
      if (!retryable(e)) throw e;
      return wait(3000).then(once);
    });
  };

  /* ---------- microphone -> text ---------- */
  var dictation = (function () {
    var L = { partial: [], final: [], state: [] };
    var emit = function (k, v) { L[k].slice().forEach(function (f) { try { f(v); } catch (e) {} }); };
    var epoch = 0;        // increases with every Start; results of an older (deleted) take are ignored
    var cur = null;       // the current take: { epoch, rec, stream, chunks, mime, starting, finishing }

    function pickMime() {
      var c = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
      for (var i = 0; i < c.length; i++) {
        try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(c[i])) return c[i]; } catch (e) {}
      }
      return "";
    }
    function fileName(type) {
      return /mp4/.test(type) ? "speech.mp4" : /ogg/.test(type) ? "speech.ogg" : "speech.webm";
    }
    function release(take) {
      if (take.stream) { take.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); }
      take.stream = null; take.rec = null;
    }
    function transcribeOnce(blob, mime) {
      var fd = new FormData();
      fd.append("audio", blob, fileName(blob.type || mime));
      var ctl = new AbortController();
      var timer = setTimeout(function () { ctl.abort(); }, 120000);
      return fetch(API + "/api/transcribe", { method: "POST", body: fd, signal: ctl.signal }).then(function (res) {
        if (!res.ok) throw { code: codeFromStatus(res, res.status >= 500 ? "unknown" : "bad") };
        return res.json();
      }).then(function (j) { return (j.text || "").trim(); },
              function (e) { throw e && e.code ? e : { code: "unknown" }; })
        .finally(function () { clearTimeout(timer); });
    }
    // The recording is kept in memory and re-sent a couple of times if the server is waking up.
    function transcribe(blob, mime) {
      var tries = 0;
      function go() {
        return transcribeOnce(blob, mime).catch(function (e) {
          if (++tries < 3 && e && e.code === "unknown") return wait(tries * 3000).then(go);
          throw e;
        });
      }
      return go();
    }
    function notify(e) {
      try {
        if (typeof toast === "function" && typeof t === "function") {
          var k = e && e.code === "rate_limited" ? "err.rate_limited" : e && e.code === "not_granted" ? "err.stt_not_configured" : "err.stt_unavailable";
          toast(t(k), "error");
        }
      } catch (x) {}
    }
    // Stop this take's recorder, send its audio, deliver the text as one "final" piece. Safe to call twice.
    function finish(take) {
      if (take.finishing) return take.finishing;
      take.finishing = take.starting.then(function () {
        if (!take.rec || take.rec.state === "inactive") { release(take); return; }
        return new Promise(function (done) {
          take.rec.onstop = done;
          try { take.rec.stop(); } catch (e) { done(); }
        }).then(function () {
          var blob = new Blob(take.chunks, { type: take.mime || "audio/webm" });
          take.chunks = []; release(take);
          if (blob.size < 1500) return;                       // nothing was said
          return transcribe(blob, take.mime).then(function (text) {
            if (take.epoch !== epoch) return;                  // that take was deleted: ignore its text
            if (text) emit("final", { text: text });
          }).catch(function (e) { if (take.epoch === epoch) notify(e); });
        });
      }, function () { release(take); });
      return take.finishing;
    }
    // The phone/tab took the microphone away (call, app switch, lock screen): keep what was said.
    function interrupted(take, reason) {
      if (take.finishing || take !== cur) return;
      finish(take).catch(function () {}).then(function () {
        if (take.epoch === epoch) emit("state", { state: "idle", reason: reason });
      });
    }

    return {
      // Must be called straight from a tap so the browser shows the microphone permission prompt.
      start: function () {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
          return Promise.reject({ code: "unknown" });
        }
        var take = { epoch: ++epoch, rec: null, stream: null, chunks: [], mime: pickMime(), starting: null, finishing: null };
        cur = take;
        take.starting = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
          .then(function (s) {
            take.stream = s;
            var opts = { audioBitsPerSecond: 32000 };
            if (take.mime) opts.mimeType = take.mime;
            var rec = new MediaRecorder(s, opts);
            take.rec = rec;
            if (!take.mime) take.mime = rec.mimeType || "";
            rec.ondataavailable = function (e) { if (e.data && e.data.size) take.chunks.push(e.data); };
            rec.onerror = function () { interrupted(take, "interrupted"); };
            s.getTracks().forEach(function (t) { t.onended = function () { interrupted(take, "interrupted"); }; });
            rec.start(1000);
          })
          .catch(function (e) {
            var name = e && e.name;
            throw { code: name === "NotAllowedError" || name === "SecurityError" ? "not_granted" : "unknown" };
          });
        return take.starting;
      },
      // Pause and Stop both end the current recording and deliver its text; Resume starts a new one.
      stop: function () {
        if (!cur) return Promise.resolve();
        return finish(cur).then(function () {}, function () {});
      },
      onPartial: function (f) { L.partial.push(f); },
      onFinal: function (f) { L.final.push(f); },
      onState: function (f) { L.state.push(f); },
      _hidden: function () { if (cur && cur.rec && cur.rec.state === "recording") interrupted(cur, "hidden"); },
    };
  })();
  // iPad/iPhone stop the microphone when the page goes to the background.
  document.addEventListener("visibilitychange", function () { if (document.hidden) dictation._hidden(); });

  /* ---------- English voice (replies, vocabulary) ---------- */
  function makeVoice(useOpenAI) {
    var L = [], audio = null, resolveNow = null, current = 0;
    var emit = function (s) { L.forEach(function (f) { try { f({ state: s }); } catch (e) {} }); };
    function unlock() {                                     // iOS only plays audio after a tap
      if (!useOpenAI) return;
      audio = audio || new Audio();
      audio.src = SILENT; audio.play().catch(function () {});
    }
    document.addEventListener("pointerdown", function once() {
      unlock(); document.removeEventListener("pointerdown", once, true);
    }, true);

    function englishVoice() {
      var v = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
      return v.find(function (x) { return /^en[-_]US/i.test(x.lang); }) || v.find(function (x) { return /^en/i.test(x.lang); }) || null;
    }
    function browserSpeak(text) {
      return new Promise(function (resolve) {
        var u = new SpeechSynthesisUtterance(text);
        var v = englishVoice(); if (v) u.voice = v;
        u.lang = (v && v.lang) || "en-US"; u.rate = 0.95;
        resolveNow = resolve;
        u.onend = u.onerror = function () { resolveNow = null; resolve(); };
        speechSynthesis.cancel(); speechSynthesis.speak(u);
      });
    }
    function openaiSpeak(text) {
      return postJSON("/api/tts", { text: text }, 30000).then(function (res) {
        if (!res.ok) throw new Error("tts");
        return res.blob();
      }).then(function (blob) {
        return new Promise(function (resolve, reject) {
          var url = URL.createObjectURL(blob);
          audio = audio || new Audio();
          resolveNow = function () { URL.revokeObjectURL(url); resolve(); };
          audio.onended = audio.onerror = function () { resolveNow = null; URL.revokeObjectURL(url); resolve(); };
          audio.src = url;
          audio.play().catch(reject);
        });
      });
    }
    return {
      speak: function (text) {
        var id = ++current;
        this.stop(true);
        emit("speaking");
        var run = useOpenAI
          ? openaiSpeak(text).catch(function () { return window.speechSynthesis ? browserSpeak(text) : undefined; })
          : browserSpeak(text);
        return run.then(function () { if (id === current) emit("idle"); });
      },
      stop: function (quiet) {
        try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch (e) {}
        try { if (audio) { audio.pause(); } } catch (e) {}
        if (resolveNow) { var r = resolveNow; resolveNow = null; r(); }
        if (!quiet) emit("idle");
      },
      onState: function (f) { L.push(f); },
    };
  }

  /* ---------- what the website receives ---------- */
  // Ask the backend what is switched on. A sleeping free server can be slow, so wait up to 12 s,
  // then assume it is on: real problems then show up as clear messages when a feature is used.
  var health = Promise.race([
    fetch(API + "/api/health").then(function (r) { if (!r.ok) throw 0; return r.json(); }),
    new Promise(function (_, no) { setTimeout(no, 12000); }),
  ]).catch(function () { return { ai: true, stt: true, tts: false }; });
  var hasMic = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  var hasBrowserVoice = !!(window.speechSynthesis && window.SpeechSynthesisUtterance);

  window.claude = {
    use: function (name) {
      if (name === "sample") return health.then(function (h) { return h.ai ? sample : null; });
      if (name === "dictation") return health.then(function (h) { return h.stt && hasMic ? dictation : null; });
      if (name === "tts") return health.then(function (h) {
        if (h.tts) return makeVoice(true);
        return hasBrowserVoice ? makeVoice(false) : null;
      });
      return Promise.resolve(null);                         // "db" and "user": progress stays in this browser
    },
  };
})();
