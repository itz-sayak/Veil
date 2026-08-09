// modes.js — persona "Modes", mirroring Cluely's Modes menu.
//
// A Mode is a named profile with a `systemPrompt`. The active mode's prompt is
// PREPENDED to whatever system prompt the functional feature (assist/say/…)
// builds, so the two compose: the feature decides *how* to respond, the mode
// shapes *who* Veil is being for this user right now.
//
// Built-in modes cannot be deleted but their prompt text can be edited (the
// edited copy is persisted in settings.modes.list). Users can add their own.

const DEFAULT_MODES = [
  {
    id: 'default',
    name: 'Default',
    builtin: true,
    systemPrompt: '', // no extra persona — Veil behaves as its base self
  },
  {
    id: 'general',
    name: 'General',
    builtin: true,
    systemPrompt:
      'You are Veil, a sharp, calm, general-purpose copilot. Give direct, correct, ' +
      'useful answers with zero filler. Prefer concrete specifics over hedging, show ' +
      'brief reasoning only when it changes the answer, and format for fast scanning ' +
      '(short paragraphs, tight bullet lists, fenced code when relevant).',
  },
  {
    id: 'job',
    name: 'Looking for a job',
    builtin: true,
    systemPrompt:
      'The user is actively interviewing for jobs. Optimise every answer to help them ' +
      'succeed in interviews: speak in the first person as the candidate, lead with a ' +
      'confident thesis, back it with specific experience and metrics, and keep spoken ' +
      'answers under ~45 seconds. For behavioural questions use STAR (Situation, Task, ' +
      'Action, Result). For technical questions, give a crisp approach then the detail. ' +
      'Never sound scripted or robotic.',
  },
  {
    id: 'sales',
    name: 'Sales call',
    builtin: true,
    systemPrompt:
      'The user is on a live sales or customer call. Help them advance the deal: surface ' +
      'the prospect’s stated needs, suggest value-framed responses and thoughtful ' +
      'discovery questions, handle objections with empathy and evidence, and never be ' +
      'pushy or dishonest. Keep suggestions short enough to glance at mid-conversation.',
  },
  {
    id: 'meeting',
    name: 'Meeting',
    builtin: true,
    systemPrompt:
      'The user is in a work meeting. Track decisions, action items, owners and open ' +
      'questions. When asked what to say, give a concise, professional contribution that ' +
      'moves the discussion forward. Summaries should be skimmable bullets under bold headers.',
  },
  {
    id: 'user',
    name: 'User Instructions',
    builtin: true,
    // Intentionally empty: this is the user's own always-on custom instruction slot.
    systemPrompt: '',
  },
];

function getModesState(settings) {
  const m = (settings && settings.modes) || {};
  const list = Array.isArray(m.list) && m.list.length ? m.list : DEFAULT_MODES.slice();
  const activeId = typeof m.activeId === 'string' && m.activeId ? m.activeId : 'general';
  return { list, activeId };
}

function getActiveMode(settings) {
  const { list, activeId } = getModesState(settings);
  return list.find((x) => x.id === activeId)
    || list.find((x) => x.id === 'default')
    || null;
}

// The system-prompt fragment for the active mode ('' when the mode is Default or empty).
function getActiveModePrompt(settings) {
  const mode = getActiveMode(settings);
  if (!mode) return '';
  return String(mode.systemPrompt || '').trim();
}

module.exports = { DEFAULT_MODES, getModesState, getActiveMode, getActiveModePrompt };
