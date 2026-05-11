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
  const GEMINI_MODEL_GROUPS = [
    { key: 'Gemini 2.5 Flash Lite', desc: 'Fast Gemini wildlife detector' },
  ];
  const YAMNET_MODEL_GROUPS = [
    { key: 'YAMNet AudioSet', desc: 'Simple browser audio event model' },
  ];
  const BIRDNET_MIN_CONFIDENCE = 0.03;

  /* ================================================================
     APPLICATION STATE
  ================================================================ */
  let mediaRecorder     = null;
  let audioChunks       = [];
  let audioCtx          = null;
  let analyserNode      = null;
  let audioProcessorNode = null;
  let silenceGainNode   = null;
  let rafId             = null;
  let recordingTimer    = null;
  let isRecording       = false;
  let isProcessing      = false;
  let detectedSpecies   = [];
  let replayAudio       = null;
  let replayObjectURL   = null;
  let lastSignalUpdate  = 0;
  let birdNetWorkerPromise = null;
  let birdNetPredictionId = 0;
  let yamNetWorkerPromise = null;
  let yamNetPredictionId = 0;

  // Gemini uses server-side API routes because API keys must not live in browser code.
  // BirdNET uses a local API fallback plus browser TensorFlow.js; YAMNet runs in browser TensorFlow.js.
  const HAS_LOCAL_API = window.location.protocol.startsWith('http') &&
    ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const API_BASE = (window.WILDLIFE_API_BASE || '').replace(/\/$/, '');

  function apiUrl(path) {
    if (HAS_LOCAL_API) return path;
    if (API_BASE) return `${API_BASE}${path}`;
    throw new Error('Detection needs an API server. Run npm run dev locally, or deploy the API routes and set window.WILDLIFE_API_BASE.');
  }

  // Live chunk detection state
  let liveResultsMap    = new Map();  // key: 'model::name' → species obj
  let chunkWindowChunks = [];          // audio chunks for current 10s window
  let pcmChunks        = [];
  let chunkPcmChunks   = [];
  let chunkIntervalId   = null;        // setInterval handle
  let chunkLastAt       = 0;           // performance.now() when last chunk was sent
  let chunkElapsedAt    = 0;           // recording seconds when last chunk was sent
  let chunkMime         = '';          // mime type of recording
  let recordingStartedAt = 0;
  let recordingSampleRate = 44100;
  const activeChunkAnalyses = new Set();
  let liveModelErrors   = new Map();   // key: model group label -> latest visible failure

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

  function cleanModelText(value) {
    return String(value ?? '')
      .replace(/```(?:json)?/gi, '')
      .replace(/[<>]/g, ' ')
      .replace(/^["'`\\\s:;,.\-[\]{}()]+|["'`\\\s:;,.\-[\]{}()]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isValidSpeciesName(value) {
    const text = cleanModelText(value);
    if (text.length < 3) return false;
    if (!/[A-Za-z]/.test(text)) return false;
    if (/^[^A-Za-z]+$/.test(text)) return false;
    return true;
  }

  function normalizeDetectedSpecies(sp, fallbackModel = 'Gemini AI') {
    const commonName = cleanModelText(sp.common_name || sp.commonName || sp.name);
    if (!isValidSpeciesName(commonName)) return null;

    const scientificName = cleanModelText(sp.scientific_name || sp.scientificName || '');
    const detectedBy = cleanModelText(sp._detected_by || sp._modelLabel || fallbackModel) || fallbackModel;
    const rawScore = Number(sp.probability_score ?? sp.probability ?? sp.score);
    const confidence = cleanModelText(sp.confidence || '');
    const probabilityScore = Number.isFinite(rawScore)
      ? Math.max(1, Math.min(99, Math.round(rawScore)))
      : confidence.toLowerCase() === 'high' ? 88 : confidence.toLowerCase() === 'medium' ? 55 : 25;

    return {
      ...sp,
      common_name: commonName,
      scientific_name: scientificName,
      confidence: confidence || (probabilityScore >= 70 ? 'high' : probabilityScore >= 40 ? 'medium' : 'low'),
      probability_score: probabilityScore,
      sound_description: cleanModelText(sp.sound_description || ''),
      _detected_by: detectedBy,
    };
  }

  /* ================================================================
     WORKFLOW STEP INDICATOR
  ================================================================ */
  function setWorkflowStep(activeIndex) {
    // activeIndex: 0=Record, 1=Analyze, 2=Identify, -1=reset
    document.querySelectorAll('.wf-step').forEach((el, i) => {
      el.classList.remove('active', 'done');
      if (activeIndex === -1) return;
      if (i < activeIndex) el.classList.add('done');
      else if (i === activeIndex) el.classList.add('active');
    });
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
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = Math.max(320, c.offsetWidth || c.parentElement?.offsetWidth || 420);
    const cssHeight = Math.max(82, c.offsetHeight || 110);
    c.width = Math.round(cssWidth * dpr);
    c.height = Math.round(cssHeight * dpr);
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
      if (w < 2 || h < 2) return;

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

      // Overlay a simple waveform trace so users get immediate visual feedback
      // even in quiet rooms where the spectrogram is faint.
      analyserNode.getByteTimeDomainData(timeBuf);
      ctx.strokeStyle = 'rgba(95,184,255,.62)';
      ctx.lineWidth = Math.max(1, window.devicePixelRatio || 1);
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const sample = timeBuf[Math.floor((x / w) * timeBuf.length)] / 255;
        const y = sample * h;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
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

  function isNonBlockingModelError(model, message) {
    return model === 'BirdNET' && /no confident/i.test(message || '');
  }

  function blockingModelFailures() {
    return [...liveModelErrors.entries()]
      .filter(([model, message]) => !isNonBlockingModelError(model, message));
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
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const src     = audioCtx.createMediaStreamSource(stream);
    analyserNode  = audioCtx.createAnalyser();
    analyserNode.fftSize = 2048;
    src.connect(analyserNode);

    recordingSampleRate = audioCtx.sampleRate || 44100;
    audioProcessorNode = audioCtx.createScriptProcessor(4096, 1, 1);
    silenceGainNode = audioCtx.createGain();
    silenceGainNode.gain.value = 0;
    audioProcessorNode.onaudioprocess = event => {
      if (!isRecording) return;
      const input = event.inputBuffer.getChannelData(0);
      const copy = new Float32Array(input.length);
      copy.set(input);
      pcmChunks.push(copy);
      chunkPcmChunks.push(copy);
    };
    src.connect(audioProcessorNode);
    audioProcessorNode.connect(silenceGainNode);
    silenceGainNode.connect(audioCtx.destination);

    // MediaRecorder
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');

    // Init live detection state
    liveResultsMap.clear();
    liveModelErrors.clear();
    chunkWindowChunks = [];
    pcmChunks = [];
    chunkPcmChunks = [];
    chunkLastAt       = performance.now();
    recordingStartedAt = chunkLastAt;
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
      if (audioProcessorNode) {
        audioProcessorNode.disconnect();
        audioProcessorNode.onaudioprocess = null;
        audioProcessorNode = null;
      }
      if (silenceGainNode) {
        silenceGainNode.disconnect();
        silenceGainNode = null;
      }
      if (audioCtx) { audioCtx.close(); audioCtx = null; }
      if (rafId)    { cancelAnimationFrame(rafId); rafId = null; }
      analyserNode = null;

      // Setup replay from full recording
      const fullMime = chunkMime || 'audio/webm';
      const fullBlob = new Blob(audioChunks, { type: fullMime });
      const fullWavBlob = pcmChunks.length ? createWavBlob(pcmChunks, recordingSampleRate) : fullBlob;
      audioChunks = [];
      pcmChunks = [];
      setupReplay(fullBlob);

      // Process leftover chunk if ≥ 5 seconds remain since last chunk
      const leftoverMs = performance.now() - chunkLastAt;
      if (chunkPcmChunks.length && leftoverMs >= 5000) {
        const leftoverBlob = createWavBlob(chunkPcmChunks, recordingSampleRate);
        chunkWindowChunks = [];
        chunkPcmChunks = [];
        await analyseChunk(leftoverBlob, 'audio/wav', chunkElapsedAt, chunkElapsedAt + Math.round(leftoverMs / 1000));
      }
      chunkWindowChunks = [];
      chunkPcmChunks = [];

      if (activeChunkAnalyses.size) {
        setPanelStatus('Finishing analysis', 'analyzing');
        await Promise.allSettled([...activeChunkAnalyses]);
      }

      if (liveResultsMap.size === 0 && fullWavBlob.size > 0) {
        const fullDuration = Math.max(1, Math.round((performance.now() - recordingStartedAt) / 1000));
        setPanelStatus('Checking full recording', 'analyzing');
        await analyseChunk(fullWavBlob, 'audio/wav', 0, fullDuration);
        if (activeChunkAnalyses.size) await Promise.allSettled([...activeChunkAnalyses]);
      }

      // Finalize panel
      stopLivePanel();

      if (liveResultsMap.size === 0) {
        const failures = blockingModelFailures();
        const failureText = failures.map(([model, msg]) => `${model}: ${msg}`).join('\n');
        const onlyBirdnetNoMatch = liveModelErrors.size > 0 && failures.length === 0;
        const title = failureText
          ? (failureText.toLowerCase().includes('overload') || failureText.includes('503') ? 'Gemini Busy' : 'Analysis Failed')
          : 'No Species Detected';
        const message = failureText ||
          (onlyBirdnetNoMatch
            ? 'BirdNET did not return a confident bird match. Gemini may still identify non-bird wildlife.'
            : 'No biological species detected. Try recording outdoors near vegetation at dawn or dusk.');
        appendErrorCard('species-grid', title, message);
        renderLiveDetections('empty');
        setPanelStatus(failureText ? title : 'No detection', failureText ? 'error' : 'empty');
      } else {
        detectedSpecies = [...liveResultsMap.values()];
        setPanelStatus('Results ready', 'results');
        renderLiveDetections('results', detectedSpecies);
        renderSpeciesGrid(detectedSpecies);
        setTimeout(() => $('species-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
        await Promise.allSettled(detectedSpecies.map(async sp => {
          await enrichSpeciesReference(sp);
          updateCard(sp);
          renderLiveDetections('results', detectedSpecies);
        }));
      }

      setWorkflowStep(detectedSpecies.length > 0 ? 2 : -1);
      setRecordState('idle');
      isProcessing = false;
    };

    setWorkflowStep(0);
    mediaRecorder.start(100);
    isRecording = true;

    setRecordState('recording');
    $('hero').classList.add('hero--compact');
    $('waveform-section').classList.add('visible');
    startTicker();
    startLivePanel();
    setTimeout(() => document.querySelector('.detection-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
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
      const windowPcm = [...chunkPcmChunks];
      chunkWindowChunks = [];
      chunkPcmChunks = [];
      const now = performance.now();
      const windowSecs = Math.round((now - chunkLastAt) / 1000);
      const windowStart = chunkElapsedAt;
      const windowEnd   = chunkElapsedAt + windowSecs;
      chunkElapsedAt    = windowEnd;
      chunkLastAt       = now;
      if (!windowPcm.length && !windowChunks.length) return;
      const windowBlob = windowPcm.length
        ? createWavBlob(windowPcm, recordingSampleRate)
        : new Blob(windowChunks, { type: chunkMime || 'audio/webm' });
      await analyseChunk(windowBlob, windowPcm.length ? 'audio/wav' : chunkMime, windowStart, windowEnd);
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
    setWorkflowStep(1);
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
        for (const rawSp of newSpecies) {
          const sp = normalizeDetectedSpecies(rawSp, rawSp?._detected_by);
          if (!sp) continue;
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
        .then(result => {
          const results = result?.results || [];
          const species = birdnetToSpecies(results);
          for (const modelResult of results) {
            if (modelResult.error && !(modelResult.detections || []).length) {
              liveModelErrors.set(modelResult.model, modelResult.error);
            } else {
              liveModelErrors.delete(modelResult.model);
            }
          }
          if (species.length) liveModelErrors.delete('BirdNET');
          else liveModelErrors.set('BirdNET', 'No confident bird match yet');
          mergeSpecies(species);
        })
        .catch(err => {
          liveModelErrors.set('BirdNET', err.message || 'Unable to analyse audio.');
          renderLivePanelBody();
        });

      const geminiTask = callGemini(b64, mimeType)
        .then(result => {
          liveModelErrors.delete('Gemini AI');
          const geminiSpecies = (result?.species || [])
            .map(sp => normalizeDetectedSpecies({
              ...sp,
              _detected_by: sp._modelLabel || 'Gemini AI',
              _source: 'gemini',
            }, 'Gemini AI'))
            .filter(Boolean);
          mergeSpecies(geminiSpecies);
        })
        .catch(err => {
          liveModelErrors.set('Gemini AI', err.message || 'Unable to analyse audio.');
          renderLivePanelBody();
        });

      const yamNetTask = callYamNet(b64)
        .then(result => {
          liveModelErrors.delete('YAMNet AudioSet');
          const yamNetSpecies = yamNetToSpecies(result);
          if (!yamNetSpecies.length) liveModelErrors.set('YAMNet AudioSet', 'No animal sound class yet');
          mergeSpecies(yamNetSpecies);
        })
        .catch(err => {
          liveModelErrors.set('YAMNet AudioSet', err.message || 'Unable to analyse audio.');
          renderLivePanelBody();
        });

      await Promise.allSettled([geminiTask, birdnetTask, yamNetTask]);
    } catch {
      // Live chunk failures should not stop recording.
    }
  }

  /* ================================================================
     LIVE PANEL
  ================================================================ */
  const LIVE_MODEL_GROUPS = [
    ...GEMINI_MODEL_GROUPS.map(group => ({ keys: [group.key], label: group.key, type: 'gemini' })),
    { keys: ['BirdNET'], label: 'BirdNET', type: 'birdnet' },
    ...YAMNET_MODEL_GROUPS.map(group => ({ keys: [group.key], label: group.key, type: 'yamnet' })),
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
        const errorText = liveModelErrors.get(group.label) ||
          group.keys.map(key => liveModelErrors.get(key)).find(Boolean) ||
          (group.type === 'birdnet' ? liveModelErrors.get('BirdNET') : null);
        const isFinal = $('live-panel-title')?.textContent?.toLowerCase().includes('final');
        const waitingText = activeChunkAnalyses.size
          ? 'Analyzing current chunk...'
          : isFinal ? 'No result from this model' : 'Listening for matches...';
        const mutedClass = errorText && /unavailable on hugging face/i.test(errorText) ? ' lp-waiting--muted' : '';
        html += `<div class="lp-waiting">
          <span class="lp-waiting-dot"></span> <span class="${mutedClass.trim()}">${esc(errorText || waitingText)}</span>
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

  function createWavBlob(chunks, sampleRate) {
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const samples = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }

    const bytesPerSample = 2;
    const dataSize = samples.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const writeString = (at, value) => {
      for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    let dataOffset = 44;
    for (const sample of samples) {
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(dataOffset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      dataOffset += 2;
    }

    return new Blob([buffer], { type: 'audio/wav' });
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
    const safeMime = (mimeType || 'audio/webm').split(';')[0];
    const body = {
      contents: [{
        parts: [
          { text: GEMINI_PROMPT_BASE },
          { inline_data: { mime_type: safeMime, data: base64Audio } }
        ]
      }],
      generationConfig: { temperature: 0.1 }
    };

    const res = await fetch(apiUrl('/api/analyse'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const d = await res.json(); msg += ': ' + (d.error?.message || res.statusText); } catch {}
      throw new Error(msg);
    }

    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'Gemini error');

    if (Array.isArray(data._modelRuns) && data._modelRuns.length) {
      const runs = data._modelRuns.map(run => {
        let raw = run.response?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!raw) return null;
        raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
        try {
          return { label: run.label || run.model || 'Gemini AI', parsed: JSON.parse(raw) };
        } catch {
          return null;
        }
      }).filter(Boolean);

      if (runs.length) {
        return {
          soundscape_summary: runs[0].parsed.soundscape_summary || '',
          species: runs.flatMap(run => (run.parsed.species || []).map(sp => ({
            ...sp,
            _modelLabel: run.label,
          }))),
        };
      }
    }

    let rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error('Gemini returned empty response.');
    rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

    try {
      return JSON.parse(rawText);
    } catch {
      const err = new Error('JSON parse failed');
      err.raw = rawText;
      throw err;
    }
  }

  /* ================================================================
     BIRDNET — official browser model
     Runs locally in a Web Worker using TensorFlow.js and BirdNET assets.
  ================================================================ */
  async function getBirdNetWorker() {
    if (birdNetWorkerPromise) return birdNetWorkerPromise;

    birdNetWorkerPromise = new Promise((resolve, reject) => {
      if (!window.Worker) {
        reject(new Error('BirdNET needs browser Web Worker support.'));
        return;
      }

      const workerUrl = new URL('assets/birdnet-worker.js', window.location.href);
      workerUrl.searchParams.set('root', 'https://birdnet.cornell.edu/models');
      workerUrl.searchParams.set('tf', 'https://birdnet.cornell.edu/js/tfjs-4.14.0.min.js');
      workerUrl.searchParams.set('lang', 'en_us');

      const worker = new Worker(workerUrl.toString());
      const timeout = setTimeout(() => {
        worker.terminate();
        birdNetWorkerPromise = null;
        reject(new Error('BirdNET model load timed out.'));
      }, 60_000);

      worker.addEventListener('message', event => {
        if (event.data?.message === 'loaded') {
          clearTimeout(timeout);
          resolve(worker);
        }
      });
      worker.addEventListener('error', event => {
        clearTimeout(timeout);
        birdNetWorkerPromise = null;
        reject(new Error(event.message || 'BirdNET model failed to load.'));
      }, { once: true });
    });

    return birdNetWorkerPromise;
  }

  function base64ToArrayBuffer(base64Audio) {
    const binary = atob(base64Audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function decodeWavPcm(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const text = (offset, length) => String.fromCharCode(...new Uint8Array(arrayBuffer, offset, length));
    if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE') throw new Error('Not a PCM WAV file.');

    let offset = 12;
    let fmt = null;
    let dataOffset = 0;
    let dataSize = 0;

    while (offset + 8 <= view.byteLength) {
      const id = text(offset, 4);
      const size = view.getUint32(offset + 4, true);
      const start = offset + 8;
      if (id === 'fmt ') {
        fmt = {
          format: view.getUint16(start, true),
          channels: view.getUint16(start + 2, true),
          sampleRate: view.getUint32(start + 4, true),
          bits: view.getUint16(start + 14, true),
        };
      } else if (id === 'data') {
        dataOffset = start;
        dataSize = size;
      }
      offset = start + size + (size % 2);
    }

    if (!fmt || !dataOffset || !dataSize) throw new Error('Invalid WAV data.');
    if (![1, 3].includes(fmt.format)) throw new Error('Unsupported WAV encoding.');
    const bytesPerSample = fmt.bits / 8;
    const frameCount = Math.floor(dataSize / (bytesPerSample * fmt.channels));
    const mono = new Float32Array(frameCount);

    for (let i = 0; i < frameCount; i++) {
      let sum = 0;
      for (let c = 0; c < fmt.channels; c++) {
        const pos = dataOffset + (i * fmt.channels + c) * bytesPerSample;
        let sample = 0;
        if (fmt.format === 3 && fmt.bits === 32) sample = view.getFloat32(pos, true);
        else if (fmt.bits === 8) sample = (view.getUint8(pos) - 128) / 128;
        else if (fmt.bits === 16) sample = view.getInt16(pos, true) / 32768;
        else if (fmt.bits === 24) {
          let value = view.getUint8(pos) | (view.getUint8(pos + 1) << 8) | (view.getUint8(pos + 2) << 16);
          if (value & 0x800000) value |= 0xff000000;
          sample = value / 8388608;
        } else if (fmt.bits === 32) sample = view.getInt32(pos, true) / 2147483648;
        sum += sample;
      }
      mono[i] = sum / fmt.channels;
    }

    return resamplePcm(mono, fmt.sampleRate, 48000);
  }

  function resamplePcm(pcm, fromRate, toRate) {
    if (fromRate === toRate) return pcm;
    const targetLength = Math.max(1, Math.round(pcm.length * toRate / fromRate));
    const out = new Float32Array(targetLength);
    const ratio = fromRate / toRate;
    for (let i = 0; i < targetLength; i++) {
      const src = i * ratio;
      const j = Math.floor(src);
      const frac = src - j;
      const a = pcm[j] || 0;
      const b = pcm[Math.min(j + 1, pcm.length - 1)] || a;
      out[i] = a + (b - a) * frac;
    }
    return out;
  }

  async function decodeAudioTo48k(base64Audio) {
    const arrayBuffer = base64ToArrayBuffer(base64Audio);
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx || !window.OfflineAudioContext) {
      return decodeWavPcm(arrayBuffer);
    }

    const ctx = new AudioCtx();
    let audioBuffer;
    try {
      audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    } catch (error) {
      if (ctx.state !== 'closed') await ctx.close().catch(() => {});
      return decodeWavPcm(arrayBuffer);
    }
    if (ctx.state !== 'closed') await ctx.close().catch(() => {});

    const channels = audioBuffer.numberOfChannels;
    const sourceLength = audioBuffer.length;
    const mono = new Float32Array(sourceLength);
    for (let c = 0; c < channels; c++) {
      const data = audioBuffer.getChannelData(c);
      for (let i = 0; i < sourceLength; i++) mono[i] += data[i] / channels;
    }

    if (audioBuffer.sampleRate === 48000) return mono;

    const targetLength = Math.max(1, Math.round(sourceLength * 48000 / audioBuffer.sampleRate));
    const offline = new OfflineAudioContext(1, targetLength, 48000);
    const buffer = offline.createBuffer(1, sourceLength, audioBuffer.sampleRate);
    buffer.copyToChannel(mono, 0);
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    return new Float32Array(rendered.getChannelData(0));
  }

  async function callServerBirdNet(base64Audio, mimeType) {
    const res = await fetch(apiUrl('/api/birdnet'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audio_base64: base64Audio,
        mime_type: (mimeType || 'audio/webm').split(';')[0],
      })
    });

    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const d = await res.json(); msg = d.error?.message || msg; } catch {}
      throw new Error(msg);
    }

    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'BirdNET error');
    return data;
  }

  async function callBirdNet(base64Audio, mimeType) {
    try {
      return await callServerBirdNet(base64Audio, mimeType);
    } catch (serverError) {
      console.info('BirdNET server fallback unavailable:', serverError.message);
    }
    return callBrowserBirdNet(base64Audio);
  }

  async function callBrowserBirdNet(base64Audio) {
    const [worker, pcmAudio] = await Promise.all([
      getBirdNetWorker(),
      decodeAudioTo48k(base64Audio),
    ]);

    const id = ++birdNetPredictionId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('BirdNET analysis timed out.'));
      }, 45_000);

      const cleanup = () => {
        clearTimeout(timeout);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      };

      const onError = event => {
        cleanup();
        reject(new Error(event.message || 'BirdNET analysis failed.'));
      };

      const onMessage = event => {
        const data = event.data || {};
        if (data.message !== 'pooled') return;
        cleanup();

        const ranked = (data.pooled || [])
          .sort((a, b) => b.confidence - a.confidence)
          .filter(item => Number.isFinite(Number(item.confidence)));
        const confident = ranked.filter(item => Number(item.confidence) >= BIRDNET_MIN_CONFIDENCE);
        const candidates = (confident.length ? confident : ranked.slice(0, 3).filter(item => Number(item.confidence) >= 0.01))
          .slice(0, 8);
        const detections = candidates
          .map(item => ({
            label: `${item.sciName || ''}_${item.nameI18n || item.name || ''}`,
            commonName: item.nameI18n || item.name || '',
            scientificName: item.sciName || '',
            score: Math.round(Number(item.confidence) * 100),
            source: 'BirdNET',
          }));

        resolve({ results: [{ model: 'BirdNET', detections, predictionId: id }] });
      };

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage({ message: 'predict', pcmAudio, overlapSec: 1.5 }, [pcmAudio.buffer]);
    });
  }

  async function getYamNetWorker() {
    if (yamNetWorkerPromise) return yamNetWorkerPromise;

    yamNetWorkerPromise = new Promise((resolve, reject) => {
      if (!window.Worker) {
        reject(new Error('YAMNet needs browser Web Worker support.'));
        return;
      }

      const workerUrl = new URL('assets/yamnet-worker.js', window.location.href);
      workerUrl.searchParams.set('tf', 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.14.0/dist/tf.min.js');
      const worker = new Worker(workerUrl.toString());
      const timeout = setTimeout(() => {
        worker.terminate();
        yamNetWorkerPromise = null;
        reject(new Error('YAMNet model load timed out.'));
      }, 45_000);

      worker.addEventListener('message', event => {
        if (event.data?.message === 'loaded') {
          clearTimeout(timeout);
          resolve(worker);
        } else if (event.data?.message === 'error') {
          clearTimeout(timeout);
          yamNetWorkerPromise = null;
          reject(new Error(event.data.error || 'YAMNet model failed to load.'));
        }
      });
      worker.addEventListener('error', event => {
        clearTimeout(timeout);
        yamNetWorkerPromise = null;
        reject(new Error(event.message || 'YAMNet model failed to load.'));
      }, { once: true });
    });

    return yamNetWorkerPromise;
  }

  async function callYamNet(base64Audio) {
    const [worker, pcm48k] = await Promise.all([
      getYamNetWorker(),
      decodeAudioTo48k(base64Audio),
    ]);
    const pcmAudio = resamplePcm(pcm48k, 48000, 16000);
    const id = ++yamNetPredictionId;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('YAMNet analysis timed out.'));
      }, 30_000);

      const cleanup = () => {
        clearTimeout(timeout);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      };

      const onError = event => {
        cleanup();
        reject(new Error(event.message || 'YAMNet analysis failed.'));
      };

      const onMessage = event => {
        const data = event.data || {};
        if (data.message === 'error') {
          cleanup();
          reject(new Error(data.error || 'YAMNet analysis failed.'));
          return;
        }
        if (data.message !== 'pooled') return;
        cleanup();
        const detections = (data.pooled || []).map(item => ({
          label: item.label,
          commonName: item.label,
          score: Math.round(Number(item.confidence) * 100),
          source: 'YAMNet AudioSet',
        }));
        resolve({ results: [{ model: 'YAMNet AudioSet', detections, predictionId: id }] });
      };

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage({ message: 'predict', pcmAudio }, [pcmAudio.buffer]);
    });
  }

  function parseBirdNetLabel(det) {
    if (det.commonName || det.scientificName) {
      return {
        common: det.commonName || det.label || 'Unknown bird',
        scientific: det.scientificName || '',
      };
    }

    const [scientific, common] = String(det.label || '').split('_');
    return {
      common: common || String(det.label || 'Unknown bird').replace(/_/g, ' '),
      scientific: common ? scientific : '',
    };
  }

  /* Convert BirdNet raw detections directly into species objects, tagged by model. */
  function birdnetToSpecies(birdnetResults) {
    const out = [];
    for (const result of birdnetResults) {
      for (const det of (result.detections || [])) {
        const label = parseBirdNetLabel(det);
        const species = normalizeDetectedSpecies({
          common_name:      label.common,
          scientific_name:  label.scientific,
          confidence:       det.score >= 70 ? 'high' : det.score >= 40 ? 'medium' : 'low',
          probability_score: det.score,
          sound_description: '',
          _raw_label:       det.label,
          _detected_by:     result.model,
          _source:          'birdnet',
        }, result.model);
        if (species) out.push(species);
      }
    }
    return out;
  }

  function yamNetToSpecies(yamNetResult) {
    const out = [];
    for (const result of (yamNetResult?.results || [])) {
      for (const det of (result.detections || [])) {
        const species = normalizeDetectedSpecies({
          common_name: det.commonName || det.label,
          scientific_name: '',
          confidence: det.score >= 70 ? 'high' : det.score >= 40 ? 'medium' : 'low',
          probability_score: det.score,
          sound_description: 'YAMNet detected this broad animal sound class.',
          _raw_label: det.label,
          _detected_by: result.model || 'YAMNet AudioSet',
          _source: 'yamnet',
        }, result.model || 'YAMNet AudioSet');
        if (species) out.push(species);
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

  async function enrichSpeciesReference(sp) {
    const image = await fetchSpeciesImage(sp.scientific_name, sp._raw_label || sp.common_name).catch(() => null);
    if (image) sp.image = image;
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

    const sourceClass = sp._source === 'birdnet'
      ? 'source-badge--birdnet'
      : sp._source === 'yamnet' ? 'source-badge--yamnet' : 'source-badge--gemini';
    const sourceBadge = `<span class="source-badge ${sourceClass}">${esc(sp._detected_by || 'Gemini')}</span>`;

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

    const [birdnetRaw, geminiResult, yamNetResult] = await Promise.allSettled([
      callBirdNet(b64, mimeType),
      callGemini(b64, mimeType),
      callYamNet(b64),
    ]);

    const birdnetResults = (birdnetRaw.status === 'fulfilled' ? birdnetRaw.value.results : []) || [];
    const birdnetSpecies = birdnetToSpecies(birdnetResults);
    const yamNetSpecies = yamNetResult.status === 'fulfilled'
      ? yamNetToSpecies(yamNetResult.value)
      : [];
    const modelMessages = new Map();
    if (birdnetRaw.status === 'rejected') {
      modelMessages.set('BirdNET', birdnetRaw.reason?.message || 'BirdNET could not analyze this audio.');
    }
    if (yamNetResult.status === 'rejected') {
      modelMessages.set('YAMNet AudioSet', yamNetResult.reason?.message || 'YAMNet could not analyze this audio.');
    }

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
    const geminiSpecies      = (gemini.species || [])
      .map(sp => normalizeDetectedSpecies({
        ...sp,
        _detected_by: sp._modelLabel || 'Gemini AI',
        _source: 'gemini',
      }, 'Gemini AI'))
      .filter(Boolean);

    const species = [...geminiSpecies, ...birdnetSpecies, ...yamNetSpecies];

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
    renderSpeciesGrid(detectedSpecies, modelMessages);
    setPanelStatus('Results ready', 'results');
    renderLiveDetections('results', detectedSpecies);

    const summaryEl = $('soundscape-summary');
    if (summaryEl) summaryEl.textContent = soundscape_summary || '';

    // Scroll to species
    setTimeout(() => {
      $('species-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 200);

    // Fetch Wikipedia photos.
    await Promise.allSettled(
      detectedSpecies.map(async sp => {
        await enrichSpeciesReference(sp);
        updateCard(sp);
        renderLiveDetections('results', detectedSpecies);
      })
    );

    setRecordState('idle');
  }

  /* ================================================================
     SPECIES GRID — grouped by detection model
  ================================================================ */
  const MODEL_GROUPS = [
    ...GEMINI_MODEL_GROUPS.map(group => ({
      keys:  [group.key],
      label: group.key,
      desc:  group.desc,
      type:  'gemini',
      icon:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
    })),
    {
      keys:  ['BirdNET'],
      label: 'BirdNET',
      desc:  'Local browser model',
      type:  'birdnet',
      icon:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 6c0 0-4.5 1.5-7 2L12 4l-2 2-4-1s2 4 4 5H4l2 3h14c2-1 3-3 2-7z"/></svg>`,
    },
    ...YAMNET_MODEL_GROUPS.map(group => ({
      keys:  [group.key],
      label: group.key,
      desc:  group.desc,
      type:  'yamnet',
      icon:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12c4-8 12-8 16 0"/><path d="M4 12c4 8 12 8 16 0"/><circle cx="12" cy="12" r="2"/><path d="M12 4v2M12 18v2M4 12H2M22 12h-2"/></svg>`,
    })),
  ];

  function renderSpeciesGrid(species, modelMessages = new Map()) {
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
        list.innerHTML = `<div class="model-empty">${esc(modelMessages.get(group.label) || 'No confident match from this model')}</div>`;
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

    $('record-btn').addEventListener('click', () => {
      if (isProcessing) return;
      if (isRecording) { stopRecording(); return; }
      startRecording();
    });

  }

  // Bootstrap
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
