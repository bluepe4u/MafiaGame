'use strict';

// After a Mafia game with a voice transcript: a short read of the game by a small, cheap model.
// Off unless the server has ANTHROPIC_API_KEY set (in /etc/mafia.env on the VPS).

const MODEL = process.env.INSIGHTS_MODEL || 'claude-haiku-4-5-20251001';
const MAX_TRANSCRIPT_CHARS = 60000;

const enabled = () => !!process.env.ANTHROPIC_API_KEY;

function prompt(record, lang) {
  const roles = record.players.map(p => `${p.name}: ${p.role}${p.survived ? '' : ' (out)'}`).join('\n');
  const timeline = (record.timeline || []).map(e => (e.type === 'night'
    ? `Night ${e.day}: ${e.killed ? `${e.killed} was killed` : e.saved ? 'the doctor saved the victim' : 'nobody died'}`
    : `Day ${e.day}: ${e.out ? `${e.out} was voted out` : 'nobody was voted out'}`)).join('\n');
  let transcript = record.transcript.map(l => `[${l.phase} ${l.day}${l.channel === 'mafia' ? ', Mafia only' : l.channel === 'dead' ? ', out of the game' : ''}] ${l.name}: ${l.text}`).join('\n');
  if (transcript.length > MAX_TRANSCRIPT_CHARS) transcript = transcript.slice(-MAX_TRANSCRIPT_CHARS);
  return `You analyse a finished game of Mafia played by friends over voice chat. The transcript comes from automatic speech recognition, one line per utterance, so expect recognition mistakes; don't quote garbled bits.

Roles (secret during the game, known now):
${roles}

Winner: ${record.winner}
What happened:
${timeline}

Transcript:
${transcript}

Reply with JSON only, no prose around it, in ${lang === 'ru' ? 'Russian' : 'English'} for all text fields:
{
  "summary": "2-3 sentences: how the game went and why the winner won",
  "moments": ["up to 4 short key moments, each one sentence"],
  "players": [{"name": "exact name from the roles list", "line": "one playful, kind sentence about how they played", "accused": ["names they accused or pushed to vote out"]}],
  "mvp": "name of the player who most influenced the result",
  "bestBluff": "name of the Mafia player with the most convincing defence, or null"
}`;
}

async function analyzeMafia(record, lang = 'ru') {
  if (!enabled() || !record.transcript || record.transcript.length < 3) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, messages: [{ role: 'user', content: prompt(record, lang) }] }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`insights: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = (data.content || []).map(c => c.text || '').join('');
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  const names = new Set(record.players.map(p => p.name));
  // keep only the expected shape, and only real player names
  return {
    summary: String(json.summary || '').slice(0, 800),
    moments: (Array.isArray(json.moments) ? json.moments : []).slice(0, 4).map(m => String(m).slice(0, 300)),
    players: (Array.isArray(json.players) ? json.players : []).filter(p => names.has(p.name)).map(p => ({
      name: p.name, line: String(p.line || '').slice(0, 300),
      accused: (Array.isArray(p.accused) ? p.accused : []).filter(n => names.has(n)).slice(0, 10),
    })),
    mvp: names.has(json.mvp) ? json.mvp : null,
    bestBluff: names.has(json.bestBluff) ? json.bestBluff : null,
    model: MODEL,
  };
}

module.exports = { analyzeMafia, enabled };
