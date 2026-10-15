import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  ClaudeCliError,
  resolveWindowsSystemExecutable,
} from './claude-client.mjs';

function windowsEnvironmentValue(name, fallback = '') {
  const entry = Object.entries(process.env)
    .find(([key]) => key.toUpperCase() === name.toUpperCase());
  return String(entry?.[1] ?? fallback);
}

async function fileExists(candidate) {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

function configuredBin(envName, defaultBin, providerLabel) {
  const value = String(process.env[envName] || defaultBin).trim();
  if (!value || /[\0\r\n]/.test(value)) {
    throw new ClaudeCliError('CONFIG', `${envName} 값이 비어 있거나 줄바꿈 문자를 포함합니다.`);
  }
  if (process.platform === 'win32' && /["%!]/.test(value)) {
    throw new ClaudeCliError(
      'CONFIG',
      `Windows의 ${providerLabel} 실행 경로에는 ", %, ! 문자를 사용할 수 없습니다.`,
    );
  }
  return value;
}

function supportedWindowsExecutable(candidate) {
  return ['.exe', '.cmd', '.bat', '.com'].includes(path.extname(candidate).toLowerCase());
}

async function resolveWindowsBin(bin, providerLabel, envName) {
  if (path.isAbsolute(bin)) {
    if (!supportedWindowsExecutable(bin)) {
      throw new ClaudeCliError(
        'CONFIG',
        `Windows의 ${envName}은 .exe, .com, .cmd 또는 .bat 파일이어야 합니다.`,
      );
    }
    if (await fileExists(bin)) return path.resolve(bin);
    throw new ClaudeCliError('CLI_NOT_FOUND', `${providerLabel} 실행 파일을 찾을 수 없습니다: ${bin}`);
  }
  if (/[\\/]/.test(bin)) {
    throw new ClaudeCliError('CONFIG', `${envName}에 폴더를 포함할 때는 절대경로를 사용해야 합니다.`);
  }

  const extensions = path.extname(bin)
    ? ['']
    : windowsEnvironmentValue('PATHEXT', '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map((value) => value.trim())
      .filter(Boolean);
  const directories = windowsEnvironmentValue('PATH')
    .split(path.delimiter)
    .map((value) => value.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${bin}${extension}`);
      if (supportedWindowsExecutable(candidate) && await fileExists(candidate)) {
        return path.resolve(candidate);
      }
    }
  }
  throw new ClaudeCliError(
    'CLI_NOT_FOUND',
    `${providerLabel} 실행 파일 '${bin}'을 PATH에서 찾을 수 없습니다.`,
  );
}

async function resolvePosixBin(bin, providerLabel, envName) {
  if (path.isAbsolute(bin)) {
    try {
      await fs.access(bin, fsConstants.X_OK);
      return path.resolve(bin);
    } catch {
      throw new ClaudeCliError('CLI_NOT_FOUND', `${providerLabel} 실행 파일을 찾을 수 없습니다: ${bin}`);
    }
  }
  if (/[\\/]/.test(bin)) {
    throw new ClaudeCliError('CONFIG', `${envName}에 폴더를 포함할 때는 절대경로를 사용해야 합니다.`);
  }
  for (const directory of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, bin);
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return path.resolve(candidate);
    } catch {}
  }
  throw new ClaudeCliError(
    'CLI_NOT_FOUND',
    `${providerLabel} 실행 파일 '${bin}'을 PATH에서 찾을 수 없습니다.`,
  );
}

function quoteCmdToken(value, label) {
  const token = String(value);
  if (!token || /[\0\r\n"%!]/.test(token)) {
    throw new ClaudeCliError('CONFIG', `${label} 값은 Windows 명령줄에서 안전하게 전달할 수 없습니다.`);
  }
  return `"${token}"`;
}

export function safeCliModel(value, envName) {
  const model = String(value || '').trim();
  if (!model || !/^[a-zA-Z0-9._:/\[\]-]+$/.test(model)) {
    throw new ClaudeCliError('CONFIG', `${envName} 값에 허용되지 않은 문자가 있습니다.`);
  }
  return model;
}

export async function buildCliLaunchSpec({
  args,
  defaultBin,
  envName,
  providerLabel,
}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new ClaudeCliError('CONFIG', `${providerLabel} 실행 인자 형식이 올바르지 않습니다.`);
  }
  const bin = configuredBin(envName, defaultBin, providerLabel);
  const resolved = process.platform === 'win32'
    ? await resolveWindowsBin(bin, providerLabel, envName)
    : await resolvePosixBin(bin, providerLabel, envName);
  const executableVerification = {
    absolutePathVerified: path.isAbsolute(resolved),
    resolvedFromPath: !path.isAbsolute(bin),
  };
  if (process.platform !== 'win32' || ['.exe', '.com'].includes(path.extname(resolved).toLowerCase())) {
    return {
      command: resolved,
      args,
      windowsVerbatimArguments: false,
      executablePath: resolved,
      executableVerification,
    };
  }

  const commandLine = [
    quoteCmdToken(resolved, envName),
    ...args.map((arg) => quoteCmdToken(arg, `${providerLabel} 인자`)),
  ].join(' ');
  return {
    command: await resolveWindowsSystemExecutable('cmd.exe'),
    args: ['/d', '/q', '/v:off', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true,
    executablePath: resolved,
    executableVerification,
  };
}

export function parseCliSemver(output, namePattern = '') {
  const optionalName = namePattern ? `(?:${namePattern}\\s+)?` : '';
  const matcher = new RegExp(
    `^\\s*${optionalName}v?(\\d+)\\.(\\d+)\\.(\\d+)(-[0-9a-z.-]+)?(?:\\+[0-9a-z.-]+)?\\s*$`,
    'i',
  );
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(matcher);
    if (!match) continue;
    const parts = match.slice(1, 4).map((value) => Number.parseInt(value, 10));
    if (parts.some((value) => !Number.isSafeInteger(value) || value < 0)) return null;
    return { parts, prerelease: match[4] || '' };
  }
  return null;
}

export function semverAtLeast(version, minimum) {
  if (!version || !Array.isArray(version.parts) || !Array.isArray(minimum)) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (version.parts[index] > minimum[index]) return true;
    if (version.parts[index] < minimum[index]) return false;
  }
  return !version.prerelease;
}
