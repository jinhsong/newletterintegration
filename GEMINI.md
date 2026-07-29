# Gemini 작업 지침

이 프로젝트의 사내 운용 경로는 Gemini CLI 결과를 PC 로컬 HTML로 저장합니다.

- 공식 Gemini CLI와 회사 Gemini Code Assist OAuth만 사용합니다.
- `GEMINI_API_KEY`, `GOOGLE_API_KEY`, Vertex AI 키 인증을 추가하지 않습니다.
- Google Drive, Google Apps Script 실행, SMTP, 메일 발송, 공개 Web App을 추가하지 않습니다.
- `01_Config.gs`의 도메인·프롬프트·정규화 정의를 단일 기준으로 유지합니다.
- HTML은 외부 CSS·JavaScript 없이 자체 포함 파일로 생성합니다.
- `.env`, `cli/output/`, 실행 로그는 읽거나 커밋하지 않습니다.
- 변경 전후 `cd cli && npm test`와 mock HTML 생성을 확인합니다.
