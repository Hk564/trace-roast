// ─── Trace Roast — NoScroll Layer 1 ──────────────────────────────────────────
// A Trace Skill that holds you accountable for Instagram and YouTube usage.
//
// Signal sources:
//   iOS Shortcuts  → POST /track    (app open / close events)
//   Trace platform → POST /webhook  (audio analysis for doom-scroll detection)
//   Trace platform → POST /mcp      (voice commands: "weekend mode", "more time")
//
// Alert logic:
//   Single signal (Shortcuts only, no audio)       → log, no alert until limit
//   Two signals   (Shortcuts + doom-scroll audio)  → alert fires immediately
//   Limit reached, audio absent / silent           → "No audio but I know what you're doing."
//   Limit reached, audio confirms scrolling        → "I can hear the reels. Don't even try."
//   Legitimate audio (music / tutorial / meeting)  → alert suppressed
//
// Response format for all endpoints:
//   { "tts": "message spoken on glasses", "status": "alerted" | "logged" | "ignored" }

import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { verifyTraceSignature } from './hmac';
import { analyzeAudio } from './audio';
import { getRoast } from './roast';
import {
  handleOpen, handleClose, grantExtraTime,
  setMode, setUserId, getUserId,
  updateAudioPattern, getAudioPattern,
  incrementAlerts, hasRecentAlert, markAlertFired, getStatus,
  App, Mode,
} from './tracker';

dotenv.config();

const app = express();
const PORT            = process.env.PORT            || 3000;
const TRACE_HMAC_SECRET = process.env.TRACE_HMAC_SECRET || '';
const TRACE_SKILL_ID  = process.env.TRACE_SKILL_ID  || '';
const BRAIN_BASE_URL     = process.env.BRAIN_BASE_URL     || 'https://brain.endlessriver.ai';
const TRACE_USER_ID      = process.env.TRACE_USER_ID      || '';
const TRACE_PROJECT_TOKEN = process.env.TRACE_PROJECT_TOKEN || TRACE_HMAC_SECRET;

// Capture rawBody BEFORE JSON parsing — required for HMAC verification.
app.use(
  express.json({
    verify: (req: any, _res, buf) => { req.rawBody = buf; },
  })
);

// ── Shared response builder ───────────────────────────────────────────────────

type AlertStatus = 'alerted' | 'logged' | 'ignored';

function ttsReply(tts: string | null, status: AlertStatus, extra?: object) {
  return { tts, status, ...extra };
}

// ─── 🔗 POST /pair ───────────────────────────────────────────────────────────
// One-time endpoint to register your Trace user_id so proactive push works.
// Call once from terminal: curl -X POST https://trace-roast.vercel.app/pair \
//   -H "Content-Type: application/json" -d '{"user_id":"YOUR_ID_HERE"}'

app.post('/pair', (req: Request, res: Response) => {
  const { user_id } = req.body as { user_id?: string };
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  setUserId(user_id);
  console.log(`[Pair] Registered user_id: ${user_id}`);
  return res.json({ ok: true, user_id });
});

// ─── 🩺 GET /health ───────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'trace-roast', uptime: process.uptime() });
});

// ─── 📊 GET /status ───────────────────────────────────────────────────────────
// Returns today's usage summary.

app.get('/status', (_req: Request, res: Response) => {
  res.json(getStatus());
});

// ─── 🌙 POST /mode ────────────────────────────────────────────────────────────
// Toggle between normal and weekend mode.
// Body: { "mode": "weekend" | "normal" }

