// ─── Audio Pattern Detection ──────────────────────────────────────────────────
// Analyses raw 16-bit PCM audio (base64-encoded) sent by the Trace platform
// to distinguish doom-scrolling from legitimate use.
//
// Doom-scroll signature (Instagram Reels / YouTube Shorts):
//   → audio clips switch every 5–15 s → rapid silence↔activity transitions
//
// Legitimate-use signatures:
//   continuous   — sustained audio, few transitions (music, tutorial, podcast)
//   conversation — mid-amplitude, speech-like variation (meeting, phone call)
//   silent       — mostly quiet (typing, reading, DM replies)
//
// Assumes 16-bit signed little-endian PCM, 16 kHz, mono.
// Falls back gracefully for unknown formats.

export type AudioPattern = 'doom_scrolling' | 'continuous' | 'silent' | 'conversation';

export interface AudioAnalysis {
  pattern:    AudioPattern;
  confidence: number;   // 0–1
  reason:     string;   // human-readable, logged server-side
}

// ── Tuning constants ──────────────────────────────────────────────────────────
const SAMPLES_PER_CHUNK        = 8_000; // ~500 ms of audio at 16 kHz
const SILENCE_THRESHOLD        = 500;   // RMS < this = silent chunk (0–32 767 scale)
const DOOM_TRANSITIONS_PER_MIN = 2;     // min transitions/min to flag as doom-scrolling

// ── Main export ───────────────────────────────────────────────────────────────

export function analyzeAudio(base64Data: string | null | undefined): AudioAnalysis {

  // ── Guard: no data ────────────────────────────────────────────────────────
  if (!base64Data) {
    return { pattern: 'silent', confidence: 1.0, reason: 'No audio data provided' };
  }

  // ── Decode base64 → Buffer ────────────────────────────────────────────────
  let buf: Buffer;
  try {
    buf = Buffer.from(base64Data, 'base64');
  } catch {
    return { pattern: 'silent', confidence: 0.5, reason: 'Base64 decode failed' };
  }

  if (buf.length < 200) {
    return { pattern: 'silent', confidence: 0.8, reason: 'Buffer too short to analyse' };
  }

  // ── Compute RMS amplitude for each ~500 ms chunk ──────────────────────────
  // Each 16-bit sample = 2 bytes (Int16LE).
  const rmsChunks: number[] = [];
  const byteChunk = SAMPLES_PER_CHUNK * 2;

  for (let offset = 0; offset + 2 <= buf.length; offset += byteChunk) {
    const end = Math.min(offset + byteChunk, buf.length - 1);
    let sumSq = 0, n = 0;
    for (let i = offset; i + 1 < end; i += 2) {
      const s = buf.readInt16LE(i);
      sumSq += s * s;
      n++;
    }
    if (n > 0) rmsChunks.push(Math.sqrt(sumSq / n));
  }

  if (rmsChunks.length === 0) {
    return { pattern: 'silent', confidence: 0.9, reason: 'No valid PCM chunks decoded' };
  }

  // ── Silence ratio ─────────────────────────────────────────────────────────
  const silentCount  = rmsChunks.filter(r => r < SILENCE_THRESHOLD).length;
  const silenceRatio = silentCount / rmsChunks.length;

  if (silenceRatio > 0.85) {
    return {
      pattern:    'silent',
      confidence: 0.9,
      reason:     `${Math.round(silenceRatio * 100)}% of chunks are silent`,
    };
  }

  // ── Transition count (silence ↔ activity boundaries) ─────────────────────
  let transitions = 0;
  for (let i = 1; i < rmsChunks.length; i++) {
    const prevSilent = rmsChunks[i - 1] < SILENCE_THRESHOLD;
    const currSilent = rmsChunks[i]     < SILENCE_THRESHOLD;
    if (prevSilent !== currSilent) transitions++;
  }

  // Each chunk ≈ 0.5 s → total duration in minutes:
  const durationMins = (rmsChunks.length * 0.5) / 60;
  const transPerMin  = durationMins > 0 ? transitions / durationMins : 0;

  // ── Doom scrolling ────────────────────────────────────────────────────────
  if (transPerMin >= DOOM_TRANSITIONS_PER_MIN && silenceRatio < 0.7) {
    return {
      pattern:    'doom_scrolling',
      confidence: Math.min(0.95, 0.5 + transPerMin * 0.08),
      reason:     `${transPerMin.toFixed(1)} transitions/min — reel-like audio switching`,
    };
  }

  // ── Conversation detection ─────────────────────────────────────────────────
  // Speech has moderate amplitude, natural variation, and short natural pauses.
  const avgRms   = rmsChunks.reduce((a, b) => a + b, 0) / rmsChunks.length;
  const variance = rmsChunks.reduce((s, r) => s + (r - avgRms) ** 2, 0) / rmsChunks.length;
  const cv       = avgRms > 0 ? Math.sqrt(variance) / avgRms : 0; // coefficient of variation

  if (cv < 0.45 && avgRms > SILENCE_THRESHOLD && avgRms < 20_000 && silenceRatio < 0.3) {
    return {
      pattern:    'conversation',
      confidence: 0.7,
      reason:     `Speech-like amplitude (CV=${cv.toFixed(2)}, avg RMS=${Math.round(avgRms)})`,
    };
  }

  // ── Continuous audio ───────────────────────────────────────────────────────
  // Music, tutorials, podcasts: mostly active, very few transitions.
  if (silenceRatio < 0.2 && transitions <= 2) {
    return {
      pattern:    'continuous',
      confidence: 0.8,
      reason:     `Sustained audio — only ${transitions} total transitions`,
    };
  }

  // ── Default: mixed, but not doom scrolling ─────────────────────────────────
  return {
    pattern:    'continuous',
    confidence: 0.55,
    reason:     'Mixed audio — no doom-scroll signature detected',
  };
}
