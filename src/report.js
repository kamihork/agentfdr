// `agentfdr blame` — a paste-into-an-issue markdown autopsy of one session.

import { t, formatFlag } from './i18n.js';
import { estimateSessionCost, fmtUsd } from './cost.js';

export function blameReport(model, flags, lang = 'en') {
  const { session, totals, turns } = model;
  const s = t(lang);
  const lines = [];
  const kTok = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

  lines.push(`# ${s.flightReport}: ${session.title ?? session.id ?? 'session'}`);
  lines.push('');
  lines.push(`| | |`);
  lines.push(`|---|---|`);
  if (session.id) lines.push(`| ${s.session} | \`${session.id}\` |`);
  if (session.cwd) lines.push(`| ${s.project} | \`${session.cwd}\`${session.gitBranch ? ` (${session.gitBranch})` : ''} |`);
  const models = session.models?.length
    ? session.models.map((m) => (session.models.length > 1 ? `${m.model} ×${m.turns}` : m.model)).join(', ')
    : session.model;
  if (models) lines.push(`| ${s.model} | ${models} |`);
  if (session.effort) lines.push(`| ${s.effortLabel} | ${session.effort} |`);
  if (session.startedAt) lines.push(`| ${s.started} | ${session.startedAt} |`);
  if (totals.wallMs != null) lines.push(`| ${s.wallTime} | ${fmtMs(totals.wallMs)} |`);
  lines.push(`| ${s.turns} | ${totals.turns} |`);
  lines.push(`| ${s.toolCalls} | ${totals.toolCalls}${totals.toolErrors ? ` (${totals.toolErrors} ${s.errors})` : ''} |`);
  if (totals.webSearch || totals.webFetch) lines.push(`| ${s.webLabel} | ${s.webLine(totals.webSearch, totals.webFetch)} |`);
  if (totals.compactions) lines.push(`| ${s.compactionLabel} | ${totals.compactions} |`);
  lines.push(`| ${s.tokens} | ${s.tokensLine(totals.tokens, kTok)} |`);
  const cost = estimateSessionCost(model);
  if (cost.usd != null) lines.push(`| ${s.estCost} | ~${fmtUsd(cost.usd)} ${s.estCostNote} |`);
  lines.push('');

  if (!flags.length) {
    lines.push(s.noAnomalies);
    return lines.join('\n');
  }

  lines.push(`## ${s.anomalies} (${flags.length})`);
  lines.push('');
  for (const f of flags) {
    const icon = f.severity === 'critical' ? '🟥' : '🟧';
    const [title, detail] = formatFlag(f, lang);
    lines.push(`### ${icon} ${title} — ${s.turnRange(f.turnStart, f.turnEnd)}`);
    lines.push('');
    lines.push(detail);
    lines.push('');
    const evidence = evidenceFor(f, turns);
    if (evidence.length) {
      lines.push('```');
      lines.push(...evidence);
      lines.push('```');
      lines.push('');
    }
  }

  lines.push('---');
  lines.push(s.footer((session.id ?? '').slice(0, 8)));
  return lines.join('\n');
}

function evidenceFor(flag, turns, max = 8) {
  const out = [];
  for (const t of turns) {
    if (t.index < flag.turnStart || t.index > flag.turnEnd) continue;
    for (const call of t.toolCalls) {
      const err = call.result?.isError ? '  [ERROR]' : '';
      out.push(`turn ${t.index}  ${call.name}(${call.summary})${err}`);
      if (out.length >= max) {
        out.push('…');
        return out;
      }
    }
  }
  return out;
}

export function fmtMs(ms) {
  if (ms == null) return '?';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