app.post('/mode', (req: Request, res: Response) => {
  const { mode } = req.body as { mode?: string };

  if (!mode || !['normal', 'weekend'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be "normal" or "weekend"' });
  }

  setMode(mode as Mode);

  const tts = mode === 'weekend'
    ? getRoast('WEEKEND_MODE')
    : getRoast('BACK_TO_NORMAL');

  return res.json(ttsReply(tts, 'alerted', { mode }));
});

// ─── ⏱️  POST /more-time ──────────────────────────────────────────────────────
// Grant an extra 5 minutes for a specific app.
// Body: { "app": "instagram" | "youtube" }
// Called by iOS Shortcut or voice command via MCP.

app.post('/more-time', (req: Request, res: Response) => {
  const { app: appName } = req.body as { app?: string };

  if (!appName || !['instagram', 'youtube'].includes(appName)) {
    return res.status(400).json({ error: 'app must be "instagram" or "youtube"' });
  }

  const extra = grantExtraTime(appName as App);
  return res.json(ttsReply(getRoast('MORE_TIME'), 'alerted', { extra_mins: extra }));
});

// ─── 📱 POST /track ───────────────────────────────────────────────────────────
// Receives app open / close events from iOS Shortcuts.
//
// Body:
//   { "app": "instagram" | "youtube",
//     "event": "opened" | "closed",
//     "timestamp": "ISO 8601 string" }
//
// Returns: { tts, status }
// The iOS Shortcut reads `tts` and triggers the Trace glasses speaker.

app.post('/track', (req: Request, res: Response) => {
  // Debug: log raw body and content-type so we can see what the Shortcut sends
  console.log('[Track] content-type:', req.headers['content-type']);
  console.log('[Track] raw body:', (req as any).rawBody?.toString());
  console.log('[Track] parsed body:', JSON.stringify(req.body));

  // Normalise to lowercase so "Instagram", "OPENED" etc. all work
  const appName  = (req.body?.app   as string | undefined)?.toLowerCase().trim();
  const event    = (req.body?.event as string | undefined)?.toLowerCase().trim();
  const timestamp = req.body?.timestamp as string | null | undefined;

  // ── Validate ────────────────────────────────────────────────────────────
  if (!appName || !event) {
    return res.status(400).json({ error: 'Required: app, event', received: req.body });
  }
  if (!['instagram', 'youtube'].includes(appName)) {
    return res.status(400).json({ error: 'app must be "instagram" or "youtube"', received_app: appName });
  }
  if (!['opened', 'closed', 'timeout'].includes(event)) {
    return res.status(400).json({ error: 'event must be "opened", "closed", or "timeout"', received_event: event });
  }

  const trackedApp = appName as App;

  // ── App opened ──────────────────────────────────────────────────────────
  if (event === 'opened') {
    const { openCount } = handleOpen(trackedApp, timestamp);

    // Third or more open of the same app today — call it out immediately.
    if (openCount >= 3 && !hasRecentAlert(trackedApp)) {
      markAlertFired(trackedApp);
      firePushNotification(getRoast('THIRD_OPEN'));
      return res.json(ttsReply(getRoast('THIRD_OPEN'), 'alerted', { open_count: openCount }));
    }

    return res.json(ttsReply(null, 'logged', { open_count: openCount }));
  }

  // ── Timeout — Shortcut's 15-min timer fired ─────────────────────────────
  // The Shortcut IS the clock. When it says 15 mins are up, we trust it and
  // fire the roast directly — no server-side time tracking needed.
  if (event === 'timeout') {
    if (hasRecentAlert(trackedApp)) {
      return res.json(ttsReply(null, 'logged', { note: 'alert already fired this session' }));
    }

    const audio = getAudioPattern();

    // Legitimate use — suppress
    if (audio === 'continuous' || audio === 'conversation') {
      return res.json(ttsReply(null, 'logged', { note: `audio=${audio}, suppressed` }));
    }

    markAlertFired(trackedApp);

    const tts = audio === 'doom_scrolling'
      ? getRoast('AUDIO_CONFIRMS')
      : getRoast('FIRST_ALERT');

    firePushNotification(tts);
    return res.json(ttsReply(tts, 'alerted'));
  }

  // ── App closed ──────────────────────────────────────────────────────────
  const result = handleClose(trackedApp, timestamp);

  if (!result.logged) {
    return res.json(ttsReply(null, 'ignored', { reason: result.reason }));
  }

  const { belowGrace, dailyMins, combinedMins, limits, extraTimeGranted } = result;
  const audio = getAudioPattern(); // null if stale / absent

  // Sessions under the grace period are not counted — no alert possible.
  if (belowGrace) {
    return res.json(ttsReply(null, 'logged', { note: 'below grace period' }));
  }

  // ── Alert decision ──────────────────────────────────────────────────────
  //
  // Debounce: if Signal 2 (/webhook audio) already fired for this app within
  // the last 10 minutes, Signal 1 (/track) stays silent. No double-roasting.
  //
  // Priority 1: combined limit (instagram + youtube together)
  if (combinedMins >= limits.combined) {
    if (hasRecentAlert(trackedApp)) {
      return res.json(ttsReply(null, 'logged', { note: 'alert already fired this session' }));
    }
    markAlertFired(trackedApp);
    const tts = audio === 'doom_scrolling'
      ? getRoast('AUDIO_CONFIRMS')   // two signals
      : getRoast('COMBINED_LIMIT');  // single signal — combined limit always alerts
    firePushNotification(tts);
    return res.json(ttsReply(tts, 'alerted', { combined_mins: combinedMins }));
  }

  // Priority 2: per-app daily limit
  if (dailyMins >= limits[trackedApp]) {

    // Legitimate audio (music, tutorial, meeting) → suppress entirely.
    if (audio === 'continuous' || audio === 'conversation') {
      console.log(`[Track] ${trackedApp} limit hit but audio = ${audio} — suppressing alert`);
      return res.json(ttsReply(null, 'logged', { note: `audio=${audio}, suppressed` }));
    }

    // Signal 2 already fired — don't stack Signal 1 on top.
    if (hasRecentAlert(trackedApp)) {
      return res.json(ttsReply(null, 'logged', { note: 'alert already fired this session' }));
    }

    markAlertFired(trackedApp);

    let tts: string;

    if (audio === 'doom_scrolling') {
      tts = getRoast('AUDIO_CONFIRMS');   // two signals
    } else if (extraTimeGranted) {
      tts = getRoast('EXCEEDS_AGAIN');    // used bonus time, hit again
    } else if (audio === 'silent') {
      tts = getRoast('SILENT_SCROLLING'); // caught silent scrolling
    } else {
      tts = getRoast('FIRST_ALERT');      // first hit, no audio data
    }

    firePushNotification(tts);
    return res.json(ttsReply(tts, 'alerted', { daily_mins: dailyMins }));
  }

  // Under all limits — just log.
  return res.json(ttsReply(null, 'logged', { daily_mins: dailyMins, combined_mins: combinedMins }));
});

// ─── 🟢 POST /webhook ────────────────────────────────────────────────────────
// Receives events from the Trace platform (media.photo, media.audio, etc.).
// Pattern: return 202 immediately, process asynchronously, POST to callback_url.

app.post('/webhook', verifyTraceSignature(TRACE_HMAC_SECRET), async (req: Request, res: Response) => {
  const { event, user, request_id, callback_url } = req.body;

  if (!event) {
    return res.status(400).json({ error: 'Missing event' });
  }

  console.log(`[Webhook] ${event.channel} for user ${user?.id ?? 'unknown'}`);

  // Store user_id so /track can push proactive notifications if needed.
  if (user?.id) setUserId(user.id);

  // Acknowledge immediately — never block the Trace platform.
  res.status(202).json({ status: 'accepted' });

  // Process asynchronously.
  processEvent({ event, user, requestId: request_id, callbackUrl: callback_url })
    .catch((err) => console.error('[Webhook] processing error:', err));
});

async function processEvent(opts: {
  event:       any;
  user:        any;
  requestId:   string;
  callbackUrl: string;
}) {
  const { event, requestId, callbackUrl } = opts;

  // ── media.audio — doom-scroll detection ─────────────────────────────────
  if (event.channel === 'media.audio') {
    // Audio can arrive as base64 in event.data or as a presigned URL in
    // event.items[0].url. We support event.data (base64) as per spec.
    const analysis = analyzeAudio(event.data ?? null);
    updateAudioPattern(analysis.pattern);
    console.log(
      `[Audio] ${analysis.pattern} (conf ${analysis.confidence.toFixed(2)}) — ${analysis.reason}`
    );

    // Two-signal check: audio confirms doom scrolling AND app is over the limit.
    // Only fires if Signal 1 (/track) hasn't already alerted — no overlap.
    if (analysis.pattern === 'doom_scrolling') {
      const status = getStatus();
      const overInstagram = status.instagram_mins >= status.limits.instagram;
      const overYoutube   = status.youtube_mins   >= status.limits.youtube;
      const overCombined  = status.combined_mins  >= status.limits.combined;

      // Fire for whichever over-limit app hasn't been alerted yet this session.
      const targetApp = (overInstagram && !hasRecentAlert('instagram')) ? 'instagram'
                      : (overYoutube   && !hasRecentAlert('youtube'))   ? 'youtube'
                      : null;

      if (targetApp && (overInstagram || overYoutube || overCombined)) {
        markAlertFired(targetApp);
        const tts = getRoast('AUDIO_CONFIRMS');
        await postCallback(callbackUrl, requestId, [roastNotification(tts)]);
        return;
      }
    }

    // Conversation / meeting audio → send a silent acknowledgement.
    if (analysis.pattern === 'conversation') {
      console.log('[Audio] Conversation detected — alerts suppressed');
      // No callback needed; just update the audio state (already done above).
      return;
    }

    // Under limit and not doom scrolling — log silently, no notification.
    return;
  }

  // ── All other channels — default template response ────────────────────────
  const responses = [
    {
      type:    'notification',
      content: { title: 'NoScroll', body: `Processed ${event.channel}` },
    },
  ];
  await postCallback(callbackUrl, requestId, responses);
}

// ─── 🔵 POST /mcp ────────────────────────────────────────────────────────────
// JSON-RPC 2.0 endpoint for voice dialog from the Trace glasses.
// Handles: "weekend mode", "normal mode", "more time", "status" queries.
// All other utterances echo back (template default).

app.post('/mcp', async (req: Request, res: Response) => {
  const { jsonrpc, method, params, id } = req.body;
  if (jsonrpc !== '2.0') return res.status(400).send('Invalid JSON-RPC');

  // Capture user_id from MCP requests (glasses voice commands)
  const mcpUserId = req.body?.user?.id ?? req.body?.params?.user_id ?? null;
  if (mcpUserId) {
    setUserId(mcpUserId);
    console.log(`[MCP] Captured user_id: ${mcpUserId}`);
  }
  console.log('[MCP] request body:', JSON.stringify(req.body).slice(0, 300));

  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name:        'handle_dialog',
            description: 'NoScroll accountability assistant. Handles usage queries and mode changes.',
            inputSchema: {
              type:       'object',
              properties: { utterance: { type: 'string' } },
            },
          },
        ],
      },
    });
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;

    if (name === 'handle_dialog') {
      const utterance: string = (args?.utterance ?? '').toLowerCase().trim();
      const status            = getStatus();

      // ── Voice command: weekend mode ──────────────────────────────────────
      if (/weekend\s*mode|relax|day off/i.test(utterance)) {
        setMode('weekend');
        const tts = getRoast('WEEKEND_MODE');
        return res.json(mcpTextResponse(id, tts, [
          { type: 'feed_item', content: { title: 'Weekend mode activated', story: tts } },
        ]));
      }

      // ── Voice command: back to normal ────────────────────────────────────
      if (/normal\s*mode|back to normal|focus mode/i.test(utterance)) {
        setMode('normal');
        const tts = getRoast('BACK_TO_NORMAL');
        return res.json(mcpTextResponse(id, tts, []));
      }

      // ── Voice command: more time ─────────────────────────────────────────
      if (/more time|5 more|five more|give me more|extend/i.test(utterance)) {
        // Grant extra time for whichever app is currently open, or instagram by default.
        const targetApp: App = utterance.includes('youtube') ? 'youtube' : 'instagram';
        grantExtraTime(targetApp);
        const tts = getRoast('MORE_TIME');
        return res.json(mcpTextResponse(id, tts, []));
      }

      // ── Voice command: status query ──────────────────────────────────────
      if (/status|how much|how long|usage|minutes/i.test(utterance)) {
        const tts =
          `Instagram: ${status.instagram_mins} of ${status.limits.instagram} minutes. ` +
          `YouTube: ${status.youtube_mins} of ${status.limits.youtube} minutes. ` +
          `Combined: ${status.combined_mins} of ${status.limits.combined} minutes.`;
        return res.json(mcpTextResponse(id, tts, []));
      }

      // ── Default: echo (template behaviour) ──────────────────────────────
      return res.json(mcpTextResponse(id, `You said: ${args.utterance}`, [
        { type: 'feed_item', content: { title: 'Dialog Handled', story: args.utterance } },
      ]));
    }
  }

  return res.status(404).json({
    jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' },
  });
});

