// ─── Roast Strings ────────────────────────────────────────────────────────────
// Exact TTS strings spoken through the Trace glasses speaker.
// Keep them short — brevity lands harder and sounds better on TTS.

export const ROASTS = {
  FIRST_ALERT:      'Really?',
  MORE_TIME:        'Fine. 5 mins.',
  EXCEEDS_AGAIN:    'Called it.',
  THIRD_OPEN:       'Seriously?',
  AUDIO_CONFIRMS:   "I can hear the reels. Don't even try.",
  SILENT_SCROLLING: "No audio but I know what you're doing.",
  COMBINED_LIMIT:   'Instagram AND YouTube? Ambitious.',
  WEEKEND_MODE:     'Fine. Living your best life today.',
  BACK_TO_NORMAL:   'Back to normal. Stay sharp.',
} as const;

export type RoastKey = keyof typeof ROASTS;

export function getRoast(key: RoastKey): string {
  return ROASTS[key];
}
