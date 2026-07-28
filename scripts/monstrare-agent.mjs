#!/usr/bin/env node

const baseUrl = (process.env.MONSTRARE_URL || '').replace(/\/+$/, '');
const token = process.env.MONSTRARE_TOKEN || '';

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      positional.push(item);
      continue;
    }
    const key = item.slice(2);
    const value = argv[index + 1] && !argv[index + 1].startsWith('--')
      ? argv[++index]
      : true;
    if (options[key] === undefined) options[key] = value;
    else if (Array.isArray(options[key])) options[key].push(value);
    else options[key] = [options[key], value];
  }
  return { positional, options };
}

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) fail(name + ' 必填');
  return value.trim();
}

function parseJsonOption(value, name, fallback) {
  if (value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch (err) {
    fail(name + ' 不是合法 JSON：' + err.message);
  }
}

async function api(method, pathname, body) {
  if (!baseUrl) fail('請設定 MONSTRARE_URL');
  if (!token) fail('請設定 MONSTRARE_TOKEN');
  const response = await fetch(baseUrl + pathname, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    fail(`${response.status} ${data && data.error ? data.error : text || response.statusText}`);
  }
  return data;
}

function projectPath(project, suffix) {
  return `/api/projects/${encodeURIComponent(required(project, 'project'))}${suffix}`;
}

function cardPath(project, cardId, action) {
  return projectPath(
    project,
    `/cards/${encodeURIComponent(required(cardId, 'card id'))}/${action}`,
  );
}

function usage() {
  return [
    'Monstrare agent client',
    '',
    'Environment:',
    '  MONSTRARE_URL       Shared server URL',
    '  MONSTRARE_TOKEN     Agent identity token',
    '',
    'Commands:',
    '  identity',
    '  next <project> [--tracks backend,integration]',
    '  claim <project> <card>',
    '  heartbeat <project> <card> --claim <claim-id>',
    '  release <project> <card> --claim <claim-id>',
    '  submit <project> <card> --claim <id> --revision <sha> --summary <text>',
    '         --checks-json <json> [--artifacts-json <json>] [--residual <text>]',
    '  review <project> <card> --submission <id> --verdict <approved|changes_requested>',
    '         --summary <text> --checks-json <json> [--findings-json <json>]',
  ].join('\n');
}

async function main() {
  const { positional, options } = parseArguments(process.argv.slice(2));
  const [command, project, cardId] = positional;
  if (!command || command === 'help' || options.help) {
    console.log(usage());
    return;
  }

  let result;
  if (command === 'identity') {
    result = await api('GET', '/api/identity');
  } else if (command === 'next') {
    const tracks = typeof options.tracks === 'string'
      ? options.tracks.split(',').map((item) => item.trim()).filter(Boolean)
      : undefined;
    result = await api('POST', projectPath(project, '/claims/next'), {
      ...(tracks ? { tracks } : {}),
    });
  } else if (command === 'claim') {
    result = await api('POST', cardPath(project, cardId, 'claim'), {});
  } else if (command === 'heartbeat' || command === 'release') {
    result = await api('POST', cardPath(project, cardId, command), {
      claimId: required(options.claim, '--claim'),
    });
  } else if (command === 'submit') {
    result = await api('POST', cardPath(project, cardId, 'submit'), {
      claimId: required(options.claim, '--claim'),
      revision: required(options.revision, '--revision'),
      summary: required(options.summary, '--summary'),
      checks: parseJsonOption(options['checks-json'], '--checks-json', []),
      artifacts: parseJsonOption(options['artifacts-json'], '--artifacts-json', []),
      residual: typeof options.residual === 'string' ? options.residual : '',
    });
  } else if (command === 'review') {
    result = await api('POST', cardPath(project, cardId, 'review'), {
      submissionId: required(options.submission, '--submission'),
      verdict: required(options.verdict, '--verdict'),
      summary: required(options.summary, '--summary'),
      checks: parseJsonOption(options['checks-json'], '--checks-json', []),
      findings: parseJsonOption(options['findings-json'], '--findings-json', []),
    });
  } else {
    fail('未知 command：' + command + '\n\n' + usage());
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('[monstrare-agent] ' + err.message);
  process.exitCode = 1;
});