// ─── 🗑️  POST /delete-user ───────────────────────────────────────────────────
// Called by the Trace platform when a user uninstalls the skill.

app.post('/delete-user', (req: Request, res: Response) => {
  const { user_id } = req.body;
  console.log(`[Cleanup] Deleting data for user ${user_id}`);
  // In-memory: nothing to delete. Add DB cleanup here for production.
  res.json({ ok: true });
});

// ─── Callback helpers ─────────────────────────────────────────────────────────

/** Build a Trace notification object containing a TTS message. */
function roastNotification(tts: string) {
  return {
    type:    'notification',
    content: { title: 'NoScroll', body: tts, tts, speak: true },
  };
}

/** Sign and POST the skill's async response to the Trace platform callback URL. */
async function postCallback(callbackUrl: string, requestId: string, responses: any[]) {
  const body      = JSON.stringify({ request_id: requestId, status: 'success', responses });
  const timestamp = Date.now().toString();
  const signature = 'sha256=' + crypto
    .createHmac('sha256', TRACE_HMAC_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  const response = await fetch(callbackUrl, {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'X-Trace-Timestamp': timestamp,
      'X-Trace-Signature': signature,
    },
    body,
  });
  console.log(`[Callback] → ${response.status}`);
}

// ─── 🟣 Proactive Push helper ─────────────────────────────────────────────────
// Used by /track to push a notification to the glasses without a Trace event.
// Requires the user_id to be stored from a prior webhook.

