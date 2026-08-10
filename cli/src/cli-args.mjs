import path from 'node:path';

const LOOKBACK_VALUES = new Set(['24', '72', '168']);
const DEPTH_VALUES = new Set(['fast', 'standard', 'deep']);

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} 뒤에 값을 입력해야 합니다.`);
  }
  return value;
}

export function parseArgs(argv, cwd = process.cwd()) {
  const options = { open: false, depth: 'standard' };
  let categorySeen = false;
  let groupSeen = false;
  let depthSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--lookback') {
      const value = optionValue(argv, index, arg);
      if (!LOOKBACK_VALUES.has(value)) {
        throw new Error('--lookback은 24, 72, 168 중 하나여야 합니다.');
      }
      options.lookbackHours = Number(value);
      index += 1;
    } else if (arg === '--depth') {
      if (depthSeen) throw new Error('--depth는 한 번만 입력할 수 있습니다.');
      const value = optionValue(argv, index, arg).trim().toLowerCase();
      if (!DEPTH_VALUES.has(value)) {
        throw new Error('--depth는 fast, standard, deep 중 하나여야 합니다.');
      }
      options.depth = value;
      depthSeen = true;
      index += 1;
    } else if (arg === '--out') {
      options.outputFile = path.resolve(cwd, optionValue(argv, index, arg));
      index += 1;
    } else if (arg === '--mock') {
      options.mockPath = path.resolve(cwd, optionValue(argv, index, arg));
      index += 1;
    } else if (arg === '--category') {
      if (categorySeen) throw new Error('--category는 한 번만 입력할 수 있습니다.');
      options.category = optionValue(argv, index, arg).trim();
      if (!options.category) throw new Error('--category 뒤에 카테고리 값을 입력해야 합니다.');
      categorySeen = true;
      index += 1;
    } else if (arg === '--group') {
      if (groupSeen) throw new Error('--group은 한 번만 입력할 수 있습니다.');
      options.group = optionValue(argv, index, arg).trim();
      if (!options.group) throw new Error('--group 뒤에 그룹 값을 입력해야 합니다.');
      groupSeen = true;
      index += 1;
    } else if (arg === '--list-categories') {
      options.listCategories = true;
    } else if (arg === '--list-groups') {
      options.listGroups = true;
    } else if (arg === '--open') {
      options.open = true;
    } else if (arg === '--no-open') {
      options.open = false;
    } else if (arg === '--allow-partial-overwrite') {
      options.allowPartialOverwrite = true;
    } else if (arg === '--allow-parallel') {
      options.allowParallel = true;
    } else if (arg === '--allow-network-output') {
      options.allowNetworkOutput = true;
    } else if (arg === '--version') {
      options.version = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`알 수 없는 인자: ${arg}`);
    }
  }
  if (options.category && options.group) {
    throw new Error('--category와 --group은 함께 사용할 수 없습니다.');
  }
  if (options.listCategories && options.listGroups) {
    throw new Error('--list-categories와 --list-groups는 함께 사용할 수 없습니다.');
  }
  if ((options.listCategories || options.listGroups) && (
    options.category
    || options.group
    || options.lookbackHours
    || depthSeen
    || options.outputFile
    || options.mockPath
    || options.allowPartialOverwrite
    || options.allowParallel
    || options.allowNetworkOutput
  )) {
    const option = options.listGroups ? '--list-groups' : '--list-categories';
    throw new Error(`${option}는 다른 실행 옵션과 함께 사용할 수 없습니다.`);
  }
  return options;
}
