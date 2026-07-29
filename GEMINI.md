# Gemini 작업 지침

이 프로젝트의 사내 운용 경로는 PC 로컬에서만 실행됩니다.

- 공식 Gemini CLI와 회사 Gemini Code Assist OAuth만 사용합니다.
- `GEMINI_API_KEY`, `GOOGLE_API_KEY`, Vertex AI 키 인증을 CLI 경로에 추가하지 않습니다.
- Google Drive, Google Apps Script, 공개 Web App을 로컬 CLI 경로에 추가하지 않습니다.
- `01_Config.gs`의 도메인·프롬프트·정규화 정의를 단일 기준으로 유지합니다.
- 메일은 회사 관리자가 승인한 SMTP 릴레이만 사용합니다.
- SMTP 비밀번호, 실제 수신자 명단, 로컬 결과, 발송 이력, 로그는 커밋하지 않습니다.
- 실제 발송 전 `cd cli && npm test`, mock 실행, `--check-smtp`, `--test-email`을 순서대로 수행합니다.
- 전체 발송 옵션 `--send`는 실제 발송 의도가 명확할 때만 사용합니다.