async function sendPushResponse(user_id: string, responses: any[]) {
  const url = `${BRAIN_BASE_URL}/api/skill-push/${TRACE_SKILL_ID}`;
  console.log(`[Push] POST ${url}`);
  const body = JSON.stringify({ user_id, responses });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${TRACE_PROJECT_TOKEN}`,
    },
    body,
  });
  const text = await res.text();
  console.log(`[Push] response ${res.status}: ${text}`);
}

/**
 * Fire-and-forget proactive push to the glasses.
 * Called from /track so the glasses speak the roast even if the
 * Shortcut caller doesn't forward the tts field itself.
 */
function firePushNotification(tts: string): void {
  const userId = getUserId() || TRACE_USER_ID || null;
  console.log(`[Push] attempting — userId=${userId}, skillId=${TRACE_SKILL_ID}, tts="${tts}"`);
  if (!userId) {
    console.warn('[Push] skipped — no user_id. Set TRACE_USER_ID env var or trigger a Trace webhook first.');
    return;
  }
  if (!TRACE_SKILL_ID) {
    console.warn('[Push] skipped — TRACE_SKILL_ID env var not set.');
    return;
  }
  sendPushResponse(userId, [roastNotification(tts)]).catch((err) =>
    console.error('[Push] failed:', err)
  );
}

// ─── MCP response builder ─────────────────────────────────────────────────────

function mcpTextResponse(id: any, text: string, embeds: any[]) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [
        { type: 'text', text },
        ...(embeds.length ? [{ type: 'embedded_responses', responses: embeds }] : []),
      ],
    },
  };
}

// ─── Start ────────────────────────────────────────────────────────────────────
// Guard app.listen() so Vercel (serverless) doesn't call it — Vercel
// imports this module and uses `export default app` directly.

export default app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Trace Roast — NoScroll running at http://localhost:${PORT}`);
  });
}
