import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { acquireRunLock } from './run-lock.mjs';

const STATE_APP = 'trade-monitor-claude-cli';
const STATE_VERSION = 1;
const MAX_AUTO_LOOKBACK_MS = 168 * 60 * 60 * 1000;
const OVERLAP_MS = 6 * 60 * 60 * 1000;
const STATE_MAX_BYTES = 1024 * 1024;
const STATE_LOCK_WAIT_MS = 5000;
const STATE_LOCK_POLL_MS = 25;

export function appStateDirectory(cliDir) {
  return path.join(cliDir, 'output', '.trade-monitor-state');
}

export function globalResearchLockTarget(cliDir) {
  return path.join(appStateDirectory(cliDir), 'global-research');
}

export function monitoringScopeKey({ categorySelection, groupSelection, depth = 'standard' } = {}) {
  const scope = categorySelection
    ? `category:${categorySelection.id}`
    : groupSelection
      ? `group:${groupSelection.domainKey}`
      : 'all';
  return `${scope}|depth:${depth}`;
}

async function ensureStateDirectory(cliDir) {
  const directory = appStateDirectory(cliDir);
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory()) throw new Error(`앱 상태 경로가 일반 폴더가 아닙니다: ${directory}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.mkdir(directory, { recursive: true });
  }
  return directory;
}

function emptyState() {
  return { app: STATE_APP, version: STATE_VERSION, scopes: {} };
}

async function readStateFile(cliDir) {
  const file = path.join(appStateDirectory(cliDir), 'state.json');
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > STATE_MAX_BYTES) {
      throw new Error('앱 상태 파일은 1MB 이하의 일반 파일이어야 합니다.');
    }
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (
      parsed?.app !== STATE_APP
      || parsed?.version !== STATE_VERSION
      || !parsed.scopes
      || typeof parsed.scopes !== 'object'
      || Array.isArray(parsed.scopes)
    ) throw new Error('앱 상태 파일 형식 또는 소유 표식이 올바르지 않습니다.');
    return { file, state: parsed };
  } catch (error) {
    if (error.code === 'ENOENT') return { file, state: emptyState() };
    error.code = 'RUN_STATE';
    throw error;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireStateLock(cliDir) {
  const directory = await ensureStateDirectory(cliDir);
  const target = path.join(directory, 'state-update');
  const deadline = Date.now() + STATE_LOCK_WAIT_MS;
  while (true) {
    try {
      return await acquireRunLock(target, {
        lockDirectory: directory,
        description: '자동 조사 기간 상태 갱신',
      });
    } catch (error) {
      if (error?.code !== 'ALREADY_RUNNING' || Date.now() >= deadline) throw error;
      await delay(STATE_LOCK_POLL_MS);
    }
  }
}

async function quarantineInvalidState(file, reason) {
  const quarantine = path.join(
    path.dirname(file),
    `state.invalid-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID()}.json`,
  );
  try {
    await fs.rename(file, quarantine);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  console.warn(`손상되거나 호환되지 않는 실행 시각 상태를 보존하고 새로 시작합니다: ${quarantine} (${reason})`);
}

export async function lastCompleteRun(cliDir, scopeKey) {
  let lock;
  try {
    lock = await acquireStateLock(cliDir);
    const { state } = await readStateFile(cliDir);
    const entry = state.scopes[scopeKey];
    const completedAt = new Date(entry?.completedAt || '');
    if (Number.isNaN(completedAt.getTime())) return null;
    return { ...entry, completedAt };
  } catch (error) {
    console.warn(`이전 실행 시각을 읽지 못해 기본 조사 기간을 사용합니다: ${error.message}`);
    return null;
  } finally {
    await lock?.release().catch((error) => {
      console.warn(`실행 시각 읽기 잠금 정리 경고: ${error.message}`);
    });
  }
}

export function automaticFromDate(now, lastRun) {
  const current = now instanceof Date ? now : new Date(now);
  const completed = lastRun?.completedAt instanceof Date
    ? lastRun.completedAt
    : new Date(lastRun?.completedAt || '');
  if (Number.isNaN(current.getTime()) || Number.isNaN(completed.getTime())) return null;
  if (completed.getTime() > current.getTime() + 60000) return null;
  const oldest = current.getTime() - MAX_AUTO_LOOKBACK_MS;
  const overlapped = completed.getTime() - OVERLAP_MS;
  const from = new Date(Math.max(oldest, overlapped));
  if (from.getTime() >= current.getTime()) return new Date(current.getTime() - OVERLAP_MS);
  return from;
}

export async function recordCompleteRun(cliDir, scopeKey, entry) {
  const lock = await acquireStateLock(cliDir);
  try {
    const directory = await ensureStateDirectory(cliDir);
    let stateFile;
    let state;
    try {
      ({ file: stateFile, state } = await readStateFile(cliDir));
    } catch (error) {
      if (error.code !== 'RUN_STATE') throw error;
      stateFile = path.join(directory, 'state.json');
      await quarantineInvalidState(stateFile, error.message);
      state = emptyState();
    }
    const completedAt = new Date(entry.completedAt);
    if (Number.isNaN(completedAt.getTime())) throw new Error('완전 성공 실행 시각이 올바르지 않습니다.');
    if (!scopeKey || typeof scopeKey !== 'string') throw new Error('모니터링 범위 키가 올바르지 않습니다.');
    if (!entry.outputFile) throw new Error('완전 성공 결과 파일 경로가 없습니다.');
    state.scopes[scopeKey] = {
      completedAt: completedAt.toISOString(),
      outputFile: path.resolve(String(entry.outputFile)),
      depth: String(entry.depth || 'standard'),
    };
    const temp = path.join(directory, `.state.${randomUUID()}.tmp`);
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(temp, stateFile);
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EBUSY'].includes(error.code)) throw error;
      const backup = path.join(directory, `.state.${randomUUID()}.backup`);
      try {
        await fs.rename(stateFile, backup);
        await fs.rename(temp, stateFile);
        await fs.unlink(backup);
      } catch (replaceError) {
        await fs.rename(backup, stateFile).catch(() => {});
        throw replaceError;
      }
    } finally {
      await fs.unlink(temp).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  } finally {
    await lock.release();
  }
}

export const AUTO_LOOKBACK_MAX_HOURS = MAX_AUTO_LOOKBACK_MS / (60 * 60 * 1000);
export const AUTO_LOOKBACK_OVERLAP_HOURS = OVERLAP_MS / (60 * 60 * 1000);
