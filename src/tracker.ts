// ─── Time Tracking & In-Memory State ─────────────────────────────────────────
// Manages all usage state for the NoScroll Layer 1 skill.
//
// ⚠️  Vercel caveat: in-memory state persists within a *warm* serverless
//     instance but resets on cold starts. For a single-user personal tool
//     this is acceptable. For multi-user production use, replace `state`
//     with Upstash KV or a small Postgres/Redis instance.

import { AudioPattern } from './audio';

// ── Types ─────────────────────────────────────────────────────────────────────

export type App  = 'instagram' | 'youtube';
export type Mode = 'normal'    | 'weekend';

interface SessionState {
  openTime:         Date | null;
  openCount:        number;   // number of times opened today
  extraTimeGranted: boolean;  // user already claimed their 5-min bonus today
  alertFiredAt:     number | null; // epoch ms — prevents Signal 1 + Signal 2 double-firing
}

interface DailyUsage {
  date:      string;  // YYYY-MM-DD, resets on new calendar day
  instagram: number;  // accumulated minutes today
  youtube:   number;
  alerts:    number;
}

interface AudioState {
  pattern:   AudioPattern | null;
  updatedAt: number | null;   // epoch ms of last update
}

interface AppState {
  mode:     Mode;
  usage:    DailyUsage;
  sessions: Record<App, SessionState>;
  audio:    AudioState;
  userId:   string | null; // Trace proxy user_id captured from first platform event
}

// ── Daily limits ──────────────────────────────────────────────────────────────

export const LIMITS = {
  normal: {
    instagram: 15,  // minutes / day
    youtube:   15,
    combined:  30,
    grace:      5,  // sessions shorter than this are not counted (accidental opens)
    extra:      5,  // bonus minutes given on "more time" request
  },
  weekend: {
    instagram: 30,
    youtube:   30,
    combined:  60,
    grace:      5,
    extra:     10,
  },
} as const;

export type Limits = typeof LIMITS[Mode];

// ── In-memory state ────────────────────────────────────────────────────────────

let state: AppState = {
  mode:    'normal',
  usage:   { date: '', instagram: 0, youtube: 0, alerts: 0 },
  sessions: {
    instagram: { openTime: null, openCount: 0, extraTimeGranted: false, alertFiredAt: null },
    youtube:   { openTime: null, openCount: 0, extraTimeGranted: false, alertFiredAt: null },
  },
  audio:   { pattern: null, updatedAt: null },
  userId:  null,
};

// ── Private helpers ────────────────────────────────────────────────────────────

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function ensureDailyReset(): void {
  const today = todayISO();
  if (state.usage.date === today) return;

  console.log(`[Tracker] New day (${today}) — resetting counters`);
  state.usage = { date: today, instagram: 0, youtube: 0, alerts: 0 };
  state.sessions = {
    instagram: { openTime: null, openCount: 0, extraTimeGranted: false, alertFiredAt: null },
    youtube:   { openTime: null, openCount: 0, extraTimeGranted: false, alertFiredAt: null },
  };
  state.audio = { pattern: null, updatedAt: null };
}

