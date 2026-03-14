#!/usr/bin/env node
/**
 * GitHub Actions CI/CD Workflow Monitor - Pure Node.js implementation
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const EMOJI = { success: '✅', failure: '❌', cancelled: '🚫', skipped: '⏭️', timed_out: '⏱️', in_progress: '▶️', queued: '⏳' };
const INTERVAL = 10, TIMEOUT = 3600, MAXBUF = 50 * 1024 * 1024;

// Pure Node.js gh CLI helpers - no shell strings
const gh = (args, opts = {}) => {
  const r = spawnSync('gh', args, { encoding: 'utf-8', maxBuffer: opts.maxBuffer || MAXBUF, cwd: opts.cwd });
  if (r.error) throw r.error;
  if (r.status !== 0 && !opts.allowFail) throw new Error(r.stderr || `gh exited ${r.status}`);
  return r.stdout;
};
const ghJson = (args, opts) => JSON.parse(gh(args, opts));
const cliRepo = (() => {
  const a = process.argv;
  const i = a.findIndex(x => x === '--repo' || x === '-R');
  return i >= 0 && a[i + 1] ? a[i + 1] : null;
})();
let _repo = null;
const getRepo = () => _repo || (_repo = cliRepo || process.env.GITHUB_REPOSITORY || ghJson(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner);
const runView = (id, f = 'status,conclusion,jobs') => ghJson(['run', 'view', String(id), '--repo', getRepo(), '--json', f]);
const runList = (opts = {}) => {
  const args = ['run', 'list', '--repo', getRepo(), '--limit', String(opts.limit || 10),
    '--json', 'databaseId,status,conclusion,headBranch,createdAt,displayTitle,event'];
  if (opts.branch) args.push('--branch', opts.branch);
  return ghJson(args);
};
const getLogs = (runId, jobId) => gh(['run', 'view', String(runId), '--repo', getRepo(), '--log', '--job', String(jobId)], { maxBuffer: MAXBUF });
const findJob = (runId, name) => {
  const job = runView(runId, 'jobs').jobs?.find(j => j.name === name);
  if (!job) { console.error(`❌ Job "${name}" not found`); process.exit(1); }
  return job;
};
const emoji = (s, c) => EMOJI[c || s] || '❓';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Commands
const cmd = {
  runs: (opts = {}) => {
    const list = runList({ ...opts, limit: parseInt(opts.limit) || 15 });
    console.log(`\n📋 Recent runs${opts.branch ? ` for "${opts.branch}"` : ''}:\n`);
    for (const r of list) {
      console.log(`${emoji(r.status, r.conclusion)} ${String(r.databaseId).padEnd(12)} ${new Date(r.createdAt).toLocaleDateString()} [${(r.headBranch || '').padEnd(20)}] (${r.event || ''})`);
      if (r.displayTitle) console.log(`     ${r.displayTitle.substring(0, 60)}`);
    }
    return list;
  },
  watch: async (id, opts = {}) => {
    const int = parseInt(opts.interval) || INTERVAL;
    console.log(`👁️  Watching run ${id}...\n`);
    const last = new Map();
    while (true) {
      const run = runView(id);
      const rs = `${run.status}:${run.conclusion}`;
      if (last.get('run') !== rs) { console.log(`${emoji(run.status, run.conclusion)} Run: ${run.status}${run.conclusion ? ' → ' + run.conclusion : ''}`); last.set('run', rs); }
      for (const j of run.jobs || []) {
        const js = `${j.status}:${j.conclusion}`;
        if (last.get(`job:${j.id}`) !== js) { console.log(`  ${emoji(j.status, j.conclusion)} ${j.name}: ${j.status}${j.conclusion ? ' → ' + j.conclusion : ''}`); last.set(`job:${j.id}`, js); }
      }
      if (run.status === 'completed') { console.log(`\n${emoji(run.status, run.conclusion)} Completed: ${run.conclusion}`); process.exit(run.conclusion === 'success' ? 0 : 1); }
      await sleep(int * 1000);
    }
  },
  'fail-fast': async (id, opts = {}) => {
    const int = parseInt(opts.interval) || INTERVAL;
    console.log(`🔍 Watching run ${id} (fail-fast)...\n`);
    const seen = new Set();
    while (true) {
      const run = runView(id);
      for (const j of run.jobs || []) {
        if (!seen.has(j.id)) { console.log(`${emoji(j.status, j.conclusion)} ${j.name}: ${j.conclusion || j.status}`); seen.add(j.id); }
        if (j.conclusion === 'failure') { console.log(`\n❌ Job "${j.name}" failed!\n📋 Run: ci_monitor.cjs log-failed ${id}`); process.exit(1); }
      }
      if (run.status === 'completed') { console.log(`\n${emoji(run.status, run.conclusion)} Run completed: ${run.conclusion}`); process.exit(run.conclusion === 'success' ? 0 : 1); }
      await sleep(int * 1000);
    }
  },
  'list-jobs': (id, opts = {}) => {
    let jobs = runView(id).jobs || [];
    if (opts.status) jobs = jobs.filter(j => j.conclusion === opts.status || j.status === opts.status);
    console.log(`\n📋 Jobs in run ${id}:\n`);
    for (const j of jobs) console.log(`${emoji(j.status, j.conclusion)} ${(j.conclusion || j.status || '?').padEnd(12)} ${j.name}`);
  },
  'log-failed': (id, opts = {}) => {
    const run = runView(id, 'jobs');
    if (!(run.jobs || []).some(j => j.conclusion === 'failure')) { console.log('✅ No failed jobs found.'); return; }
    console.log(`\n❌ Failed jobs in run ${id}:\n`);
    try { console.log(gh(['run', 'view', String(id), '--repo', getRepo(), '--log-failed'], { maxBuffer: MAXBUF }).split(/\r?\n/).slice(-(parseInt(opts.lines) || 200)).join('\n')); }
    catch (e) { console.error(`Could not fetch logs: ${e.message}`); }
  },
  log: (id, opts = {}) => {
    console.log(`\n📋 Full logs for run ${id}:\n`);
    try {
      let lines = gh(['run', 'view', String(id), '--repo', getRepo(), '--log'], { maxBuffer: MAXBUF }).split(/\r?\n/);
      if (opts.filter) { const re = new RegExp(opts.filter, 'gi'); lines = lines.filter(l => re.test(l)); console.log(`🔍 Filtered (${lines.length} lines):\n`); }
      console.log(lines.slice(-(parseInt(opts.lines) || 500)).join('\n'));
    } catch (e) { console.error(`Could not fetch logs: ${e.message}`); }
  },
  grep: (id, opts = {}) => {
    if (!opts.pattern) { console.error('❌ --pattern required'); process.exit(1); }
    console.log(`\n🔍 Searching for "${opts.pattern}" in run ${id}:\n`);
    try {
      const lines = gh(['run', 'view', String(id), '--repo', getRepo(), '--log'], { maxBuffer: MAXBUF }).split(/\r?\n/);
      const re = new RegExp(opts.pattern, 'gi');
      const matches = lines.map((l, i) => re.test(l) ? { i, l } : null).filter(Boolean);
      if (!matches.length) { console.log('No matches found.'); return; }
      console.log(`Found ${matches.length} matches:\n`);
      const ctx = parseInt(opts.context) || 3;
      for (const m of matches.slice(0, 20)) {
        console.log(`--- Line ${m.i} ---`);
        for (let j = Math.max(0, m.i - ctx); j < Math.min(lines.length, m.i + ctx + 1); j++)
          console.log(`${j === m.i ? '>>>' : '   '} ${lines[j]}`);
      }
      if (matches.length > 20) console.log(`\n... and ${matches.length - 20} more`);
    } catch (e) { console.error(`Could not fetch logs: ${e.message}`); }
  },
  'test-summary': (id, opts = {}) => {
    console.log(`\n📊 Test summary for run ${id}:\n`);
    try {
      const logs = gh(['run', 'view', String(id), '--repo', getRepo(), '--log'], { maxBuffer: MAXBUF });
      const t = logs.match(/# tests[\s:]+(\d+)/i), p = logs.match(/# pass[\s:]+(\d+)/i), f = logs.match(/# fail[\s:]+(\d+)/i);
      const notOk = logs.match(/^not ok .+$/gm);
      if (t) console.log(`  Total tests: ${t[1]}`);
      if (p) console.log(`  ✅ Passed: ${p[1]}`);
      if (f) console.log(`  ❌ Failed: ${f[1]}`);
      if (notOk?.length) { console.log(`\nFailed tests:`); notOk.slice(0, 15).forEach(x => console.log(`  ${x}`)); if (notOk.length > 15) console.log(`  ... and ${notOk.length - 15} more`); }
    } catch (e) { console.error(`Could not fetch logs: ${e.message}`); }
  },
  tail: (id, job, opts = {}) => console.log(getLogs(id, findJob(id, job).id).split(/\r?\n/).slice(-(parseInt(opts.lines) || 100)).join('\n')),
  'wait-for': async (id, jobName, opts = {}) => {
    if (!opts.keyword) { console.error('❌ --keyword required'); process.exit(1); }
    const to = (parseInt(opts.timeout) || TIMEOUT) * 1000, int = (parseInt(opts.interval) || 5) * 1000;
    console.log(`🔍 Waiting for "${opts.keyword}" in "${jobName}"...\n`);
    const start = Date.now();
    let job = null;
    while (!job && Date.now() - start < to) { job = runView(id).jobs?.find(j => j.name === jobName); if (!job) { console.log(`⏳ Waiting...`); await sleep(int); } }
    if (!job) { console.error('❌ Timeout waiting for job'); process.exit(1); }
    console.log(`▶️  Job started (ID: ${job.id})`);
    while (Date.now() - start < to) {
      try {
        const logs = getLogs(id, job.id);
        if (logs.includes(opts.keyword)) {
          console.log(`\n✅ Found "${opts.keyword}"!`);
          const lines = logs.split(/\r?\n/), idx = lines.findIndex(l => l.includes(opts.keyword));
          if (idx >= 0) console.log('\n' + lines.slice(Math.max(0, idx - 2), idx + 3).join('\n'));
          process.exit(0);
        }
        console.log(`📝 Log: ${logs.length} chars (${Math.floor((Date.now() - start) / 1000)}s)`);
      } catch (e) { /* ignore */ }
      await sleep(int);
    }
    console.error(`❌ Timeout waiting for "${opts.keyword}"`); process.exit(1);
  },
  analyze: (id, jobName) => {
    const logs = getLogs(id, findJob(id, jobName).id);
    const patterns = [
      ['Errors', /error[:：]\s*(.+)/gi], ['NPM Errors', /npm ERR!\s*(.+)/gi], ['TypeScript', /error TS\d+:\s*(.+)/gi],
      ['Timeout', /timeout|timed?\s*out/gi], ['OOM', /out of memory|OOM|heap.*exceeded/gi],
      ['Network', /ECONNREFUSED|ETIMEDOUT|ENOTFOUND/gi], ['Bad Option', /bad option[:：]\s*(.+)/gi],
    ];
    console.log(`🔍 Analyzing "${jobName}"...\n`);
    for (const [name, re] of patterns) {
      const m = [...logs.matchAll(re)].slice(0, 5);
      if (m.length) { console.log(`❌ ${name}:`); m.forEach(x => console.log(`   • ${(x[1] || x[0]).trim().substring(0, 80)}`)); }
    }
  },
  compare: (id1, id2) => {
    const j1 = new Map((runView(id1, 'jobs').jobs || []).map(j => [j.name, j]));
    const j2 = new Map((runView(id2, 'jobs').jobs || []).map(j => [j.name, j]));
    console.log(`\n🔍 Comparing ${id1} vs ${id2}:\n`);
    for (const name of new Set([...j1.keys(), ...j2.keys()])) {
      const a = j1.get(name)?.conclusion || 'missing', b = j2.get(name)?.conclusion || 'missing';
      console.log(`${emoji(0, a)} ${emoji(0, b)} ${name.padEnd(25)} ${a.padEnd(10)} → ${b}${a !== b ? ' ⚠️' : ''}`);
    }
  },
  'branch-runs': (branch, opts = {}) => {
    const list = runList({ branch, limit: parseInt(opts.limit) || 10 });
    console.log(`\n📋 Runs for "${branch}":\n`);
    for (const r of list) console.log(`${emoji(r.status, r.conclusion)} ${String(r.databaseId).padEnd(10)} ${new Date(r.createdAt).toLocaleDateString()} ${r.displayTitle?.substring(0, 40) || ''}`);
  },
  'list-workflows': (opts = {}) => {
    const dir = path.join('.github', 'workflows');
    if (!fs.existsSync(dir)) { console.error('❌ No .github/workflows directory'); process.exit(1); }
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml')).sort();
    if (!files.length) { console.log('No workflow files found.'); return []; }
    console.log('\n📋 Workflow files:\n');
    for (const f of files) {
      const c = fs.readFileSync(path.join(dir, f), 'utf-8');
      const nm = c.match(/^name:\s*['"]?(.+?)['"]?\s*$/m)?.[1] || '(unnamed)';
      const tr = ['push', 'pull_request', 'schedule', 'workflow_dispatch', 'release'].filter(x => c.includes(`${x}:`));
      console.log(`📄 ${f.padEnd(30)} ${nm.padEnd(30)} ${tr.length ? `[${tr.join(', ')}]` : ''}`);
    }
    return files;
  },
  'check-actions': (wf, opts = {}) => {
    const fp = wf || path.join('.github', 'workflows', 'ci.yml');
    if (!fs.existsSync(fp)) { console.error(`❌ File not found: ${fp}`); process.exit(1); }
    const c = fs.readFileSync(fp, 'utf-8');
    
    // Find all uses: statements
    const actions = new Set();
    const lines = c.split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/uses:\s*['"]?([^'"\s]+)['"]?/);
      if (m && !m[1].startsWith('./') && !m[1].startsWith('docker://')) {
        actions.add(m[1].split('@')[0]);
      }
    }
    
    if (!actions.size) { console.log('No external actions found.'); return; }
    console.log(`\n🔍 Checking ${actions.size} actions in ${fp}:\n`);
    
    for (const a of actions) {
      const [owner, repo] = a.split('/');
      if (!owner || !repo) continue;
      try {
        const res = ghJson(['api', 'graphql', '-f', `query=query { repository(owner: "${owner}", name: "${repo}") { latestRelease { tagName } } }`]);
        const latest = res?.data?.repository?.latestRelease?.tagName;
        const curMatch = c.match(new RegExp(`${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@([\\w.-]+)`));
        const cur = curMatch?.[1] || 'unknown';
        if (latest) {
          const ok = cur === latest || cur === latest.replace(/^v/, '');
          console.log(`${ok ? '✅' : '⚠️'} ${a.padEnd(35)} current: ${cur.padEnd(15)} latest: ${latest}`);
        } else console.log(`❓ ${a.padEnd(35)} current: ${cur.padEnd(15)} (no releases)`);
      } catch (e) { console.log(`❌ ${a.padEnd(35)} Error: ${e.message?.substring(0, 50) || e}`); }
    }
  },
};

