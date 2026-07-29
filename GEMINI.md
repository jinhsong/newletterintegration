# Gemini 작업 지침

이 프로젝트는 관세·수출통제·무역구제 17개 분야를 조사해 하나의 뉴스레터로
발송합니다. Google Apps Script API 모드와 사내 Gemini CLI Enterprise OAuth
모드를 함께 지원합니다.

- Gemini CLI 작업에서는 API 키를 생성·요청·저장하지 않습니다.
- `GEMINI_API_KEY`, `GOOGLE_API_KEY`, Vertex AI 키 인증을 CLI 경로에 추가하지 않습니다.
- `01_Config.gs`의 도메인·프롬프트·정규화 정의를 단일 기준으로 유지합니다.
- CLI 결과 스키마를 변경하면 `10_Cli_Bridge.gs`의 검증·정규화도 함께 수정합니다.
- 실제 발송 전 `cd cli && npm test`와 mock 실행을 먼저 수행합니다.
- `cli/.env`, `cli/output/`, 로그 파일은 읽거나 커밋하지 않습니다.
- `--deliver`와 `--force`는 사용자가 실제 발송을 명시했을 때만 사용합니다.
