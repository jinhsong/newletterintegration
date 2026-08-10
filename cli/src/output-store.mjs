import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const WINDOWS_REPLACE_ERRORS = new Set(['EEXIST', 'EPERM', 'EBUSY']);
const STALE_TEMP_MS = 60 * 60 * 1000;
const GROUP_OUTPUT_FILES = Object.freeze({
  customs: 'monitoring-customs.html',
  export: 'monitoring-export.html',
  trade: 'monitoring-trade.html',
});

export function resolveOutputFile(cliDir, configuredFile, optionFile) {
  const selected = optionFile || configuredFile;
  const resolved = selected
    ? path.resolve(cliDir, selected)
    : path.join(cliDir, 'output', 'monitoring.html');
  if (path.extname(resolved).toLowerCase() !== '.html') {
    throw new Error('출력 파일은 .html 확장자여야 합니다.');
  }
  return resolved;
}

export function resolveMonitoringOutputFile(cliDir, options = {}, configuredFile = '') {
  if (options.categorySelection && options.groupSelection) {
    throw new Error('--category와 --group은 함께 사용할 수 없습니다.');
  }
  if (options.mockPath && !options.outputFile) {
    return resolveOutputFile(cliDir, '', path.join(cliDir, 'output', 'mock-monitoring.html'));
  }
  if (options.categorySelection && !options.outputFile) {
    return resolveOutputFile(cliDir, '', path.join(cliDir, 'output', 'monitoring-category.html'));
  }
  if (options.groupSelection && !options.outputFile) {
    const groupKey = String(options.groupSelection.domainKey || '');
    const fileName = Object.hasOwn(GROUP_OUTPUT_FILES, groupKey)
      ? GROUP_OUTPUT_FILES[groupKey]
      : '';
    if (!fileName) throw new Error('선택한 그룹의 기본 출력 파일을 결정할 수 없습니다.');
    return resolveOutputFile(cliDir, '', path.join(cliDir, 'output', fileName));
  }
  return resolveOutputFile(cliDir, configuredFile, options.outputFile);
}

export function recoveryFileFor(outputFile) {
  return path.join(path.dirname(outputFile), `.${path.basename(outputFile)}.recovery-backup`);
}

async function lstatOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function syncFile(filePath) {
  const handle = await fs.open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function isLikelyCompleteHtml(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 32) return false;
    const headSize = Math.min(512, stat.size);
    const tailSize = Math.min(512, stat.size);
    const head = Buffer.alloc(headSize);
    const tail = Buffer.alloc(tailSize);
    await handle.read(head, 0, headSize, 0);
    await handle.read(tail, 0, tailSize, Math.max(0, stat.size - tailSize));
    const beginning = head.toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase();
    const ending = tail.toString('utf8').trimEnd().toLowerCase();
    return beginning.startsWith('<!doctype html') && ending.endsWith('</html>');
  } finally {
    await handle.close();
  }
}

function recoveryError(message, details = '') {
  const error = new Error(message);
  error.code = 'OUTPUT_RECOVERY';
  error.details = details;
  return error;
}

export async function recoverInterruptedOutput(outputFile) {
  const recoveryFile = recoveryFileFor(outputFile);
  const [outputStat, recoveryStat] = await Promise.all([
    lstatOrNull(outputFile),
    lstatOrNull(recoveryFile),
  ]);
  if (!recoveryStat) return false;
  if (!recoveryStat.isFile()) {
    throw recoveryError(
      '이전 결과 복구 경로가 일반 파일이 아니어서 자동 복구하지 않았습니다.',
      recoveryFile,
    );
  }

  if (!outputStat) {
    if (!await isLikelyCompleteHtml(recoveryFile)) {
      throw recoveryError(
        '이전 결과 백업이 완전한 HTML로 확인되지 않아 그대로 보존했습니다.',
        recoveryFile,
      );
    }
    await fs.rename(recoveryFile, outputFile);
    await syncFile(outputFile);
    return true;
  }

  if (!outputStat.isFile()) {
    throw recoveryError(
      '결과 경로가 일반 파일이 아니어서 정상 백업을 삭제하지 않았습니다.',
      `결과 경로: ${outputFile}\n보존된 백업: ${recoveryFile}`,
    );
  }
  if (!await isLikelyCompleteHtml(outputFile)) {
    throw recoveryError(
      '현재 결과가 완전한 HTML로 확인되지 않아 정상 백업을 삭제하지 않았습니다.',
      `확인 필요: ${outputFile}\n보존된 백업: ${recoveryFile}`,
    );
  }

  await fs.unlink(recoveryFile);
  return true;
}

async function writeDurableTemp(filePath, html) {
  const handle = await fs.open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(html, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function cleanupStaleTempFiles(outputFile, now = Date.now()) {
  const directory = path.dirname(outputFile);
  const escapedName = path.basename(outputFile).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\.${escapedName}\\.[0-9a-f-]{36}\\.tmp$`, 'i');
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const candidate = path.join(directory, entry.name);
    try {
      const stat = await fs.stat(candidate);
      if (now - stat.mtimeMs >= STALE_TEMP_MS) await fs.unlink(candidate);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`오래된 HTML 임시 파일 정리 경고: ${error.message}`);
      }
    }
  }
}

function warnCleanup(label, error) {
  console.warn(`${label} 정리 경고: ${error?.message || error}`);
}

export async function saveHtmlOutput(html, outputFile) {
  const outputDir = path.dirname(outputFile);
  const tempFile = path.join(outputDir, `.${path.basename(outputFile)}.${randomUUID()}.tmp`);
  const backupFile = recoveryFileFor(outputFile);
  let backupCreated = false;
  let replacementSucceeded = false;
  let durabilityConfirmed = false;
  let primaryError = null;

  await fs.mkdir(outputDir, { recursive: true });
  await recoverInterruptedOutput(outputFile);
  await cleanupStaleTempFiles(outputFile);
  const existing = await lstatOrNull(outputFile);
  if (existing && !existing.isFile()) {
    throw recoveryError('결과 경로가 일반 파일이 아니어서 HTML을 저장하지 않았습니다.', outputFile);
  }
  await writeDurableTemp(tempFile, html);

  try {
    try {
      await fs.rename(tempFile, outputFile);
      replacementSucceeded = true;
    } catch (error) {
      if (!WINDOWS_REPLACE_ERRORS.has(error.code)) throw error;
      try {
        await fs.rename(outputFile, backupFile);
        backupCreated = true;
      } catch (backupError) {
        if (backupError.code !== 'ENOENT') throw backupError;
      }
      try {
        await fs.rename(tempFile, outputFile);
        replacementSucceeded = true;
      } catch (replaceError) {
        if (backupCreated) {
          try {
            await fs.rename(backupFile, outputFile);
            backupCreated = false;
          } catch (restoreError) {
            throw new AggregateError(
              [replaceError, restoreError],
              `HTML 교체와 이전 결과 복구가 모두 실패했습니다. 이전 결과 백업: ${backupFile}`,
            );
          }
        }
        throw replaceError;
      }
    }
    await syncFile(outputFile);
    durabilityConfirmed = true;
  } catch (error) {
    primaryError = error;
  }

  try {
    await fs.unlink(tempFile);
  } catch (error) {
    if (error.code !== 'ENOENT') warnCleanup('HTML 임시 파일', error);
  }
  if (backupCreated && replacementSucceeded && durabilityConfirmed) {
    try {
      await fs.unlink(backupFile);
      backupCreated = false;
    } catch (error) {
      warnCleanup('이전 HTML 백업', error);
    }
  }

  if (primaryError) throw primaryError;
  return outputFile;
}
