const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');

function harness() {
  const properties = new Map([['WORK_API_ENABLED', 'true'], ['WORK_API_TOKEN', 's'.repeat(48)], ['WORK_RESULTS_FOLDER_ID', 'folder'], ['GEMINI_API_KEY', 'fake-test-key']]);
  const files = new Map();
  const state = { locked: false, sends: 0, collections: 0, saves: 0, snapshots: 0, trigger: true };
  let sequence = 0;
  const p = { getProperty: k => properties.get(k) ?? null, setProperty: (k, v) => properties.set(k, v), deleteProperty: k => properties.delete(k), getProperties: () => Object.fromEntries(properties) };
  const ctx = vm.createContext({ console, Logger: { log() {} }, PropertiesService: { getScriptProperties: () => p },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) },
    LockService: { getScriptLock: () => ({ tryLock() { if (state.locked) return false; state.locked = true; return true; }, releaseLock() { state.locked = false; } }) },
    ScriptApp: { getProjectTriggers: () => state.trigger ? [{ getHandlerFunction: () => 'processWorkJobs' }] : [], newTrigger: () => ({ timeBased() { return this; }, everyMinutes() { return this; }, create() { state.trigger = true; } }) },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, computeDigest: (_a, s) => [...crypto.createHash('sha256').update(s).digest()], formatDate: () => '2026-09-29' },
    DriveApp: { getFolderById: () => ({ createFile(name, text) { const id = 'file-' + ++sequence; files.set(id, { name, text, trashed: false }); return { getId: () => id }; } }),
      getFileById: id => { if (!files.has(id)) throw new Error('Missing file'); return { getBlob: () => ({ getDataAsString: () => files.get(id).text }), setTrashed: value => { files.get(id).trashed = value; } }; } },
    SpreadsheetApp: { openById: id => ({ getId: () => id }), getActiveSpreadsheet: () => ({ getId: () => 'bound-sheet' }) }
  });
  for (const file of fs.readdirSync(root).filter(f => f.endsWith('.gs')).sort()) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), ctx, { filename: file });
  const result = () => ({ now: new Date('2026-09-29T01:00:00Z'), fromDate: new Date('2026-09-28T01:00:00Z'),
    data: { customs: { US: [{ title: 'test', __sourceUris: ['private'], url: 'https://example.org/source' }] }, export: {}, trade: {} },
    insights: { customs: {}, export: {}, trade: {} }, stats: { total: 1 }, failedUnits: [] });
  ctx.runMonitoringCore = options => { state.collections++; assert.equal(options.dedupe, false); return result(); };
  ctx.getApiKey = () => properties.get('GEMINI_API_KEY');
  ctx.getRecipients = () => [{ email: 'allowed@example.org', name: 'Test', focus: 'export' }];
  ctx.sendCombinedEmail = (_r, recipients) => { state.sends++; assert.equal(recipients.length, 1); return 1; };
  ctx.logExecution = () => {};
  ctx.saveAllToSheets = () => { state.saves++; };
  ctx.saveResultSnapshot = () => { state.snapshots++; };
  ctx.loadResultSnapshot = result;
  const post = request => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ token: 's'.repeat(48), ...request }) } }).text);
  const job = id => JSON.parse(properties.get('WORK_JOB_' + id));
  return { ctx, post, state, properties, files, result, job };
}
const collectId = 'collection-00000001';
const sendId = 'send-email-00000001';
function collect(h) { assert.equal(h.post({ action: 'collect', requestId: collectId }).ok, true); h.ctx.processWorkJobs(); }

test('all Apps Script files parse; API denies missing/wrong auth and malformed requests', () => {
  const h = harness();
  assert.equal(h.post({ action: 'collect', requestId: collectId, token: 'wrong' }).error.code, 'UNAUTHORIZED');
  assert.equal(h.state.collections, 0);
  assert.equal(JSON.parse(h.ctx.doPost({ postData: { contents: 'broken' } }).text).error.code, 'BAD_REQUEST');
  assert.equal(h.post({ action: 'arbitrary_function' }).error.code, 'BAD_REQUEST');
});

