'use strict';

// Speech-to-text for voice transcripts. Each player's browser records only its own microphone
// while they talk (push-to-talk), so we always know who said what. Clips queue up here and go to
// Groq's Whisper (free tier: 20 requests/min, 2 h of audio/hour) at a steady pace; OpenAI is an
// optional backup. Audio is never stored: it's dropped as soon as it has been transcribed.

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';
const REQUESTS_PER_MIN = 18; // under Groq's free 20 RPM
const MAX_TRIES = 4;
const QUEUE_MAX = 400; // clips; past this the oldest are dropped rather than eating memory

// Whisper invents these on silence or noise (well-known Russian "subtitle credits" hallucinations).
const HALLUCINATIONS = [
  /субтитр/i, /продолжение следует/i, /редактор субтитров/i, /dimatorzok/i, /спасибо за просмотр/i,
  /подписывайтесь на канал/i, /ставьте лайк/i, /amara\.org/i, /^\s*(угу|ага|м+|э+)[.!?]?\s*$/i,
];

const provider = () => (process.env.GROQ_API_KEY ? 'groq' : process.env.OPENAI_API_KEY ? 'openai' : null);

function clean(text) {
  text = String(text || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length < 2) return '';
  if (HALLUCINATIONS.some(re => re.test(text))) return '';
  return text;
}

class SttQueue {
  // onText(job, text) is called for every recognised clip, in order of arrival
  constructor({ onText, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    this.onText = onText;
    this.fetch = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.jobs = [];
    this.sent = []; // timestamps of recent requests, for pacing
    this.running = false;
    this.pausedUntil = 0;
  }

  enabled() { return !!provider(); }

  // pending clips for a room (and day): round notes wait until these are done
  pending(code, day) {
    return this.jobs.filter(j => j.code === code && (day === undefined || j.day === day)).length + (this.current && this.current.code === code && (day === undefined || this.current.day === day) ? 1 : 0);
  }

  add(job) {
    if (this.jobs.length >= QUEUE_MAX) this.jobs.shift();
    this.jobs.push({ ...job, tries: 0 });
    this.run();
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length) {
        await this.pace();
        const job = this.jobs.shift();
        this.current = job;
        try {
          const text = clean(await this.transcribe(job));
          if (text) this.onText(job, text);
        } catch (e) {
          job.tries += 1;
          if (e.retryAfter) this.pausedUntil = this.now() + e.retryAfter * 1000;
          if (job.tries < MAX_TRIES) this.jobs.unshift(job);
          else console.error('Transcription failed for good:', e.message);
          if (!e.retryAfter) await this.sleep(1500 * job.tries);
        }
        this.current = null;
      }
    } finally {
      this.running = false;
    }
  }

  // at most REQUESTS_PER_MIN requests in any minute, and wait out a 429
  async pace() {
    for (;;) {
      const now = this.now();
      if (now < this.pausedUntil) { await this.sleep(this.pausedUntil - now); continue; }
      this.sent = this.sent.filter(t => now - t < 60000);
      if (this.sent.length < REQUESTS_PER_MIN) { this.sent.push(now); return; }
      await this.sleep(60000 - (now - this.sent[0]) + 50);
    }
  }

  async transcribe(job) {
    const useGroq = !!process.env.GROQ_API_KEY && !(job.tries >= 2 && process.env.OPENAI_API_KEY);
    const form = new FormData();
    form.append('file', new Blob([job.audio], { type: job.mime || 'audio/webm' }), 'clip.webm');
    form.append('model', useGroq ? (process.env.STT_MODEL || 'whisper-large-v3-turbo') : 'gpt-4o-mini-transcribe');
    form.append('language', job.lang || 'ru');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    // names and game words help Whisper spell them right
    if (job.prompt) form.append('prompt', job.prompt.slice(0, 600));
    // STT_URL: any OpenAI-compatible transcription endpoint (e.g. a self-hosted Whisper server)
    const res = await this.fetch(useGroq ? (process.env.STT_URL || GROQ_URL) : OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${useGroq ? process.env.GROQ_API_KEY : process.env.OPENAI_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(60000),
    });
    if (res.status === 429) {
      const err = new Error('rate limited');
      err.retryAfter = Math.min(120, Number(res.headers.get('retry-after')) || 20);
      throw err;
    }
    if (!res.ok) throw new Error(`STT HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()).text;
  }
}

module.exports = { SttQueue, clean, provider };
