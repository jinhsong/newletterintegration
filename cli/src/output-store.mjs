import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

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

export async function saveHtmlOutput(html, outputFile) {
  const outputDir = path.dirname(outputFile);
  const tempFile = path.join(outputDir, `.${path.basename(outputFile)}.${randomUUID()}.tmp`);
  const backupFile = path.join(outputDir, `.${path.basename(outputFile)}.${randomUUID()}.backup`);
  let backupCreated = false;
  let replacementSucceeded = false;
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(tempFile, html, { encoding: 'utf8', flag: 'wx' });
  try {
    await fs.rename(tempFile, outputFile);
    replacementSucceeded = true;
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
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
        await fs.rename(backupFile, outputFile).catch(() => {});
      }
      throw replaceError;
    }
  } finally {
    await fs.unlink(tempFile).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (backupCreated && replacementSucceeded) {
      await fs.unlink(backupFile).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
  return outputFile;
}
