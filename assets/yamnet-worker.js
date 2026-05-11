// Lightweight browser audio event model using Google YAMNet / AudioSet.
// Runs fully client-side with TensorFlow.js. No Python, Llama, or API token.
const params = new URL(self.location.href).searchParams;
const TF_PATH = params.get('tf') || 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.14.0/dist/tf.min.js';
importScripts(TF_PATH);

const MODEL_URL = 'https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1';
const LABELS_URL = 'https://raw.githubusercontent.com/tensorflow/models/master/research/audioset/yamnet/yamnet_class_map.csv';
const ANIMAL_RE = /(animal|bird|chirp|tweet|squawk|crow|caw|owl|hoot|duck|goose|frog|croak|insect|cricket|cicada|bee|buzz|mosquito|fly|dog|bark|cat|meow|mammal|horse|neigh|cow|moo|sheep|goat|pig|rooster|chicken|turkey|whale|dolphin)/i;

let model = null;
let labels = null;

main().catch(error => {
  postMessage({ message: 'error', error: error.message || 'YAMNet failed to load.' });
});

async function main() {
  try {
    await tf.setBackend('webgl');
  } catch {
    await tf.setBackend('cpu');
  }
  await tf.ready();
  model = await tf.loadGraphModel(MODEL_URL, { fromTFHub: true });
  labels = await loadLabels();
  postMessage({ message: 'loaded' });
}

async function loadLabels() {
  const csv = await fetch(LABELS_URL).then(res => {
    if (!res.ok) throw new Error('Unable to load YAMNet labels.');
    return res.text();
  });
  return csv.trim().split(/\r?\n/).slice(1).map(line => {
    const match = line.match(/^(\d+),([^,]+),(.+)$/);
    if (!match) return '';
    return match[3].replace(/^"|"$/g, '').replace(/""/g, '"');
  });
}

self.onmessage = async event => {
  const data = event.data || {};
  if (data.message !== 'predict') return;
  try {
    const waveform = data.pcmAudio || new Float32Array(0);
    if (!waveform.length) {
      postMessage({ message: 'pooled', pooled: [] });
      return;
    }

    const scoresTensor = tf.tidy(() => {
      const input = tf.tensor1d(waveform);
      const output = model.execute({ 'waveform:0': input }, 'Identity:0');
      return output;
    });

    const scores = await scoresTensor.array();
    scoresTensor.dispose();
    const classCount = labels.length;
    const maxScores = new Float32Array(classCount);

    for (const frame of scores) {
      for (let i = 0; i < Math.min(classCount, frame.length); i++) {
        if (frame[i] > maxScores[i]) maxScores[i] = frame[i];
      }
    }

    const pooled = Array.from(maxScores, (confidence, index) => ({
      index,
      label: labels[index] || `Class ${index}`,
      confidence,
    }))
      .filter(item => item.confidence >= 0.08 && ANIMAL_RE.test(item.label))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 8);

    postMessage({ message: 'pooled', pooled });
  } catch (error) {
    postMessage({ message: 'error', error: error.message || 'YAMNet analysis failed.' });
  }
};
