import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { domains } from './config-loader.mjs';
import { normalizeTitle } from './pipeline.mjs';

function safeDeliveryKey(value) {
  const key = String(value || '');
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(key)) {
    throw new Error(`안전하지 않은 deliveryKey: ${key}`);
  }
  return key;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`${filePath} JSON 읽기 실패: ${error.message}`);
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
    await fs.unlink(filePath).catch((unlinkError) => {
      if (unlinkError.code !== 'ENOENT') throw unlinkError;
    });
    await fs.rename(tempPath, filePath);
  }
}

export function resolveDataDir(cliDir, configuredPath) {
  return configuredPath
    ? path.resolve(cliDir, configuredPath)
    : path.join(cliDir, 'data');
}

export async function acquireRunLock(dataDir) {
  await fs.mkdir(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, '.monitor.lock');
  let handle;
  try {
    handle = await fs.open(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(
        `다른 모니터링 실행이 진행 중이거나 이전 실행이 비정상 종료됐습니다: ${lockPath}`,
      );
    }
    throw error;
  }
  await handle.writeFile(`${JSON.stringify({
    lockId: randomUUID(),
    startedAt: new Date().toISOString(),
  })}\n`, 'utf8');
  await handle.close();
  return async () => {
    await fs.unlink(lockPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  };
}

export async function loadHistoryTitles(dataDir, lookbackDays = 7) {
  const historyPath = path.join(dataDir, 'history.json');
  const history = await readJson(historyPath, []);
  if (!Array.isArray(history)) throw new Error(`${historyPath}의 최상위 값은 배열이어야 합니다.`);
  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  const output = Object.fromEntries(domains.map((domain) => [domain.key, []]));
  for (const item of history) {
    const sentAt = Date.parse(item.sentAt || '');
    if (!Number.isFinite(sentAt) || sentAt < cutoff || !output[item.domainKey]) continue;
    const normalized = normalizeTitle(item.title);
    if (normalized) output[item.domainKey].push(normalized);
  }
  return output;
}

export async function appendHistory(dataDir, payload, recipientCount) {
  const historyPath = path.join(dataDir, 'history.json');
  const existing = await readJson(historyPath, []);
  if (!Array.isArray(existing)) throw new Error(`${historyPath}의 최상위 값은 배열이어야 합니다.`);
  const sentAt = new Date().toISOString();
  const additions = [];
  for (const domain of domains) {
    for (const unit of domain.units) {
      for (const item of payload.data[domain.key][unit.key] || []) {
        additions.push({
          sentAt,
          deliveryKey: payload.deliveryKey,
          recipientCount,
          domainKey: domain.key,
          unitKey: unit.key,
          title: item.title,
          announcedDate: item.announcedDate,
          sourceUrl: item.sourceUrl || '',
        });
      }
    }
  }
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const compacted = existing
    .filter((item) => Date.parse(item.sentAt || '') >= cutoff)
    .concat(additions)
    .slice(-5000);
  await writeJsonAtomic(historyPath, compacted);
}

function deliveryPath(dataDir, deliveryKey) {
  return path.join(dataDir, 'deliveries', `${safeDeliveryKey(deliveryKey)}.json`);
}

function deliveryPayloadPath(dataDir, deliveryKey) {
  return path.join(dataDir, 'deliveries', `${safeDeliveryKey(deliveryKey)}.payload.json`);
}

export async function loadDeliveryState(dataDir, deliveryKey) {
  const state = await readJson(deliveryPath(dataDir, deliveryKey), null);
  if (!state) {
    return {
      version: 1,
      deliveryKey: safeDeliveryKey(deliveryKey),
      status: 'new',
      createdAt: new Date().toISOString(),
      batches: {},
    };
  }
  if (state.deliveryKey !== deliveryKey || typeof state.batches !== 'object') {
    throw new Error(`발송 상태 파일이 손상됐습니다: ${deliveryPath(dataDir, deliveryKey)}`);
  }
  return state;
}

export async function saveDeliveryState(dataDir, state) {
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(deliveryPath(dataDir, state.deliveryKey), state);
}

export async function loadDeliveryPayload(dataDir, deliveryKey) {
  return readJson(deliveryPayloadPath(dataDir, deliveryKey), null);
}

export async function saveDeliveryPayload(dataDir, payload) {
  await writeJsonAtomic(deliveryPayloadPath(dataDir, payload.deliveryKey), payload);
}
