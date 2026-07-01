// Whisper hallucinates on silence/background noise: bracketed sound tags
// ([BLANK_AUDIO], [ Silence ], [Music]), parenthesised descriptions ((buzzing)),
// musical notes, punctuation-only output, and a few stock YouTube-trained
// phrases. Strip the tags and reject anything with no real words, so noise never
// reaches the agent.

const NONSPEECH_TAGS = /\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|♪[^♪]*♪|♪|<[^>]*>/g;

const HALLUCINATIONS = new Set([
  'thanks for watching',
  'thank you for watching',
  'please subscribe',
  'like and subscribe',
  'subtitles by the amara.org community',
  'transcription by castingwords',
]);

/** Cleaned transcript if it's real speech, else '' (blank audio / noise). */
export function meaningfulTranscript(raw) {
  const stripped = (raw || '').replace(NONSPEECH_TAGS, ' ').replace(/\s+/g, ' ').trim();
  if (!stripped) return '';
  if (!/[\p{L}\p{N}]/u.test(stripped)) return ''; // punctuation / symbols only
  const norm = stripped.toLowerCase().replace(/[.!?,…\s]+$/g, '').trim();
  if (HALLUCINATIONS.has(norm)) return '';
  return stripped;
}
