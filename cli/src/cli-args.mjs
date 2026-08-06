import path from 'node:path';

const LOOKBACK_VALUES = new Set(['24', '72', '168']);

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} 뒤에 값을 입력해야 합니다.`);
  }
  return value;
}

export function parseArgs(argv, cwd = process.cwd()) {
  const options = { open: false };
  let categorySeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--lookback') {
      const value = optionValue(argv, index, arg);
      if (!LOOKBACK_VALUES.has(value)) {
        throw new Error('--lookback은 24, 72, 168 중 하나여야 합니다.');
      }
      options.lookbackHours = Number(value);
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
    } else if (arg === '--list-categories') {
      options.listCategories = true;
    } else if (arg === '--open') {
      options.open = true;
    } else if (arg === '--no-open') {
      options.open = false;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`알 수 없는 인자: ${arg}`);
    }
  }
  if (options.listCategories && (
    options.category
    || options.lookbackHours
    || options.outputFile
    || options.mockPath
  )) {
    throw new Error('--list-categories는 다른 실행 옵션과 함께 사용할 수 없습니다.');
  }
  return options;
}
