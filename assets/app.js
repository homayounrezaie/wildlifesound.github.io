"use strict";

  /* ── Scroll-reveal observer ──────────────────────────────────── */
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in-view'); revealObserver.unobserve(e.target); } });
  }, { threshold: 0.12 });
  document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));

  /* ================================================================
     CONSTANTS
  ================================================================ */
  const MAX_RECORDING_SECONDS = 60;

  /* ================================================================
     APPLICATION STATE
  ================================================================ */
  let mediaRecorder     = null;
  let audioChunks       = [];
  let audioCtx          = null;
  let analyserNode      = null;
  let rafId             = null;
  let recordingTimer    = null;
  let isRecording       = false;
  let isProcessing      = false;
  let detectedSpecies   = [];
  let replayAudio       = null;
  let replayObjectURL   = null;
  let lastSignalUpdate  = 0;

  // Live chunk detection state
  let liveResultsMap    = new Map();  // key: 'model::name' → species obj
  let chunkWindowChunks = [];          // audio chunks for current 10s window
  let chunkIntervalId   = null;        // setInterval handle
  let chunkLastAt       = 0;           // performance.now() when last chunk was sent
  let chunkElapsedAt    = 0;           // recording seconds when last chunk was sent
  let chunkMime         = '';          // mime type of recording
  const activeChunkAnalyses = new Set();

  /* ================================================================
     DOM REFS (resolved once after DOMContentLoaded)
  ================================================================ */
  const $ = id => document.getElementById(id);

  /* ================================================================
     HELPERS — HTML escaping
  ================================================================ */
  function esc(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
  }

  /* ================================================================
     OFFLINE DETECTION
  ================================================================ */
  function updateOnlineStatus() {
    $('offline-banner').classList.toggle('visible', !navigator.onLine);
  }

  /* ================================================================
     TOAST
  ================================================================ */
  function toast(msg, type = 'success', ms = 4500) {
    const wrap = $('toast-container');
    const el   = document.createElement('div');
    el.className = 'toast' + (type === 'error' ? ' error' : '');
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => {
      el.style.animation = 'toastOut .3s ease-out forwards';
      setTimeout(() => el.remove(), 310);
    }, ms);
  }

  /* ================================================================
     SPECTROGRAM (scrolling waterfall)
  ================================================================ */
  function resizeCanvas() {
    const c = $('waveform-canvas');
    c.width  = c.offsetWidth;
    c.height = c.offsetHeight || 110;
  }

  function drawSpectrogram() {
    if (!analyserNode) return;
    const canvas = $('waveform-canvas');
    const ctx    = canvas.getContext('2d');
    analyserNode.fftSize = 4096;
    const bufLen     = analyserNode.frequencyBinCount;
    const buf        = new Uint8Array(bufLen);
    const timeBuf    = new Uint8Array(bufLen);
    // Show lower ~60% of freq range — where most wildlife sounds live (0–8kHz)
    const displayBins = Math.floor(bufLen * 0.6);

    function frame() {
      rafId = requestAnimationFrame(frame);
      analyserNode.getByteFrequencyData(buf);
      const now = performance.now();
      if (now - lastSignalUpdate > 800 && isRecording) {
        analyserNode.getByteTimeDomainData(timeBuf);
        const quality = signalQualityFromBuffer(timeBuf);
        setPanelStatus(quality.label, quality.mode);
        lastSignalUpdate = now;
      }
      const w = canvas.width;
      const h = canvas.height;

      // Shift existing image one pixel to the right (left-to-right scroll)
      const img = ctx.getImageData(0, 0, w - 1, h);
      ctx.putImageData(img, 1, 0);

      // Clear the leftmost column with current bg colour (works in light/dark mode)
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#090b0f';
      ctx.fillRect(0, 0, 1, h);

      // Draw new frequency column on the left edge
      for (let i = 0; i < displayBins; i++) {
        const v = buf[i] / 255;               // 0–1 amplitude
        if (v < 0.01) continue;               // skip silence

        const y = h - Math.round((i / displayBins) * h) - 1;
        const binH = Math.max(1, Math.ceil(h / displayBins));

        // Color: dark navy → sky blue → white at peaks
        const r = Math.round(v * v * 180);
        const g = Math.round(v * 184);
        const b = Math.round(60 + v * 195);
        const a = 0.15 + v * 0.85;

        ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
        ctx.fillRect(0, y, 1, binH);
      }
    }
    frame();
  }

  /* ================================================================
     DETECTION TICKER
  ================================================================ */
  const TICKER_PHRASES = [
    'scanning acoustic frequencies…',
    'filtering ambient noise…',
    'detecting vocal signatures…',
    'cross-referencing sound patterns…',
    'isolating biological signals…',
    'mapping frequency harmonics…',
    'analysing call structure…',
    'searching species database…',
    'reading soundscape density…',
    'measuring biodiversity index…',
  ];
  let tickerTimer = null;
  let tickerIdx   = 0;

  function startTicker() {
    const el = $('detection-ticker');
    if (!el) return;
    tickerIdx = Math.floor(Math.random() * TICKER_PHRASES.length);
    el.textContent = TICKER_PHRASES[tickerIdx];
    el.style.display = 'block';
    tickerTimer = setInterval(() => {
      el.classList.add('ticker-fade');
      setTimeout(() => {
        tickerIdx = (tickerIdx + 1) % TICKER_PHRASES.length;
        el.textContent = TICKER_PHRASES[tickerIdx];
        el.classList.remove('ticker-fade');
      }, 220);
    }, 1800);
  }

  function stopTicker() {
    if (tickerTimer) { clearInterval(tickerTimer); tickerTimer = null; }
    const el = $('detection-ticker');
    if (el) el.style.display = 'none';
  }

  function setPanelStatus(label, mode = 'ready') {
    const panel = document.querySelector('.panel-status');
    const text = $('panel-status-text');
    if (!panel || !text) return;
    panel.dataset.mode = mode;
    text.textContent = label;
  }

  function signalQualityFromBuffer(buf) {
    let sum = 0;
    let peak = 0;
    for (const value of buf) {
      const centered = Math.abs(value - 128);
      sum += centered;
      if (centered > peak) peak = centered;
    }

    const avg = sum / buf.length;
    if (peak > 118 || avg > 44) return { label: 'Too noisy', mode: 'noisy' };
    if (avg < 4) return { label: 'Too quiet', mode: 'quiet' };
    if (avg < 11) return { label: 'Listening - fair signal', mode: 'recording' };
    return { label: 'Listening - good signal', mode: 'good' };
  }

  function formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  /* ================================================================
     RECORDING
  ================================================================ */
  async function startRecording() {
    if (isRecording || isProcessing) return;

    $('species-grid').innerHTML = '';
    $('analyse-again-btn')?.remove();
    document.querySelectorAll('.error-card').forEach(c => c.remove());
    detectedSpecies = [];

    if (!navigator.mediaDevices?.getUserMedia) {
      appendErrorCard('species-grid', 'Browser Not Supported',
        'Audio recording is not available in this browser.\nPlease use a current version of Chrome, Firefox, or Edge.');
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      const denied = err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError';
      appendErrorCard('species-grid',
        denied ? 'Microphone Access Denied' : 'Microphone Error',
        denied
          ? 'WildlifeSound needs microphone access to analyse your soundscape.\n\n' +
            'To enable:\n• Chrome/Edge: Click the lock icon → Site settings → Microphone → Allow\n' +
            '• Firefox: Click the mic icon in the address bar → Allow\n' +
            '• Safari: Preferences → Websites → Microphone → Allow'
          : err.message
      );
      return;
    }

    // Web Audio (waveform only — analyser not connected to destination)
    audioCtx      = new (window.AudioContext || window.webkitAudioContext)();
    const src     = audioCtx.createMediaStreamSource(stream);
    analyserNode  = audioCtx.createAnalyser();
    analyserNode.fftSize = 2048;
    src.connect(analyserNode);

    // MediaRecorder
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');

    // Init live detection state
    liveResultsMap.clear();
    chunkWindowChunks = [];
    chunkLastAt       = performance.now();
    chunkElapsedAt    = 0;
    chunkMime         = mime;
    activeChunkAnalyses.clear();

    audioChunks = [];
    mediaRecorder = mime
      ? new MediaRecorder(stream, { mimeType: mime })
      : new MediaRecorder(stream);

    mediaRecorder.ondataavailable = e => {
      if (e.data?.size > 0) {
        audioChunks.push(e.data);
        chunkWindowChunks.push(e.data);
      }
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      if (audioCtx) { audioCtx.close(); audioCtx = null; }
      if (rafId)    { cancelAnimationFrame(rafId); rafId = null; }
      analyserNode = null;

      // Setup replay from full recording
      const fullMime = chunkMime || 'audio/webm';
      const fullBlob = new Blob(audioChunks, { type: fullMime });
      audioChunks = [];
      setupReplay(fullBlob);

      // Process leftover chunk if ≥ 5 seconds remain since last chunk
      const leftoverMs = performance.now() - chunkLastAt;
      if (chunkWindowChunks.length && leftoverMs >= 5000) {
        const leftoverBlob = new Blob([...chunkWindowChunks], { type: fullMime });
        chunkWindowChunks = [];
        await analyseChunk(leftoverBlob, fullMime, chunkElapsedAt, chunkElapsedAt + Math.round(leftoverMs / 1000));
      }
      chunkWindowChunks = [];

      if (activeChunkAnalyses.size) {
        setPanelStatus('Finishing analysis', 'analyzing');
        await Promise.allSettled([...activeChunkAnalyses]);
      }

      // Finalize panel
      stopLivePanel();

      if (liveResultsMap.size === 0) {
        appendErrorCard('species-grid', 'No Species Detected',
          'No biological species detected. Try recording outdoors near vegetation at dawn or dusk.');
        renderLiveDetections('empty');
        setPanelStatus('No detection', 'empty');
      } else {
        detectedSpecies = [...liveResultsMap.values()];
        setPanelStatus('Results ready', 'results');
        renderLiveDetections('results', detectedSpecies);
        renderSpeciesGrid(detectedSpecies);
        setTimeout(() => $('species-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
        showAnalyseAgainBtn();
      }

      setRecordState('idle');
      isProcessing = false;
    };

    mediaRecorder.start(100);
    isRecording = true;

    setRecordState('recording');
    $('hero').classList.add('hero--compact');
    $('waveform-section').classList.add('visible');
    startTicker();
    startLivePanel();
    requestAnimationFrame(() => { resizeCanvas(); drawSpectrogram(); });

    let elapsed = 0;
    $('record-label').textContent = `RECORDING ${formatDuration(elapsed)} - TAP TO STOP`;
    recordingTimer = setInterval(() => {
      elapsed++;
      $('record-label').textContent = `RECORDING ${formatDuration(elapsed)} - TAP TO STOP`;
      if (elapsed >= MAX_RECORDING_SECONDS) {
        clearInterval(recordingTimer);
        recordingTimer = null;
        toast('Maximum recording length reached.');
        stopRecording();
      }
    }, 1000);

    // Chunk interval — analyse every 10 seconds
    chunkIntervalId = setInterval(async () => {
      if (!isRecording) return;
      const windowChunks = [...chunkWindowChunks];
      chunkWindowChunks = [];
      const now = performance.now();
      const windowSecs = Math.round((now - chunkLastAt) / 1000);
      const windowStart = chunkElapsedAt;
      const windowEnd   = chunkElapsedAt + windowSecs;
      chunkElapsedAt    = windowEnd;
      chunkLastAt       = now;
      if (!windowChunks.length) return;
      const windowBlob = new Blob(windowChunks, { type: chunkMime || 'audio/webm' });
      await analyseChunk(windowBlob, chunkMime, windowStart, windowEnd);
    }, 10_000);
  }

  function stopRecording() {
    if (!isRecording || !mediaRecorder) return;
    clearInterval(recordingTimer);
    recordingTimer = null;
    clearInterval(chunkIntervalId);
    chunkIntervalId = null;
    isRecording = false;
    isProcessing = true;
    if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    setRecordState('processing');
  }

  /* ================================================================
     LIVE CHUNK ANALYSIS
  ================================================================ */
  function analyseChunk(blob, mimeType, timeStart = 0, timeEnd = 10) {
    const task = runChunkAnalysis(blob, mimeType, timeStart, timeEnd);
    activeChunkAnalyses.add(task);
    renderLivePanelBody();
    task.finally(() => {
      activeChunkAnalyses.delete(task);
      renderLivePanelBody();
    });
    return task;
  }

  async function runChunkAnalysis(blob, mimeType, timeStart = 0, timeEnd = 10) {
    try {
      let b64;
      try { b64 = await blobToBase64(blob); } catch { return; }

      const mergeSpecies = newSpecies => {
        for (const sp of newSpecies) {
          const key = `${sp._detected_by}::${(sp.common_name || '').toLowerCase().trim()}`;
          const existing = liveResultsMap.get(key);
          if (existing) {
            if ((sp.probability_score || 0) > (existing.probability_score || 0)) {
              existing.probability_score = sp.probability_score;
              existing.confidence        = sp.confidence;
            }
            existing.timeEnd = timeEnd;
          } else {
            liveResultsMap.set(key, { ...sp, timeStart, timeEnd, _imageLoaded: false });
          }
        }

        let idx = 0;
        for (const sp of liveResultsMap.values()) sp._idx = idx++;
        renderLivePanelBody();

        Promise.allSettled(
          [...liveResultsMap.values()]
            .filter(sp => !sp._imageLoaded)
            .map(async sp => {
              sp._imageLoaded = true;
              const img = await fetchSpeciesImage(sp.scientific_name, sp._raw_label || sp.common_name).catch(() => null);
              if (img) sp.image = img;
            })
        ).then(() => renderLivePanelBody());
      };

      const birdnetTask = callBirdNet(b64, mimeType)
        .then(result => mergeSpecies(birdnetToSpecies(result?.results || [])))
        .catch(() => {});

      const geminiTask = callGemini(b64, mimeType)
        .then(result => {
          const geminiSpecies = (result?.species || []).map(sp => ({
            ...sp,
            _detected_by: 'Gemini',
            _source: 'gemini',
          }));
          mergeSpecies(geminiSpecies);
        })
        .catch(() => {});

      await Promise.allSettled([geminiTask, birdnetTask]);
    } catch {
      // Live chunk failures should not stop recording.
    }
  }

  /* ================================================================
     LIVE PANEL
  ================================================================ */
  const LIVE_MODEL_GROUPS = [
    { keys: ['BirdNET/AST', 'DBD-research-group/AST-BirdSet-XCL'], label: 'BirdNET · AST',       type: 'birdnet' },
    { keys: ['BirdNET/W2V', 'dima806/bird_sounds_classification'],  label: 'BirdNET · Wav2Vec',  type: 'birdnet' },
    { keys: ['Gemini'],                                              label: 'Gemini AI',           type: 'gemini'  },
  ];

  function startLivePanel() {
    const panel = $('live-panel');
    if (!panel) return;
    $('live-panel-title').textContent = 'Live detections';
    $('live-panel-pulse').style.display = '';
    panel.classList.remove('hidden');
    renderLivePanelBody();
  }

  function stopLivePanel() {
    const panel = $('live-panel');
    if (!panel) return;
    $('live-panel-title').textContent = 'Final detections';
    $('live-panel-pulse').style.display = 'none';
    panel.classList.remove('hidden');
    renderLivePanelBody();
  }

  function fmtTime(s) {
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  function renderLivePanelBody() {
    const body = $('live-panel-body');
    if (!body) return;

    const allKeys = new Set(LIVE_MODEL_GROUPS.flatMap(g => g.keys));
    let html = '';

    for (const group of LIVE_MODEL_GROUPS) {
      const items = [...liveResultsMap.values()].filter(sp => group.keys.includes(sp._detected_by));
      html += `<div class="lp-group lp-group--${group.type}">
        <div class="lp-group-label">${group.label}</div>`;

      if (!items.length) {
        const waitingText = activeChunkAnalyses.size ? 'Analyzing current chunk...' : 'Listening for matches...';
        html += `<div class="lp-waiting">
          <span class="lp-waiting-dot"></span> ${waitingText}
        </div>`;
      } else {
        for (const sp of items) {
          const pct   = Math.max(1, Math.min(99, Math.round(sp.probability_score || 0)));
          const imgHTML = sp.image
            ? `<img class="lp-thumb" src="${esc(sp.image.src)}" alt="${esc(sp.common_name)}">`
            : `<div class="lp-thumb lp-thumb--placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M22 6c0 0-4.5 1.5-7 2L12 4l-2 2-4-1s2 4 4 5H4l2 3h14c2-1 3-3 2-7z"/></svg></div>`;
          const timeStr = sp.timeEnd != null
            ? `${fmtTime(sp.timeStart)}–${fmtTime(sp.timeEnd)}`
            : fmtTime(sp.timeStart || 0);
          html += `<div class="lp-row">
            ${imgHTML}
            <div class="lp-row-body">
              <div class="lp-name">${esc(sp.common_name)}</div>
              ${sp.scientific_name ? `<div class="lp-sci">${esc(sp.scientific_name)}</div>` : ''}
            </div>
            <div class="lp-row-right">
              <div class="lp-pct">${pct}%</div>
              <div class="lp-time">${timeStr}</div>
            </div>
          </div>`;
        }
      }
      html += `</div>`;
    }

    body.innerHTML = html;
  }

  /* ================================================================
     RECORD BUTTON VISUAL STATE
  ================================================================ */
  function setRecordState(state) {
    const btn     = $('record-btn');
    const label   = $('record-label');
    const mic     = $('icon-mic');
    const spinner = $('icon-spinner');
    const ringA   = $('ring-a');
    const ringB   = $('ring-b');

    btn.className = '';
    mic.classList.remove('hidden');
    spinner.classList.add('hidden');
    ringA.classList.remove('active');
    ringB.classList.remove('active');
    btn.disabled = false;

    if (state === 'recording') {
      setPanelStatus('Recording', 'recording');
      renderLiveDetections('recording');
      btn.classList.add('recording');
      btn.setAttribute('aria-label', 'Stop recording');
      btn.title = 'Stop recording';
      mic.setAttribute('stroke', 'var(--danger)');
      ringA.classList.add('active');
      ringB.classList.add('active');

    } else if (state === 'processing') {
      setPanelStatus('Analyzing', 'analyzing');
      renderLiveDetections('analyzing');
      btn.classList.add('processing');
      btn.disabled = true;
      btn.setAttribute('aria-label', 'Analysing recording');
      btn.title = 'Analysing recording';
      mic.classList.add('hidden');
      spinner.classList.remove('hidden');
      label.textContent = 'ANALYSING…';
      $('waveform-section').classList.remove('visible');
      stopTicker();

    } else {
      // idle
      setPanelStatus(detectedSpecies.length ? 'Results ready' : 'Ready', detectedSpecies.length ? 'results' : 'ready');
      btn.setAttribute('aria-label', 'Start recording');
      btn.title = 'Start recording';
      mic.setAttribute('stroke', 'var(--accent)');
      label.textContent = 'TAP TO START';
      $('waveform-section').classList.remove('visible');
      stopTicker();
      isProcessing = false;
    }
  }

  /* ================================================================
     BLOB → BASE64
  ================================================================ */
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /* ================================================================
     GEMINI API — primary identifier + BirdNet label resolver
  ================================================================ */
  const GEMINI_PROMPT_BASE = `You are an expert field bioacoustician. Identify every wildlife species audible in this recording: birds, frogs, insects, mammals, reptiles.

For each species provide common name, scientific name, confidence (high|medium|low), probability 0–100, and one sentence about the specific sound heard.

Respond ONLY in this exact JSON format, no other text:
{
  "soundscape_summary": "string (max 20 words)",
  "species": [
    {
      "common_name": "string",
      "scientific_name": "string",
      "confidence": "high|medium|low",
      "probability_score": 0,
      "sound_description": "string"
    }
  ]
}

If no biological species detected, return empty species array.`;

  async function callGemini(base64Audio, mimeType) {
    const key = _geminiKey;
    if (!key) throw new Error('No Gemini API key provided.');

    const GEMINI_MODELS = [
      'gemini-2.5-flash',
      'gemini-2.0-flash-lite',
      'gemini-1.5-flash',
    ];

    const body = {
      contents: [{
        parts: [
          { text: GEMINI_PROMPT_BASE },
          { inline_data: { mime_type: mimeType || 'audio/webm', data: base64Audio } }
        ]
      }],
      generationConfig: { temperature: 0.1 }
    };

    let lastErr;
    for (const model of GEMINI_MODELS) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
      } catch (e) { lastErr = e; continue; }

      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const d = await res.json(); msg += ': ' + (d.error?.message || res.statusText); } catch {}
        lastErr = new Error(msg);
        if (res.status === 429 || res.status === 503) continue; // try next model
        throw lastErr;
      }

      const data = await res.json();

      // Gemini can return HTTP 200 with an error body
      if (data.error) {
        const msg = data.error.message || 'Gemini error';
        const err = new Error(msg);
        if (msg.toLowerCase().includes('overload') || msg.toLowerCase().includes('503'))
          err.isOverload = true;
        lastErr = err;
        if (err.isOverload) continue;
        throw err;
      }

      let rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) { lastErr = new Error('Gemini returned an empty response.'); continue; }

      // Strip markdown fences
      rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

      let parsed;
      try { parsed = JSON.parse(rawText); }
      catch (e) {
        const err  = new Error('JSON parse failed');
        err.raw    = rawText;
        throw err;
      }
      return parsed;
    }

    throw lastErr || new Error('All Gemini models failed.');
  }

  /* ================================================================
     BIRDNET — multiple HF models in parallel
     Returns { results: [{ model, detections: [{label, score, source}] }] }
     Each detection has a raw label (eBird code or common name) and score (0-100).
     Gemini will resolve labels to proper common/scientific names.
  ================================================================ */
  async function callBirdNet(base64Audio, mimeType) {
    const token = _hfToken;
    if (!token) return { results: [] };

    const HF_BASE = 'https://router.huggingface.co/hf-inference/models';
    const MODELS = [
      { id: 'DBD-research-group/AST-BirdSet-XCL', source: 'BirdNET/AST' },
      { id: 'dima806/bird_sounds_classification',  source: 'BirdNET/W2V' },
    ];
    const audioBuffer = Uint8Array.from(atob(base64Audio), c => c.charCodeAt(0));

    async function queryModel(model) {
      let res;
      try {
        res = await fetch(`${HF_BASE}/${model.id}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': mimeType || 'audio/webm',
            'Accept': 'application/json',
          },
          body: audioBuffer,
          signal: AbortSignal.timeout(35_000),
        });
      } catch (err) {
        return { model: model.source, error: err.message, detections: [] };
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (res.status === 503) {
          let eta = 25;
          try { eta = JSON.parse(text).estimated_time || 25; } catch {}
          return { model: model.source, loading: true, retry_after: Math.ceil(eta), detections: [] };
        }
        return { model: model.source, error: `HTTP ${res.status}`, detections: [] };
      }

      const raw = await res.json().catch(() => []);
      const detections = (Array.isArray(raw) ? raw : [])
        .filter(d => d.score > 0.01)
        .slice(0, 8)
        .map(d => ({ label: d.label, score: Math.round(d.score * 100), source: model.source }));
      return { model: model.source, detections };
    }

    const modelResults = await Promise.all(MODELS.map(m => queryModel(m)));

    // If all models loading, retry once after wait
    const loadingAll = modelResults.every(r => r.loading);
    if (loadingAll) {
      const maxWait = Math.min(Math.max(...modelResults.map(r => (r.retry_after || 25) * 1000)), 40_000);
      await new Promise(r => setTimeout(r, maxWait));
      const retried = await Promise.all(MODELS.map(m => queryModel(m)));
      return { results: retried };
    }

    return { results: modelResults };
  }

  /* Format a raw BirdNet label into a readable display name.
     W2V returns names like "Mallard_Duck" → "Mallard Duck"
     AST returns eBird codes like "mallar3" → keep as-is (resolved later via Wikipedia) */
  function formatBirdLabel(label) {
    if (!label) return 'Unknown';
    // Contains underscore or space → readable name, just clean it up
    if (/[_\s]/.test(label)) {
      return label.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
    }
    // Short alphanumeric eBird code (e.g. "mallar3") — title-case without digits
    return label.replace(/\d+$/, '').replace(/^./, c => c.toUpperCase());
  }

  /* Convert BirdNet raw detections directly into species objects, tagged by model. */
  function birdnetToSpecies(birdnetResults) {
    const out = [];
    for (const result of birdnetResults) {
      for (const det of (result.detections || [])) {
        out.push({
          common_name:      formatBirdLabel(det.label),
          scientific_name:  '',           // filled in later via Wikipedia lookup
          confidence:       det.score >= 70 ? 'high' : det.score >= 40 ? 'medium' : 'low',
          probability_score: det.score,
          sound_description: '',
          _raw_label:       det.label,   // keep original for Wikipedia search
          _detected_by:     result.model,
          _source:          'birdnet',
        });
      }
    }
    return out;
  }

  /* ================================================================
     WIKIPEDIA IMAGE FETCH
     Uses the REST summary endpoint — no API key, CORS-enabled.
     Tries scientific name first, falls back to common name.
  ================================================================ */
  async function fetchSpeciesImage(scientificName, commonName) {
    const tryName = async (name) => {
      if (!name) return null;
      const slug = name.trim().replace(/ /g, '_');
      const url  = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(slug)}`;
      const res  = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) return null;
      const data = await res.json();
      const src = data.thumbnail?.source || data.originalimage?.source;
      if (!src) return null;
      return { src, page: data.content_urls?.desktop?.page || null };
    };

    try {
      const cleanCommon = commonName?.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
      const cleanScientific = scientificName?.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
      const candidates = [
        cleanScientific,
        cleanCommon,
        cleanCommon ? `${cleanCommon} bird` : null,
        cleanCommon ? `${cleanCommon} animal` : null
      ];

      for (const candidate of candidates) {
        const image = await tryName(candidate);
        if (image) return image;
      }
      return null;
    } catch {
      return null;
    }
  }

  const BIRD_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 6c0 0-4.5 1.5-7 2L12 4l-2 2-4-1s2 4 4 5H4l2 3h14c2-1 3-3 2-7z"/></svg>`;

  function probMeta(sp) {
    const key = (sp.confidence || 'low').toLowerCase();
    const raw = Number(sp.probability_score ?? sp.probability ?? sp.score);
    const pct = Number.isFinite(raw)
      ? Math.max(1, Math.min(99, Math.round(raw)))
      : key === 'high' ? 88 : key === 'medium' ? 55 : 25;
    const cls = key === 'high' ? '' : key === 'medium' ? 'prob-medium' : 'prob-low';
    const label = `${pct}%`;
    return { pct, cls, label };
  }

  function speciesType(sp) {
    const text = `${sp.common_name || ''} ${sp.scientific_name || ''}`.toLowerCase();
    if (sp._source === 'birdnet') return 'Bird';
    if (/(frog|toad|rana|hyla|anaxyrus|lithobates|amphib)/.test(text)) return 'Frog';
    if (/(cricket|cicada|katydid|grasshopper|bee|insect|orthoptera|hemiptera)/.test(text)) return 'Insect';
    if (/(bat|fox|coyote|deer|squirrel|mammal|mouse|rat|bear|wolf)/.test(text)) return 'Mammal';
    if (/(bird|warbler|sparrow|robin|crow|jay|owl|hawk|goose|duck|finch|thrush|vireo|wren|woodpecker|swallow|gull|dove|cardinal|oriole|bunting)/.test(text)) return 'Bird';
    return 'Wildlife';
  }

  /* ================================================================
     RENDER SPECIES CARD — loading skeleton
  ================================================================ */
  function renderLoadingCard(sp, idx, grid = $('species-grid')) {
    const card = document.createElement('div');
    card.className = 'species-card';
    card.id = `card-${idx}`;
    card.setAttribute('role', 'listitem');
    card.style.animationDelay = `${idx * 70}ms`;

    const { pct, cls, label } = probMeta(sp);
    const type = speciesType(sp);

    card.innerHTML = `
      <div class="species-row-photo-placeholder">${BIRD_ICON}</div>
      <div class="species-row-body">
        <div class="species-row-name">${esc(sp.common_name)}</div>
        <div class="species-row-sci">${esc(sp.scientific_name)}</div>
        <div class="species-badges"><span class="type-badge">${esc(type)}</span></div>
        <div class="prob-bar-wrap">
          <div class="prob-bar-track"><div class="prob-bar-fill ${cls}" style="width:${pct}%"></div></div>
          <span class="prob-label">${label}</span>
        </div>
      </div>
      <div class="species-row-right">
        <svg class="species-row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </div>`;
    grid.appendChild(card);
  }

  /* ================================================================
     UPDATE SPECIES CARD — with image and model data
  ================================================================ */
  function updateCard(sp) {
    const card = $(`card-${sp._idx}`);
    if (!card) return;

    const img = sp.image;
    const { pct, cls, label } = probMeta(sp);
    const type = speciesType(sp);

    const photoHTML = img
      ? `<img class="species-row-photo" src="${esc(img.src)}" alt="${esc(sp.common_name)}"
              onload="this.classList.add('loaded')" onerror="this.outerHTML='<div class=\\'species-row-photo-placeholder\\'>${BIRD_ICON.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}</div>'">`
      : `<div class="species-row-photo-placeholder">${BIRD_ICON}</div>`;

    const sourceBadge = sp._source === 'birdnet'
      ? `<span class="source-badge source-badge--birdnet">${esc(sp._detected_by || 'BirdNET')}</span>`
      : `<span class="source-badge source-badge--gemini">Gemini</span>`;

    card.innerHTML = `
      ${photoHTML}
      <div class="species-row-body">
        <div class="species-row-name">${esc(sp.common_name)}</div>
        <div class="species-row-sci">${esc(sp.scientific_name)}</div>
        <div class="species-badges">
          <span class="type-badge">${esc(type)}</span>
          ${sourceBadge}
        </div>
        <div class="prob-bar-wrap">
          <div class="prob-bar-track"><div class="prob-bar-fill ${cls}" style="width:0%"></div></div>
          <span class="prob-label">${label}</span>
        </div>
      </div>
      <div class="species-row-right">
        <svg class="species-row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </div>`;

    // Animate bar in next frame
    requestAnimationFrame(() => {
      const fill = card.querySelector('.prob-bar-fill');
      if (fill) fill.style.width = pct + '%';
    });

    // Click card → open detail panel
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => openDetailPanel(sp));
  }

  function renderLiveDetections(state = 'idle', species = []) {
    const wrap = $('live-detections');
    const body = $('live-detection-body');
    if (!body) return;

    if (state === 'idle') {
      body.innerHTML = '';
      wrap?.classList.add('hidden');
      return;
    }

    wrap?.classList.remove('hidden');

    if (state === 'recording') {
      body.innerHTML = `
        <div class="live-listening">
          <span class="live-pulse" aria-hidden="true"></span>
          Listening for birds, frogs, insects, and mammals...
        </div>`;
      return;
    }

    if (state === 'analyzing') {
      body.innerHTML = `
        <div class="live-listening">
          <span class="live-pulse" aria-hidden="true"></span>
          Analyzing sound and matching species...
        </div>`;
      return;
    }

    if (state === 'empty') {
      body.innerHTML = `
        <div class="live-empty">
          <strong>No wildlife detected</strong>
          <span>Try dawn, near trees, and away from traffic.</span>
        </div>`;
      return;
    }

    if (state === 'results' && species.length) {
      body.innerHTML = species.slice(0, 3).map(sp => {
        const { label } = probMeta(sp);
        const image = sp.image?.src
          ? `<img src="${esc(sp.image.src)}" alt="${esc(sp.common_name)}" loading="lazy">`
          : `<span class="live-thumb-placeholder">${BIRD_ICON}</span>`;
        return `
          <button class="live-chip" type="button" data-idx="${sp._idx}">
            <span class="live-thumb">${image}</span>
            <span class="live-chip-text">
              <span>${esc(sp.common_name)}</span>
              <strong>${label}</strong>
            </span>
          </button>`;
      }).join('');

      body.querySelectorAll('.live-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const sp = detectedSpecies[Number(chip.dataset.idx)];
          if (sp) openDetailPanel(sp);
        });
      });
      return;
    }

    body.innerHTML = '';
    wrap?.classList.add('hidden');
  }

  /* ================================================================
     ERROR CARD
  ================================================================ */
  function appendErrorCard(containerId, title, message, raw) {
    const container = $(containerId);
    const card = document.createElement('div');
    card.className = 'error-card';
    card.innerHTML = `
      <div class="error-card-title">${esc(title)}</div>
      <div class="error-card-body">${esc(message)}</div>
      ${raw ? `<pre>${esc(raw)}</pre>` : ''}`;
    container.appendChild(card);
  }

  /* ================================================================
     AUDIO REPLAY
  ================================================================ */
  function setupReplay(blob) {
    // Revoke previous object URL to free memory
    if (replayObjectURL) { URL.revokeObjectURL(replayObjectURL); replayObjectURL = null; }
    if (replayAudio)     { replayAudio.pause(); replayAudio = null; }

    replayObjectURL = URL.createObjectURL(blob);
    replayAudio     = new Audio(replayObjectURL);

    const bar      = $('replay-bar');
    const btn      = $('replay-btn');
    const progress = $('replay-progress');
    const timeEl   = $('replay-time');
    const track    = $('replay-track');
    const iconPlay = $('replay-icon-play');
    const iconPause= $('replay-icon-pause');

    function fmtTime(s) {
      const m = Math.floor(s / 60);
      return `${m}:${String(Math.floor(s % 60)).padStart(2,'0')}`;
    }

    replayAudio.addEventListener('timeupdate', () => {
      const pct = replayAudio.duration
        ? (replayAudio.currentTime / replayAudio.duration) * 100
        : 0;
      progress.style.width = pct + '%';
      timeEl.textContent   = fmtTime(replayAudio.currentTime);
    });

    replayAudio.addEventListener('ended', () => {
      iconPlay.style.display  = '';
      iconPause.style.display = 'none';
      progress.style.width    = '0%';
      timeEl.textContent      = fmtTime(replayAudio.duration || 0);
    });

    btn.onclick = () => {
      if (replayAudio.paused) {
        replayAudio.play();
        iconPlay.style.display  = 'none';
        iconPause.style.display = '';
      } else {
        replayAudio.pause();
        iconPlay.style.display  = '';
        iconPause.style.display = 'none';
      }
    };

    // Click on track to seek
    track.addEventListener('click', e => {
      if (!replayAudio.duration) return;
      const rect = track.getBoundingClientRect();
      replayAudio.currentTime = ((e.clientX - rect.left) / rect.width) * replayAudio.duration;
    });

    bar.classList.add('visible');
  }

  function hideReplay() {
    $('replay-bar')?.classList.remove('visible');
    if (replayAudio) { replayAudio.pause(); }
  }

  /* ================================================================
     FILE UPLOAD
  ================================================================ */
  const ACCEPTED_AUDIO = ['audio/mpeg','audio/mp3','audio/wav','audio/x-wav',
    'audio/ogg','audio/flac','audio/x-flac','audio/aac','audio/mp4',
    'audio/webm','audio/3gpp','audio/amr'];

  function initUpload() {
    const zone  = $('upload-zone');
    const input = $('upload-input');
    if (!zone || !input) return;

    zone.addEventListener('click', () => { if (!isProcessing) input.click(); });
    zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });

    input.addEventListener('change', () => {
      if (input.files?.[0]) handleUploadedFile(input.files[0]);
      input.value = '';
    });

    zone.addEventListener('dragover', e => {
      e.preventDefault();
      if (!isProcessing) zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      if (isProcessing) return;
      const file = e.dataTransfer?.files?.[0];
      if (file) handleUploadedFile(file);
    });
  }

  async function handleUploadedFile(file) {
    if (!_geminiKey && !_hfToken) {
      showApiKeyModal(() => handleUploadedFile(file));
      return;
    }
    // Validate type
    const mime = file.type || '';
    const ext  = file.name.split('.').pop().toLowerCase();
    const validExt = ['mp3','wav','ogg','flac','aac','m4a','webm','3gp','amr'];
    if (!ACCEPTED_AUDIO.includes(mime) && !validExt.includes(ext)) {
      toast('Unsupported file type. Please upload an audio file (mp3, wav, flac, ogg, m4a…)', 'error');
      return;
    }

    // 50 MB cap — Gemini inline_data limit
    if (file.size > 50 * 1024 * 1024) {
      toast('File too large. Maximum size is 50 MB.', 'error');
      return;
    }

    const zone = $('upload-zone');
    const lbl  = $('upload-label');
    zone.classList.add('upload-processing');
    lbl.textContent = `Analysing "${file.name}"…`;
    setPanelStatus('Analyzing upload', 'analyzing');

    await processBlob(file, file.type || 'audio/mpeg');

    zone.classList.remove('upload-processing');
    lbl.textContent = 'Upload audio';
  }

  /* ================================================================
     MAIN PROCESSING PIPELINE
  ================================================================ */
  async function processRecording() {
    isProcessing = true;
    const mimeType = audioChunks[0]?.type || 'audio/webm';
    const blob     = new Blob(audioChunks, { type: mimeType });
    audioChunks    = [];
    setupReplay(blob);
    await processBlob(blob, mimeType);
  }

  async function processBlob(blob, mimeType) {
    isProcessing = true;
    $('species-grid').innerHTML = '';
    document.querySelectorAll('.error-card').forEach(c => c.remove());
    renderLiveDetections('analyzing');

    // Base64 encode
    let b64;
    try { b64 = await blobToBase64(blob); }
    catch (err) {
      appendErrorCard('species-grid', 'Audio Encoding Error', err.message);
      setRecordState('idle');
      return;
    }

    // Run the three detection outputs in parallel:
    // BirdNET AST, BirdNET Wav2Vec, and Gemini.
    const [birdnetRaw, geminiResult] = await Promise.allSettled([
      callBirdNet(b64, mimeType),
      callGemini(b64, mimeType),
    ]);

    const birdnetResults = (birdnetRaw.status === 'fulfilled' ? birdnetRaw.value.results : []) || [];
    const birdnetSpecies = birdnetToSpecies(birdnetResults);

    if (geminiResult.status === 'rejected') {
      const err = geminiResult.reason;
      const isOverload = err.isOverload || err.message?.includes('503') || err.message?.toLowerCase().includes('overload');
      const title = isOverload ? 'Gemini Overloaded — Try Again' : 'Analysis Error';
      const msg   = isOverload ? 'Google Gemini is under high demand right now. Wait 30 seconds and try again.' : err.message;
      toast(msg, 'error', 8000);
      appendErrorCard('species-grid', title, msg, err.raw || null);
      $('species-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
      setRecordState('idle');
      return;
    }

    const gemini             = geminiResult.value;
    const soundscape_summary = gemini.soundscape_summary || '';
    const geminiSpecies      = (gemini.species || []).map(sp => ({
      ...sp,
      _detected_by: 'Gemini',
      _source: 'gemini',
    }));

    // Inform user if BirdNet models returned nothing (likely cold-starting)
    if (!birdnetSpecies.length && birdnetResults.length > 0) {
      toast('BirdNET models warming up — try again in 30 s for acoustic results.', 'success', 6000);
    } else if (birdnetSpecies.length) {
      toast(`BirdNET detected ${birdnetSpecies.length} species across ${birdnetResults.filter(r => r.detections?.length).length} models.`, 'success', 4000);
    }

    const species = [...birdnetSpecies, ...geminiSpecies];

    if (!species.length) {
      appendErrorCard('species-grid', 'No Species Detected',
        soundscape_summary ||
        'No biological species detected. Try recording outdoors, near vegetation, at dawn or dusk.');
      renderLiveDetections('empty');
      setRecordState('idle');
      setPanelStatus('No detection', 'empty');
      return;
    }

    // Sort by confidence first, then probability score, inside each model group.
    const CONF_ORDER = { high: 0, medium: 1, low: 2 };
    const sorted = [...species].sort((a, b) => {
      const cDiff = (CONF_ORDER[a.confidence?.toLowerCase()] ?? 1) - (CONF_ORDER[b.confidence?.toLowerCase()] ?? 1);
      if (cDiff !== 0) return cDiff;
      return (b.probability_score || 0) - (a.probability_score || 0);
    });
    detectedSpecies = sorted.map((s, i) => ({ ...s, _idx: i }));

    // Render species grid with confidence group headers
    renderSpeciesGrid(detectedSpecies);
    setPanelStatus('Results ready', 'results');
    renderLiveDetections('results', detectedSpecies);

    $('soundscape-summary').textContent = soundscape_summary || '';

    // Scroll to species
    setTimeout(() => {
      $('species-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 200);

    // Fetch Wikipedia photos only.
    await Promise.allSettled(
      detectedSpecies.map(async sp => {
        const imgResult = await Promise.resolve(fetchSpeciesImage(sp.scientific_name, sp._raw_label || sp.common_name))
          .then(value => ({ status: 'fulfilled', value }))
          .catch(reason => ({ status: 'rejected', reason }));
        sp.image = imgResult.status === 'fulfilled' ? imgResult.value : null;
        updateCard(sp);
        renderLiveDetections('results', detectedSpecies);
      })
    );

    setRecordState('idle');
    showAnalyseAgainBtn();
  }

  /* ================================================================
     SPECIES GRID — grouped by detection model
  ================================================================ */
  const MODEL_GROUPS = [
    {
      keys:  ['BirdNET/AST', 'DBD-research-group/AST-BirdSet-XCL'],
      label: 'BirdNET · AST',
      desc:  'Audio Spectrogram Transformer — 4,941 species',
      type:  'birdnet',
      icon:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 6c0 0-4.5 1.5-7 2L12 4l-2 2-4-1s2 4 4 5H4l2 3h14c2-1 3-3 2-7z"/></svg>`,
    },
    {
      keys:  ['BirdNET/W2V', 'dima806/bird_sounds_classification'],
      label: 'BirdNET · Wav2Vec',
      desc:  'Wav2Vec2 acoustic model',
      type:  'birdnet',
      icon:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
    },
    {
      keys:  ['Gemini'],
      label: 'Gemini AI',
      desc:  'Google Gemini 2.5 Flash — birds, frogs, insects, mammals',
      type:  'gemini',
      icon:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
    },
  ];

  function renderSpeciesGrid(species) {
    const grid = $('species-grid');
    grid.innerHTML = '';

    const allKeys = new Set(MODEL_GROUPS.flatMap(g => g.keys));

    for (const group of MODEL_GROUPS) {
      const items = species.filter(sp => group.keys.includes(sp._detected_by));

      const section = document.createElement('div');
      section.className = `model-section model-section--${group.type}`;
      section.innerHTML = `
        <div class="model-section-header">
          <div class="model-section-meta">
            <span class="model-section-icon">${group.icon}</span>
            <div>
              <div class="model-section-label">${group.label}</div>
              <div class="model-section-desc">${group.desc}</div>
            </div>
          </div>
          <span class="model-section-count">${items.length} species</span>
        </div>
        <div class="model-section-list"></div>`;
      grid.appendChild(section);

      const list = section.querySelector('.model-section-list');
      if (items.length) {
        for (const sp of items) {
          renderLoadingCard(sp, sp._idx, list);
        }
      } else {
        list.innerHTML = '<div class="model-empty">No confident match from this model</div>';
      }
    }

    // Fallback for unrecognised detected_by
    const unmatched = species.filter(sp => !allKeys.has(sp._detected_by));
    if (unmatched.length) {
      const section = document.createElement('div');
      section.className = 'model-section model-section--gemini';
      section.innerHTML = `
        <div class="model-section-header">
          <div class="model-section-meta">
            <div class="model-section-label">Other</div>
          </div>
          <span class="model-section-count">${unmatched.length} species</span>
        </div>
        <div class="model-section-list"></div>`;
      grid.appendChild(section);
      const list = section.querySelector('.model-section-list');
      for (const sp of unmatched) renderLoadingCard(sp, sp._idx, list);
    }
  }

  function showAnalyseAgainBtn() {
    // Remove old button if present
    const old = $('analyse-again-btn');
    if (old) old.remove();

    const btn = document.createElement('button');
    btn.id        = 'analyse-again-btn';
    btn.className = 'analyse-again-btn sticky-record-again';
    btn.textContent = 'Record Again';
    btn.addEventListener('click', () => {
      btn.remove();
      $('species-grid').innerHTML = '';
      $('live-panel')?.classList.add('hidden');
      liveResultsMap.clear();
      detectedSpecies = [];
      setPanelStatus('Ready', 'ready');
      renderLiveDetections('idle');
      $('hero').scrollIntoView({ behavior:'smooth', block:'start' });
    });
    $('species-section').querySelector('.container').appendChild(btn);
  }

  /* ================================================================
     SPECIES DETAIL PANEL
  ================================================================ */
  function openDetailPanel(sp) {
    const overlay = $('detail-overlay');
    const body    = $('detail-body');
    if (!overlay || !body) return;

    const { label: confLabel } = probMeta(sp);
    const source  = sp._detected_by || (sp._source === 'birdnet' ? 'BirdNET' : 'Gemini AI');

    const birdSVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M22 6c0 0-4.5 1.5-7 2L12 4l-2 2-4-1s2 4 4 5H4l2 3h14c2-1 3-3 2-7z"/></svg>`;

    const heroHTML = sp.image
      ? `<img class="detail-hero-img" src="${esc(sp.image.src)}" alt="${esc(sp.common_name)}"
              style="opacity:0;transition:opacity .5s" onload="this.style.opacity=1">`
      : `<div class="detail-hero-placeholder">${birdSVG}</div>`;

    const wikiLink = sp.image?.page
      ? `<a class="detail-wiki-link" href="${esc(sp.image.page)}" target="_blank" rel="noopener noreferrer">
           <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
           Photo: Wikipedia
         </a>`
      : '';

    body.innerHTML = `
      ${heroHTML}
      <div class="detail-handle"></div>
      <div class="detail-content">
        <div class="detail-name" id="detail-name">${esc(sp.common_name)}</div>
        <div class="detail-scientific">${esc(sp.scientific_name)}</div>

        <div class="detail-chips">
          <div class="detail-chip">
            <span class="detail-chip-label">Confidence</span>
            <span class="detail-chip-val">${confLabel}</span>
          </div>
          <div class="detail-chip">
            <span class="detail-chip-label">Source</span>
            <span class="detail-chip-val">${esc(source)}</span>
          </div>
        </div>

        ${sp.sound_description ? `<div class="detail-desc">${esc(sp.sound_description)}</div>` : ''}
        ${wikiLink}
      </div>`;

    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    $('detail-close').onclick = closeDetailPanel;
    overlay.onclick = e => { if (e.target === overlay) closeDetailPanel(); };
  }

  function closeDetailPanel() {
    $('detail-overlay')?.classList.add('hidden');
    document.body.style.overflow = '';
  }

  function openImageOverlay(src, alt = '') {
    const overlay = $('image-overlay');
    const img = $('image-full');
    if (!overlay || !img || !src) return;

    img.src = src;
    img.alt = alt;
    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    $('image-close').onclick = closeImageOverlay;
    overlay.onclick = e => { if (e.target === overlay) closeImageOverlay(); };
  }

  function closeImageOverlay() {
    const overlay = $('image-overlay');
    const img = $('image-full');
    overlay?.classList.add('hidden');
    if (img) img.src = '';

    if ($('detail-overlay')?.classList.contains('hidden')) {
      document.body.style.overflow = '';
    }
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!$('image-overlay')?.classList.contains('hidden')) closeImageOverlay();
      else closeDetailPanel();
    }
  });

  /* ================================================================
     MISC UTILITIES
  ================================================================ */
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* ================================================================
     ENTRY POINT
  ================================================================ */

  async function init() {
    setPanelStatus('Ready', 'ready');

    // Online status
    updateOnlineStatus();
    window.addEventListener('online',  updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);

    // Theme toggle
    (function initTheme() {
      const root = document.documentElement;
      const btn  = $('theme-toggle');
      const saved = localStorage.getItem('ws_theme');
      if (saved === 'light') root.classList.add('light');
      const syncThemeButton = () => {
        const isLight = root.classList.contains('light');
        btn.setAttribute('aria-label', isLight ? 'Switch to dark mode' : 'Switch to light mode');
        btn.title = isLight ? 'Switch to dark mode' : 'Switch to light mode';
      };
      syncThemeButton();
      btn.addEventListener('click', () => {
        root.classList.toggle('light');
        localStorage.setItem('ws_theme', root.classList.contains('light') ? 'light' : 'dark');
        syncThemeButton();
      });
    })();

    // File upload
    initUpload();

    // Canvas resize
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // Clear keys on page unload
    window.addEventListener('pagehide', () => { _geminiKey = ''; _hfToken = ''; });

    // Record button
    $('record-btn').addEventListener('click', () => {
      if (isProcessing) return;
      if (isRecording) { stopRecording(); return; }
      if (_geminiKey || _hfToken) {
        startRecording();
      } else {
        showApiKeyModal(() => startRecording());
      }
    });

  }

  // Bootstrap
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
