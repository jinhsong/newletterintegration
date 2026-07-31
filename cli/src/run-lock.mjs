import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const DEFAULT_STALE_MS = 8 * 60 * 60 * 1000;

export class AlreadyRunningError extends Error {
  constructor(message, owner = null) {
    super(message);
    this.name = 'AlreadyRunningError';
    this.code = 'ALREADY_RUNNING';
    this.owner = owner;
  }
}

function lockPathFor(outputFile) {
  return path.join(path.dirname(outputFile), `.${path.basename(outputFile)}.run-lock`);
}

async function windowsPipeFor(outputFile) {
  const resolvedOutput = path.resolve(outputFile);
  const realDirectory = await fs.realpath(path.dirname(resolvedOutput));
  const canonicalPath = path.join(realDirectory, path.basename(resolvedOutput))
    .replaceAll('/', '\\')
    .toLowerCase();
  const digest = createHash('sha256').update(canonicalPath, 'utf8').digest('hex');
  return `\\\\.\\pipe\\trade-monitor-${digest}`;
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function activeOwner(owner, now, staleMs) {
  const started = Date.parse(owner?.startedAt || '');
  if (!Number.isFinite(started) || now - started > staleMs || started > now + 60000) return false;
  return processExists(Number(owner?.pid));
}

async function readOwner(lockFile) {
  try {
    return JSON.parse(await fs.readFile(lockFile, 'utf8'));
  } catch {
    return null;
  }
}

function listenOnWindowsPipe(pipeName) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      // 이후의 예기치 않은 서버 오류가 프로세스를 쓰러뜨리지 않게 진단만 남긴다.
      server.on('error', (error) => {
        console.warn(`실행 잠금 파이프 경고: ${error.message}`);
      });
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(pipeName);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function acquireWindowsRunLock(outputFile, options) {
  const lockFile = lockPathFor(outputFile);
  const now = options.now ?? Date.now();
  const token = randomUUID();
  const owner = {
    pid: process.pid,
    startedAt: new Date(now).toISOString(),
    outputFile: path.resolve(outputFile),
    token,
  };

  await fs.mkdir(path.dirname(lockFile), { recursive: true });
  const pipeName = await windowsPipeFor(outputFile);
  let server;
  try {
    server = await listenOnWindowsPipe(pipeName);
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    const existing = await readOwner(lockFile);
    const since = existing?.startedAt ? ` (${existing.startedAt} 시작)` : '';
    throw new AlreadyRunningError(
      `같은 결과 파일을 만드는 모니터링이 이미 실행 중입니다${since}.`,
      existing,
    );
  }

  try {
    // 파이프를 먼저 독점했으므로 오래된 진단 파일은 경쟁 없이 교체할 수 있다.
    await fs.writeFile(lockFile, `${JSON.stringify(owner)}\n`, {
      encoding: 'utf8',
      flag: 'w',
      mode: 0o600,
    });
  } catch (error) {
    await closeServer(server).catch(() => {});
    throw error;
  }

  let released = false;
  return {
    file: lockFile,
    owner,
    async release() {
      if (released) return;
      released = true;
      try {
        const current = await readOwner(lockFile);
        if (current?.token === token) {
          await fs.unlink(lockFile).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
      } finally {
        await closeServer(server);
      }
    },
  };
}

async function acquirePortableFileRunLock(outputFile, options) {
  const lockFile = lockPathFor(outputFile);
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const now = options.now ?? Date.now();
  const token = randomUUID();
  const owner = {
    pid: process.pid,
    startedAt: new Date(now).toISOString(),
    outputFile: path.resolve(outputFile),
    token,
  };

  await fs.mkdir(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle;
    let created = false;
    try {
      handle = await fs.open(lockFile, 'wx', 0o600);
      created = true;
      await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
      await handle.close();
      return {
        file: lockFile,
        owner,
        async release() {
          const current = await readOwner(lockFile);
          if (current?.token !== token) return;
          await fs.unlink(lockFile).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
          });
        },
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (created) await fs.unlink(lockFile).catch(() => {});
      if (error.code !== 'EEXIST') throw error;
      const existing = await readOwner(lockFile);
      if (activeOwner(existing, now, staleMs)) {
        const since = existing?.startedAt ? ` (${existing.startedAt} 시작)` : '';
        throw new AlreadyRunningError(`같은 결과 파일을 만드는 모니터링이 이미 실행 중입니다${since}.`, existing);
      }
      throw new AlreadyRunningError(
        '비-Windows 환경에서는 오래되었거나 불완전한 실행 잠금을 안전하게 자동 회수할 수 없습니다.',
        existing,
      );
    }
  }
  throw new AlreadyRunningError('실행 잠금 파일을 확보하지 못했습니다. 잠시 후 다시 시도하세요.');
}

export async function acquireRunLock(outputFile, options = {}) {
  if (process.platform === 'win32') return acquireWindowsRunLock(outputFile, options);
  return acquirePortableFileRunLock(outputFile, options);
}

export { lockPathFor, windowsPipeFor };