function getLimits(): Limits {
  return LIMITS[state.mode];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Called when iOS Shortcut reports an app was opened. */
export function handleOpen(app: App, timestamp?: string): { openCount: number } {
  ensureDailyReset();
  const session         = state.sessions[app];
  const t               = timestamp ? new Date(timestamp) : new Date();
  session.openTime      = isNaN(t.getTime()) ? new Date() : t;
  session.openCount    += 1;
  session.alertFiredAt  = null; // reset debounce — new session, fresh slate
  console.log(`[Tracker] ${app} opened — #${session.openCount} today`);
  return { openCount: session.openCount };
}

// ── handleClose return types ──

export interface CloseResult {
  logged:           true;
  belowGrace:       boolean;   // true = session was too short to count
  sessionMins:      number;
  dailyMins:        number;
  combinedMins:     number;
  limits:           Limits;
  extraTimeGranted: boolean;
}

export type HandleCloseReturn =
  | CloseResult
  | { logged: false; reason: string };

/** Called when iOS Shortcut reports an app was closed. */
export function handleClose(app: App, timestamp?: string): HandleCloseReturn {
  ensureDailyReset();
  const session = state.sessions[app];

  if (!session.openTime) {
    return { logged: false, reason: 'No open time on record — event skipped' };
  }

  const t          = timestamp ? new Date(timestamp) : new Date();
  const closeTime  = isNaN(t.getTime()) ? new Date() : t;
  const durationMs = closeTime.getTime() - session.openTime.getTime();
  const durationMins = Math.max(0, Math.min(durationMs / 60_000, 120)); // clamp 0–120
  session.openTime   = null; // clear session regardless

  const limits     = getLimits();
  const belowGrace = durationMins < limits.grace;

  // Sessions shorter than the grace period are NOT added to the daily total.
  // Covers: accidental opens, notification taps, quick DM checks.
  if (!belowGrace) {
    state.usage[app] += durationMins;
  }

  const combinedMins = state.usage.instagram + state.usage.youtube;

  console.log(
    `[Tracker] ${app} closed — ` +
    `session: ${durationMins.toFixed(1)}m${belowGrace ? ' (grace, not counted)' : ''} | ` +
    `daily: ${state.usage[app].toFixed(1)}m | combined: ${combinedMins.toFixed(1)}m`
  );

  return {
    logged:           true,
    belowGrace,
    sessionMins:      durationMins,
    dailyMins:        state.usage[app],
    combinedMins,
    limits,
    extraTimeGranted: session.extraTimeGranted,
  };
}

/**
 * Grant the user extra minutes for an app.
 * Subtracts `limits.extra` from the current daily total so the window
 * effectively extends without changing the limit constant.
 */
export function grantExtraTime(app: App): number {
  ensureDailyReset();
  const extra = getLimits().extra;
  state.usage[app] = Math.max(0, state.usage[app] - extra);
  state.sessions[app].extraTimeGranted = true;
  console.log(`[Tracker] Extra ${extra}m granted for ${app}`);
  return extra;
}

/** Switch between normal and weekend mode. */
export function setMode(mode: Mode): void {
  state.mode = mode;
  console.log(`[Tracker] Mode → ${mode}`);
}

/** Store the Trace platform user_id from the first webhook event for push use. */
export function setUserId(id: string): void {
  if (!state.userId) {
    state.userId = id;
    console.log(`[Tracker] Stored user_id: ${id}`);
  }
}

export function getUserId(): string | null {
  return state.userId;
}

/** Update audio state from the latest Trace media.audio webhook event. */
export function updateAudioPattern(pattern: AudioPattern): void {
  state.audio = { pattern, updatedAt: Date.now() };
}

/**
 * Return the current audio pattern, or null if the last update is older
 * than `windowMs` (default 90 s). Stale audio is treated as absent.
 */
export function getAudioPattern(windowMs = 90_000): AudioPattern | null {
  if (!state.audio.updatedAt || !state.audio.pattern) return null;
  return (Date.now() - state.audio.updatedAt) < windowMs
    ? state.audio.pattern
    : null;
}

/**
 * Returns true if an alert already fired for this app within the debounce window.
 * Prevents Signal 1 (/track) and Signal 2 (/webhook audio) from both firing
 * for the same scrolling session.
 */
export function hasRecentAlert(app: App, windowMs = 10 * 60_000): boolean {
  ensureDailyReset();
  const { alertFiredAt } = state.sessions[app];
  return !!alertFiredAt && (Date.now() - alertFiredAt) < windowMs;
}

/** Mark that an alert fired for this app. Call instead of incrementAlerts(). */
export function markAlertFired(app: App): void {
  ensureDailyReset();
  state.sessions[app].alertFiredAt = Date.now();
  state.usage.alerts += 1;
}

export function incrementAlerts(): void {
  ensureDailyReset();
  state.usage.alerts += 1;
}

/** Full status snapshot returned by GET /status. */
export function getStatus() {
  ensureDailyReset();
  const combined = state.usage.instagram + state.usage.youtube;
  const limits   = getLimits();
  return {
    instagram_mins: round1(state.usage.instagram),
    youtube_mins:   round1(state.usage.youtube),
    combined_mins:  round1(combined),
    alerts_today:   state.usage.alerts,
    mode:           state.mode,
    limits: {
      instagram: limits.instagram,
      youtube:   limits.youtube,
      combined:  limits.combined,
    },
    open_now: {
      instagram: !!state.sessions.instagram.openTime,
      youtube:   !!state.sessions.youtube.openTime,
    },
  };
}
