import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

async function writeAtomic(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, content, {
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

export function resolveOutputRoot(cliDir, configuredPath, optionPath) {
  if (optionPath) return path.resolve(optionPath);
  return configuredPath
    ? path.resolve(cliDir, configuredPath)
    : path.join(cliDir, 'output');
}

export async function acquireOutputLock(outputRoot) {
  await fs.mkdir(outputRoot, { recursive: true });
  const lockPath = path.join(outputRoot, '.monitor.lock');
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

export async function saveHtmlOutput(payload, options) {
  const runDir = path.join(
    options.outputRoot,
    'archive',
    `${payload.deliveryKey}-${payload.runId.slice(-8)}`,
  );
  const latestDir = path.join(options.outputRoot, 'latest');
  const resultJson = `${JSON.stringify(payload, null, 2)}\n`;
  const files = {
    html: options.html,
    markdown: options.markdown,
    json: resultJson,
  };
  await fs.mkdir(runDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(runDir, 'newsletter.html'), files.html, 'utf8'),
    fs.writeFile(path.join(runDir, 'summary.md'), files.markdown, 'utf8'),
    fs.writeFile(path.join(runDir, 'result.json'), files.json, 'utf8'),
  ]);
  await Promise.all([
    writeAtomic(path.join(latestDir, 'newsletter.html'), files.html),
    writeAtomic(path.join(latestDir, 'summary.md'), files.markdown),
    writeAtomic(path.join(latestDir, 'result.json'), files.json),
  ]);
  return {
    runDir,
    latestDir,
    htmlPath: path.join(latestDir, 'newsletter.html'),
    markdownPath: path.join(latestDir, 'summary.md'),
    jsonPath: path.join(latestDir, 'result.json'),
  };
}