// CLI
const parseArgs = args => {
  const r = { command: null, positional: [], options: {} };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) { const k = a.slice(2); const n = args[i + 1]; if (n && !n.startsWith('-')) { r.options[k] = n; i++; } else r.options[k] = true; }
    else if (a.startsWith('-')) { const k = a.slice(1); const n = args[i + 1]; if (n && !n.startsWith('-')) { r.options[k] = n; i++; } else r.options[k] = true; }
    else if (r.command === null) r.command = a; else r.positional.push(a);
  }
  return r;
};

const HELP = `
GitHub Actions CI/CD Workflow Monitor

COMMANDS:
  runs [--branch <name>]              List recent runs
  watch <run-id>                      Watch run with status changes
  fail-fast <run-id>                  Watch run, exit 1 on first failure
  list-jobs <run-id>                  List jobs in run
  log-failed <run-id>                 Show logs for failed jobs
  log <run-id> [--filter <regex>]     Show full run logs
  grep <run-id> --pattern <regex>     Search logs with context
  test-summary <run-id>               Extract test pass/fail counts
  tail <run-id> <job-name>            Get last N lines of job log
  wait-for <run-id> <job> --keyword   Block until keyword appears
  analyze <run-id> <job>              Pattern analysis for failures
  compare <run1> <run2>               Compare job statuses between runs
  branch-runs <branch>                List recent runs for branch
  list-workflows                      List all workflow files
  check-actions [file]                Check action versions via GraphQL

OPTIONS: --interval, --timeout, --lines, --filter, --pattern, --context, --branch, --keyword, --limit, --repo/-R
`;

