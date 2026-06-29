// Speech-to-text via OpenAI Whisper. The desktop holds the API key (never the
// phone, never the backend), and audio arrives P2P over the data channel — so
// transcription happens here, on the "server", exactly as specced.
//
// This is one concrete STT implementation behind the provider seam. Anything
// with `transcribe(bytes, mime) -> string` can replace it (local whisper.cpp,
// Deepgram, etc.) without touching the session logic.

const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

export class WhisperClient {
  /** @param {{ apiKey: string, model?: string, endpoint?: string, language?: string }} opts */
  constructor({ apiKey, model = 'whisper-1', endpoint = DEFAULT_ENDPOINT, language } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.endpoint = endpoint;
    this.language = language;
  }

  /**
   * @param {Uint8Array|ArrayBuffer|Blob} audio  encoded audio (e.g. webm/opus)
   * @param {string} mime  e.g. 'audio/webm'
   * @returns {Promise<string>} transcript text
   */
  async transcribe(audio, mime = 'audio/webm') {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is not set — cannot transcribe');

    const blob = audio instanceof Blob ? audio : new Blob([audio], { type: mime });
    const form = new FormData();
    form.append('model', this.model);
    form.append('response_format', 'json');
    if (this.language) form.append('language', this.language);
    form.append('file', blob, fileNameFor(mime));

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`whisper ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data = await res.json();
    return (data.text || '').trim();
  }
}

function fileNameFor(mime) {
  if (mime.includes('webm')) return 'utterance.webm';
  if (mime.includes('ogg')) return 'utterance.ogg';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'utterance.m4a';
  if (mime.includes('wav')) return 'utterance.wav';
  return 'utterance.webm';
}