test('collect queues quickly, runs once, returns results without sending or touching scheduled DB', () => {
  const h = harness();
  const queued = h.post({ action: 'collect', requestId: collectId });
  assert.equal(queued.data.status, 'queued'); assert.equal(h.state.collections, 0);
  h.ctx.processWorkJobs(); h.ctx.processWorkJobs();
  const retry = h.post({ action: 'collect', requestId: collectId });
  assert.equal(retry.data.status, 'completed');
  assert.equal(h.state.collections, 1); assert.equal(h.state.sends, 0); assert.equal(h.state.saves, 0); assert.equal(h.state.snapshots, 0);
  const latest = h.post({ action: 'latest' });
  assert.equal(latest.data.jobId, collectId);
  assert.equal(latest.data.result.data.customs.US[0].__sourceUris, undefined);
  assert.equal(latest.data.result.data.customs.US[0].url, 'https://example.org/source');
});

test('latest source selection, filtering and validation are explicit', () => {
  const h = harness();
  assert.equal(h.post({ action: 'latest' }).error.code, 'NOT_FOUND');
  assert.equal(h.post({ action: 'latest', source: 'scheduled' }).data.deliveryStatus, 'not_tracked');
  collect(h);
  assert.deepEqual(Object.keys(h.post({ action: 'status', jobId: collectId, domain: 'export' }).data.result.data), ['export']);
  assert.equal(h.post({ action: 'latest', domain: 'invalid' }).error.code, 'BAD_REQUEST');
  assert.equal(h.post({ action: 'latest', source: 'typo' }).error.code, 'BAD_REQUEST');
});

test('polling and duplicate collection retry work while the script lock is held', () => {
  const h = harness(); h.post({ action: 'collect', requestId: collectId }); h.state.locked = true;
  assert.equal(h.post({ action: 'status', jobId: collectId }).data.status, 'queued');
  assert.equal(h.post({ action: 'collect', requestId: collectId }).data.status, 'queued');
  assert.equal(h.post({ action: 'collect', requestId: 'collection-00000002' }).error.code, 'BUSY');
});

test('same request ID with a different action cannot send; sending disabled by default', () => {
  const h = harness(); collect(h);
  assert.equal(h.post({ action: 'send', requestId: sendId, jobId: collectId, recipient: 'allowed@example.org', confirm: true }).error.code, 'MAIL_DISABLED');
  h.properties.set('WORK_MAIL_ENABLED', 'true');
  assert.equal(h.post({ action: 'send', requestId: collectId, jobId: collectId, recipient: 'allowed@example.org', confirm: true }).error.code, 'ID_CONFLICT');
  assert.equal(h.state.sends, 0);
});

test('send requires true confirmation and active recipient, and retries never duplicate delivery', () => {
  const h = harness(); collect(h); h.properties.set('WORK_MAIL_ENABLED', 'true');
  const req = { action: 'send', requestId: sendId, jobId: collectId, recipient: 'allowed@example.org', confirm: true };
  assert.equal(h.post({ ...req, confirm: 'true' }).error.code, 'MAIL_DISABLED');
  assert.equal(h.post({ ...req, recipient: 'outsider@example.org' }).error.code, 'RECIPIENT_NOT_ALLOWED');
  assert.equal(h.post(req).data.status, 'queued'); h.ctx.processWorkJobs();
  assert.equal(h.post(req).data.emailSent, true); h.ctx.processWorkJobs(); assert.equal(h.state.sends, 1);
  assert.equal(h.state.collections, 1);
});

test('recipient removal after enqueue blocks mail', () => {
  const h = harness(); collect(h); h.properties.set('WORK_MAIL_ENABLED', 'true');
  h.post({ action: 'send', requestId: sendId, jobId: collectId, recipient: 'allowed@example.org', confirm: true });
  h.ctx.getRecipients = () => []; h.ctx.processWorkJobs();
  assert.equal(h.job(sendId).status, 'failed'); assert.equal(h.state.sends, 0);
});

