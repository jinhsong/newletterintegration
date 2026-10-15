function stripFences(value) {
  return String(value || '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
}

export function parseJsonArray(value) {
  const text = stripFences(value);
  if (!text || text === '[]') return [];

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // 복구 진행
  }

  const cleaned = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  const first = cleaned.indexOf('[');
  const last = cleaned.lastIndexOf(']');
  if (first !== -1 && last > first) {
    try {
      const parsed = JSON.parse(cleaned.slice(first, last + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // 개별 객체 복구 진행
    }
  }

  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        try {
          objects.push(JSON.parse(cleaned.slice(start, i + 1)));
        } catch {
          // 복구 불가 객체는 건너뜀
        }
        start = -1;
      }
    }
  }
  return objects;
}

export function parseJsonObject(value) {
  const text = stripFences(value);
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // 객체 구간 복구 진행
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    const parsed = JSON.parse(text.slice(first, last + 1));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  }
  throw new Error('JSON 객체를 복구하지 못했습니다.');
}
