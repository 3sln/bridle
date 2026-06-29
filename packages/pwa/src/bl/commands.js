// Voice-command grammar, parsed on the phone from the Whisper transcript. A
// configurable lead-in word ("bridle" by default) disambiguates commands from
// dictation: say "bridle pause" to pause. A few safety commands ("stop talking",
// "be quiet", "stop listening") are always recognized so barge-in works even
// mid-sentence without the lead-in.
//
// parse() returns { name } for a recognized command, or null for plain dictation
// (which gets sent to the agent as input).

export const CMD = Object.freeze({
  PAUSE_LISTENING: 'pause-listening',
  RESUME_LISTENING: 'resume-listening',
  STOP_SPEAKING: 'stop-speaking',
  REPEAT: 'repeat',
  START_CONVERSATION: 'start-conversation',
  STOP_CONVERSATION: 'stop-conversation',
  INTERRUPT_AGENT: 'interrupt-agent',
  FASTER: 'faster',
  SLOWER: 'slower',
  CLEAR: 'clear',
});

// phrase -> command. Longest/most-specific phrases should be matched first.
const PHRASES = [
  [CMD.STOP_CONVERSATION, ['stop conversation', 'end conversation', 'exit conversation', 'leave conversation']],
  [CMD.START_CONVERSATION, ['start conversation', 'conversation mode', "let's talk", 'lets talk']],
  [CMD.PAUSE_LISTENING, ['pause listening', 'stop listening', 'pause', 'hold on', 'wait']],
  [CMD.RESUME_LISTENING, ['resume listening', 'start listening', 'resume', 'keep going', "i'm back", 'im back']],
  [CMD.STOP_SPEAKING, ['stop talking', 'be quiet', 'quiet', 'stop reading', 'shut up', 'stop', 'hush']],
  [CMD.REPEAT, ['repeat that', 'repeat', 'say that again', 'again', 'what did you say']],
  [CMD.INTERRUPT_AGENT, ['interrupt', 'cancel that', 'cancel', 'abort', 'stop the agent']],
  [CMD.FASTER, ['speak faster', 'talk faster', 'faster']],
  [CMD.SLOWER, ['speak slower', 'talk slower', 'slower']],
  [CMD.CLEAR, ['clear chat', 'clear', 'scratch that']],
];

// Recognized even without the lead-in so the user can always cut in mid-reply.
// Kept to barge-in only — "pause" etc. require the lead-in so normal dictation
// of those words isn't hijacked.
const ALWAYS_ON = new Set([CMD.STOP_SPEAKING]);

const normalize = (s) =>
  s.toLowerCase().replace(/[.,!?;:'"]/g, '').replace(/\s+/g, ' ').trim();

function matchPhrase(text) {
  for (const [name, phrases] of PHRASES) {
    for (const p of phrases) {
      if (text === p) return { name };
    }
  }
  return null;
}

/**
 * @param {string} transcript
 * @param {{ leadIn?: string }} opts
 */
export function parse(transcript, { leadIn = 'bridle' } = {}) {
  const text = normalize(transcript || '');
  if (!text) return null;

  const lead = normalize(leadIn || '');
  if (lead && (text === lead || text.startsWith(lead + ' '))) {
    // Explicit command: everything after the lead-in.
    const rest = text.slice(lead.length).trim();
    return matchPhrase(rest) || { name: 'unknown', rest };
  }

  // No lead-in: only the always-on safety commands are honored, and only when
  // they're the whole utterance (so dictating "stop" in a sentence is safe).
  const m = matchPhrase(text);
  if (m && ALWAYS_ON.has(m.name)) return m;
  return null;
}
