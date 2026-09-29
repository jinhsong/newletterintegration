export class GasError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function createGasClient(config, fetchImpl = fetch) {
  return async function call(action, params = {}) {
    try {
      const signal = AbortSignal.timeout(25000);
      let response = await fetchImpl(config.gasUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...params, action, token: config.gasToken }),
        redirect: 'manual', signal
      });
      // Apps Script ContentService redirects to a temporary Google-hosted URL.
      // Follow as GET and NEVER forward the token/body to the redirect target.
      if ([301, 302, 303].includes(response.status)) {
        const location = new URL(response.headers.get('location') || '', config.gasUrl);
        if (location.protocol !== 'https:' || location.hostname !== 'script.googleusercontent.com' || location.username || location.password) {
          throw new GasError('DEPLOYMENT_ACCESS', '웹 앱 배포의 접근 설정을 확인하세요.');
        }
        response = await fetchImpl(location.href, { method: 'GET', redirect: 'error', signal });
      }
      if (!response.ok) throw new GasError('UPSTREAM_HTTP', `Apps Script HTTP ${response.status}`);
      let result;
      try { result = await response.json(); } catch { throw new GasError('UPSTREAM_FORMAT', 'JSON 응답이 아닙니다. /exec 배포 URL과 접근 설정을 확인하세요.'); }
      if (result?.ok === false) throw new GasError(result.error?.code || 'UPSTREAM_ERROR', result.error?.message || 'Apps Script 작업 실패');
      if (result?.ok !== true || !result.data || typeof result.data !== 'object') throw new GasError('UPSTREAM_FORMAT', 'Apps Script 응답 형식이 올바르지 않습니다.');
      return result.data;
    } catch (error) {
      if (error instanceof GasError) throw error;
      throw new GasError('CONNECTION_ERROR', '연결이 중단되었거나 응답 시간이 초과되었습니다. 같은 requestId로 상태를 확인하거나 재시도하세요.');
    }
  };
}