const REQ = {
  'watch': ['run-id'], 'fail-fast': ['run-id'], 'list-jobs': ['run-id'], 'log-failed': ['run-id'],
  'log': ['run-id'], 'grep': ['run-id'], 'test-summary': ['run-id'], 'tail': ['run-id', 'job-name'],
  'wait-for': ['run-id', 'job-name'], 'analyze': ['run-id', 'job-name'], 'compare': ['run-id-1', 'run-id-2'],
  'branch-runs': ['branch'],
};

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === 'help' || args[0] === '--help') { console.log(HELP); process.exit(0); }
  const { command, positional, options } = parseArgs(args);

  if (!cmd[command]) { console.error(`❌ Unknown command: ${command}`); console.log(HELP); process.exit(1); }
  const req = REQ[command] || [];
  if (req.some((_, i) => !positional[i])) { console.error(`❌ Missing: ${req.filter((_, i) => !positional[i]).join(', ')}`); process.exit(1); }
  if (command === 'grep' && !options.pattern) { console.error('❌ --pattern required'); process.exit(1); }
  if (command === 'wait-for' && !options.keyword) { console.error('❌ --keyword required'); process.exit(1); }

  try { await cmd[command](...positional, options); }
  catch (e) { console.error(`❌ Error: ${e.message}`); if (process.env.DEBUG) console.error(e.stack); process.exit(1); }
}

main();