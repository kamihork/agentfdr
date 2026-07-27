// `agentfdr blame` — a paste-into-an-issue markdown autopsy of one session.

import { t, formatFlag } from './i18n.js';
import { estimateSessionCost, fmtUsd } from './cost.js';

export function blameReport(model, flags, lang = 'en', subagents = []) {
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

  lines.push(...subagentSection(subagents, s, kTok));

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

/**
 * Subagent work is invisible in the session totals — it happens in transcripts
 * of its own — so an autopsy that skips it under-reports what the run cost.
 */
function subagentSection(nodes, s, kTok, max = 15) {
  if (!nodes.length) return [];
  const total = nodes.reduce(
    (a, n) => ({
      turns: a.turns + n.summary.turns,
      calls: a.calls + n.summary.toolCalls,
      billed: a.billed + n.summary.billedTokens,
      critical: a.critical + n.summary.critical,
    }),
    { turns: 0, calls: 0, billed: 0, critical: 0 }
  );
  const lines = [`## ${s.subagentsLabel} (${nodes.length})`, ''];
  lines.push(s.subagentTotals(total, kTok));
  lines.push('');
  lines.push(`| ${s.subCols.join(' | ')} |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const n of nodes.slice(0, max)) {
    const where = n.turn == null ? '—' : `t${n.turn}`;
    const what = [n.type, n.description].filter(Boolean).join(' — ').replace(/\|/g, '\\|');
    const anomalies = n.summary.critical || n.summary.warnings
      ? `${n.summary.critical ? '🟥' + n.summary.critical : ''}${n.summary.warnings ? ' 🟧' + n.summary.warnings : ''}`.trim()
      : '—';
    lines.push(`| ${where} | ${what} | ${n.summary.turns} | ${n.summary.toolCalls} | ${kTok(n.summary.billedTokens)} | ${anomalies} |`);
  }
  if (nodes.length > max) lines.push(`| … | ${s.andMore(nodes.length - max)} | | | | |`);
  lines.push('');
  return lines;
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
