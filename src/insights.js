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

Notes taken live after each day (written without knowing roles):
${(record.roundNotes || []).map(r => `Day ${r.day}: ${r.note.summary} Accusations: ${r.note.accusations.map(a => `${a.from}→${a.to}`).join(', ') || 'none'}.`).join('\n') || '(none)'}

Transcript:
${transcript}

Reply with JSON only, no prose around it, in ${lang === 'ru' ? 'Russian' : 'English'} for all text fields:
{
  "summary": "2-3 sentences: how the game went and why the winner won",
  "moments": ["up to 4 short key moments, each one sentence"],
  "players": [{"name": "exact name from the roles list", "line": "one playful, kind sentence about how they played", "accused": ["names they accused or pushed to vote out"]}],
  "rounds": [{"day": 1, "note": "now that roles are known: who was right that day, who was fooled, what the Mafia did"}],
  "pairs": [{"players": ["name", "name"], "note": "who really played together (Mafia partners covering each other, or town players who teamed up) and how it showed"}],
  "mvp": "name of the player who most influenced the result",
  "bestBluff": "name of the Mafia player with the most convincing defence, or null"
}`;
}

// one request to the model; the reply is the JSON object in its text
async function ask(content, maxTokens) {
  const res = await fetch(`${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`insights: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = (data.content || []).map(c => c.text || '').join('');
  return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
}

const str = (v, max) => String(v || '').slice(0, max);
const list = v => (Array.isArray(v) ? v : []);

// ---------- live: one day of the game, from public speech only ----------
function roundPrompt(input, lang) {
  return `You take notes for a game of Mafia played by friends over voice chat, right after day ${input.day} ended with a vote. You do NOT know anyone's role, and must not guess roles as facts — describe only what people said and did. The speech comes from automatic speech recognition, so expect mistakes; skip garbled bits.

Players still in the game this day: ${input.alive.join(', ')}
${input.morning ? `This morning: ${input.morning}.\n` : ''}${input.earlier.length ? `Earlier days:\n${input.earlier.join('\n')}\n` : ''}
What was said today (in order):
${input.lines.map(l => `${l.name}: ${l.text}`).join('\n') || '(nothing was transcribed)'}

The vote: ${input.votes.map(([v, t]) => `${v} → ${t}`).join(', ') || 'no votes'}. ${input.out ? `${input.out} was voted out.` : 'Nobody was voted out.'}

Reply with JSON only, in ${lang === 'ru' ? 'Russian' : 'English'} for all text:
{
  "summary": "2-3 sentences: what the day was about and how the vote went",
  "accusations": [{"from": "name", "to": "name", "strength": 1-3, "why": "a few words"}],
  "defenses": [{"from": "name", "to": "name"}],
  "alliances": [{"players": ["name", "name"], "why": "a few words: they backed each other, voted alike..."}],
  "suspects": [{"name": "name", "by": ["names who suspect them"]}],
  "quotes": [{"name": "name", "text": "a short memorable line, as said"}]
}
Use only the exact names above. Empty lists are fine.`;
}

async function analyzeRound(input, lang = 'ru') {
  if (!enabled()) return null;
  const names = new Set(input.alive);
  const json = await ask(roundPrompt(input, lang), 1200);
  const ok = n => names.has(n);
  return {
    summary: str(json.summary, 600),
    accusations: list(json.accusations).filter(a => ok(a.from) && ok(a.to) && a.from !== a.to).slice(0, 20)
      .map(a => ({ from: a.from, to: a.to, strength: Math.max(1, Math.min(3, Math.round(Number(a.strength) || 1))), why: str(a.why, 120) })),
    defenses: list(json.defenses).filter(d => ok(d.from) && ok(d.to) && d.from !== d.to).slice(0, 20).map(d => ({ from: d.from, to: d.to })),
    alliances: list(json.alliances).filter(a => list(a.players).length >= 2 && list(a.players).every(ok)).slice(0, 8)
      .map(a => ({ players: a.players.slice(0, 4), why: str(a.why, 120) })),
    suspects: list(json.suspects).filter(x => ok(x.name)).slice(0, 8).map(x => ({ name: x.name, by: list(x.by).filter(ok) })),
    quotes: list(json.quotes).filter(q => ok(q.name) && q.text).slice(0, 3).map(q => ({ name: q.name, text: str(q.text, 200) })),
  };
}

async function analyzeMafia(record, lang = 'ru') {
  if (!enabled() || !record.transcript || record.transcript.length < 3) return null;
  const json = await ask(prompt(record, lang), 2000);
  const names = new Set(record.players.map(p => p.name));
  // keep only the expected shape, and only real player names
  return {
    summary: String(json.summary || '').slice(0, 800),
    moments: (Array.isArray(json.moments) ? json.moments : []).slice(0, 4).map(m => String(m).slice(0, 300)),
    players: (Array.isArray(json.players) ? json.players : []).filter(p => names.has(p.name)).map(p => ({
      name: p.name, line: String(p.line || '').slice(0, 300),
      accused: (Array.isArray(p.accused) ? p.accused : []).filter(n => names.has(n)).slice(0, 10),
    })),
    rounds: list(json.rounds).filter(r => Number.isInteger(r.day)).slice(0, 20).map(r => ({ day: r.day, note: str(r.note, 300) })),
    pairs: list(json.pairs).filter(p => list(p.players).length >= 2 && list(p.players).every(n => names.has(n))).slice(0, 8)
      .map(p => ({ players: p.players.slice(0, 4), note: str(p.note, 200) })),
    mvp: names.has(json.mvp) ? json.mvp : null,
    bestBluff: names.has(json.bestBluff) ? json.bestBluff : null,
    model: MODEL,
  };
}

module.exports = { analyzeMafia, analyzeRound, enabled };
