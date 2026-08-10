import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const WINDOWS_REPLACE_ERRORS = new Set(['EEXIST', 'EPERM', 'EBUSY']);
const STALE_TEMP_MS = 60 * 60 * 1000;
const RECOVERY_APP = 'trade-monitor-claude-cli';
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
  if (isUnsupportedWindowsDevicePath(resolved)) {
    throw new Error('Windows 장치 네임스페이스에는 HTML을 저장할 수 없습니다. 일반 로컬 폴더 경로를 사용하세요.');
  }
  if (process.platform === 'win32') {
    const fileName = path.win32.basename(resolved);
    const deviceStem = fileName.split('.')[0];
    if (fileName.includes(':')) {
      throw new Error('NTFS 대체 데이터 스트림에는 HTML을 저장할 수 없습니다. 일반 파일 경로를 사용하세요.');
    }
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(deviceStem)) {
      throw new Error('Windows 예약 장치 이름에는 HTML을 저장할 수 없습니다. 다른 파일명을 사용하세요.');
    }
  }
  if (path.extname(resolved).toLowerCase() !== '.html') {
    throw new Error('출력 파일은 .html 확장자여야 합니다.');
  }
  return resolved;
}

export function isNetworkOutputPath(filePath) {
  const value = String(filePath || '');
  return /^\\\\\?\\UNC\\/i.test(value)
    || /^\\\\(?![?.]\\)[^\\]/.test(value)
    || /^\/\/[^/]/.test(value);
}

function isUnsupportedWindowsDevicePath(filePath) {
  const value = String(filePath || '');
  if (/^\\\\\.\\/i.test(value)) return true;
  return /^\\\\\?\\/i.test(value)
    && !/^\\\\\?\\(?:UNC\\|[a-z]:\\)/i.test(value);
}

function safeFileSegment(value, fallback = 'category') {
  const normalized = String(value || '')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[. -]+|[. -]+$/g, '')
    .slice(0, 80);
  return normalized || fallback;
}

export function resolveMonitoringOutputFile(cliDir, options = {}, configuredFile = '') {
  if (options.categorySelection && options.groupSelection) {
    throw new Error('--category와 --group은 함께 사용할 수 없습니다.');
  }
  let resolved;
  if (options.mockPath && !options.outputFile) {
    resolved = resolveOutputFile(cliDir, '', path.join(cliDir, 'output', 'mock-monitoring.html'));
  } else if (options.categorySelection && !options.outputFile) {
    const domain = safeFileSegment(options.categorySelection.domainKey, 'category');
    const unit = safeFileSegment(options.categorySelection.unitKey, 'selected');
    resolved = resolveOutputFile(
      cliDir,
      '',
      path.join(cliDir, 'output', `monitoring-${domain}-${unit}.html`),
    );
  } else if (options.groupSelection && !options.outputFile) {
    const groupKey = String(options.groupSelection.domainKey || '');
    const fileName = Object.hasOwn(GROUP_OUTPUT_FILES, groupKey)
      ? GROUP_OUTPUT_FILES[groupKey]
      : '';
    if (!fileName) throw new Error('선택한 그룹의 기본 출력 파일을 결정할 수 없습니다.');
    resolved = resolveOutputFile(cliDir, '', path.join(cliDir, 'output', fileName));
  } else {
    resolved = resolveOutputFile(cliDir, configuredFile, options.outputFile);
  }
  if (isNetworkOutputPath(resolved) && options.allowNetworkOutput !== true) {
    throw new Error('네트워크 공유 경로에는 기본 저장하지 않습니다. 허용하려면 --allow-network-output을 사용하세요.');
  }
  return resolved;
}

export function partialOutputFileFor(outputFile, createdAt = new Date()) {
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(date.getTime())) throw new Error('부분 결과 파일의 생성 시각이 올바르지 않습니다.');
  const stamp = date.toISOString().replace(/[-:]/g, '').replace('.', '');
  const extension = path.extname(outputFile);
  const base = path.basename(outputFile, extension);
  return path.join(path.dirname(outputFile), `${base}.partial-${stamp}${extension}`);
}

export function recoveryFileFor(outputFile) {
  return path.join(path.dirname(outputFile), `.${path.basename(outputFile)}.recovery-backup`);
}

export function recoveryManifestFor(outputFile) {
  return `${recoveryFileFor(outputFile)}.manifest.json`;
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
  const manifestFile = recoveryManifestFor(outputFile);
  const [outputStat, recoveryStat, manifestStat] = await Promise.all([
    lstatOrNull(outputFile),
    lstatOrNull(recoveryFile),
    lstatOrNull(manifestFile),
  ]);
  if (!recoveryStat && !manifestStat) return false;
  if (!recoveryStat && manifestStat) {
    const manifest = await readRecoveryManifest(manifestFile, outputFile);
    if (!manifest) throw recoveryError('고아 복구 표식의 소유 정보를 확인하지 못했습니다.', manifestFile);
    await fs.unlink(manifestFile);
    return true;
  }
  const manifest = manifestStat
    ? await readRecoveryManifest(manifestFile, outputFile)
    : null;
  if (!manifest) {
    throw recoveryError(
      '복구 백업이 이 프로그램이 만든 파일인지 확인할 수 없어 보존했습니다.',
      recoveryFile,
    );
  }
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
    await fs.unlink(manifestFile);
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
  await fs.unlink(manifestFile);
  return true;
}

async function readRecoveryManifest(manifestFile, outputFile) {
  try {
    const parsed = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    const manifestOutput = path.resolve(String(parsed?.outputFile || ''));
    const expectedOutput = path.resolve(outputFile);
    const sameOutput = process.platform === 'win32'
      ? manifestOutput.replaceAll('/', '\\').toLowerCase()
        === expectedOutput.replaceAll('/', '\\').toLowerCase()
      : manifestOutput === expectedOutput;
    if (
      parsed?.app !== RECOVERY_APP
      || parsed?.version !== 1
      || !sameOutput
      || typeof parsed.token !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.token)
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeRecoveryManifest(outputFile) {
  const manifestFile = recoveryManifestFor(outputFile);
  await fs.writeFile(manifestFile, `${JSON.stringify({
    app: RECOVERY_APP,
    version: 1,
    outputFile: path.resolve(outputFile),
    token: randomUUID(),
  })}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  // 원본 HTML을 백업 위치로 옮기기 전에 소유 표식이 디스크에 반영되도록 한다.
  // 그렇지 않으면 전원 중단 뒤 백업은 남지만 표식만 사라져 자동 복구할 수 없다.
  await syncFile(manifestFile);
  return manifestFile;
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
  const manifestFile = recoveryManifestFor(outputFile);
  let backupCreated = false;
  let manifestCreated = false;
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
        await writeRecoveryManifest(outputFile);
        manifestCreated = true;
        await fs.rename(outputFile, backupFile);
        backupCreated = true;
      } catch (backupError) {
        if (manifestCreated) {
          await fs.unlink(manifestFile).catch(() => {});
          manifestCreated = false;
        }
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
            await fs.unlink(manifestFile).catch(() => {});
            manifestCreated = false;
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
      await fs.unlink(manifestFile);
      manifestCreated = false;
    } catch (error) {
      warnCleanup('이전 HTML 백업', error);
    }
  }

  if (primaryError) throw primaryError;
  return outputFile;
}