test('interrupted send is marked unknown and never automatically replayed', () => {
  const h = harness(); collect(h); h.properties.set('WORK_MAIL_ENABLED', 'true');
  const req = { action: 'send', requestId: sendId, jobId: collectId, recipient: 'allowed@example.org', confirm: true };
  h.post(req); const j = h.job(sendId); j.status = 'running'; j.startedAt = Date.now() - 11 * 60 * 1000;
  h.properties.set('WORK_JOB_' + sendId, JSON.stringify(j));
  assert.equal(h.post({ action: 'status', jobId: sendId }).data.status, 'unknown');
  h.ctx.processWorkJobs(); assert.equal(h.post(req).data.status, 'unknown'); assert.equal(h.state.sends, 0);
});

test('partial and total collection failures are visible, not reported as no news', () => {
  const h = harness();
  h.ctx.runMonitoringCore = () => ({ ...h.result(), failedUnits: [{ domainKey: 'export', unitKey: 'US' }] });
  collect(h); assert.equal(h.job(collectId).status, 'partial');
  h.ctx.runMonitoringCore = () => ({ ...h.result(), failedUnits: Array(17).fill({ domainKey: 'export' }) });
  h.post({ action: 'collect', requestId: 'collection-00000002' }); h.ctx.processWorkJobs();
  assert.equal(h.job('collection-00000002').status, 'failed');
  assert.equal(h.post({ action: 'latest' }).data.jobId, collectId);
});

test('missing worker/key and daily quota return actionable errors', () => {
  const h = harness(); h.state.trigger = false;
  assert.equal(h.post({ action: 'collect', requestId: collectId }).error.code, 'NOT_CONFIGURED');
  h.state.trigger = true; h.properties.delete('GEMINI_API_KEY');
  assert.equal(h.post({ action: 'collect', requestId: collectId }).error.code, 'NOT_CONFIGURED');
  h.properties.set('GEMINI_API_KEY', 'test'); h.properties.set('WORK_QUOTA', JSON.stringify({ day: '2026-09-29', collect: 10, send: 0 }));
  assert.equal(h.post({ action: 'collect', requestId: collectId }).error.code, 'DAILY_LIMIT');
});

test('setup binds spreadsheet ID and is idempotent without enabling mail', () => {
  const h = harness(); h.ctx.setupWorkIntegration(); h.ctx.setupWorkIntegration();
  assert.equal(h.properties.get('MONITORING_SPREADSHEET_ID'), 'bound-sheet');
  assert.equal(h.properties.get('WORK_MAIL_ENABLED'), 'false');
  h.ctx.SpreadsheetApp.getActiveSpreadsheet = () => null;
  assert.equal(h.ctx.getMonitoringSpreadsheet().getId(), 'bound-sheet');
});

test('retention prunes old results but preserves latest snapshot and active source', () => {
  const h = harness(); collect(h);
  const old = { ...h.job(collectId), jobId: 'collection-old-0001', createdAt: Date.now() - 8 * 86400000 };
  h.files.set('old-file', { text: '{}', trashed: false }); old.resultFileId = 'old-file';
  h.properties.set('WORK_JOB_' + old.jobId, JSON.stringify(old));
  h.ctx.workPruneJobs_();
  assert.equal(h.properties.has('WORK_JOB_' + old.jobId), false); assert.equal(h.files.get('old-file').trashed, true);
  assert.ok(h.properties.has('WORK_JOB_' + collectId));
});

test('worker recovers a queued job if enqueue was interrupted before writing active pointer', () => {
  const h = harness(); h.post({ action: 'collect', requestId: collectId }); h.properties.delete('WORK_ACTIVE_JOB');
  h.ctx.processWorkJobs(); assert.equal(h.job(collectId).status, 'completed'); assert.equal(h.state.collections, 1);
});
