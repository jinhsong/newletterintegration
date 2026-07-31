# 프로젝트 작업 지침

이 저장소는 회사 Gemini CLI를 이용해 통상 동향을 조사하고 PC 로컬 HTML 한 파일을
생성하는 수동 실행 도구입니다.

- 런타임은 순수 Node.js ES modules이며 Apps Script 코드를 추가하지 않습니다.
- 메일, SMTP, Gmail, Google Drive, Sheets, Obsidian, 예약·시간 트리거를 추가하지 않습니다.
- 별도 Gemini API 키를 요구하지 않고 현재 회사 Gemini CLI 인증을 사용합니다.
- `cli/.env`에서 읽을 수 있는 키는 실행기에 필요한 명시적 allowlist로 제한하며,
  Gemini 시스템 설정·중앙 정책 경로를 저장소 설정으로 주입하지 않습니다.
- 조사 영역과 프롬프트의 기준은 `cli/src/config.mjs`입니다.
- 최종 산출물은 `cli/output/monitoring.html` 하나입니다.
- HTML은 외부 CSS, JavaScript, 이미지 없이 자체 포함 형태로 렌더링합니다.
- 모델 텍스트는 반드시 HTML escape하고 출처는 공개 HTTPS URL 형식만 허용합니다.
- HTML은 '검색 후 0건', '수집 실패로 확인 불가', '구버전 상태 정보 없음'을
  서로 다르게 표시해야 합니다.
- 모든 결과에 'AI 예비 조사·원문 수동 확인 필수'를 표시하고, 출처명·실제 hostname·
  `sourceVerification`을 함께 보여줍니다. HTTPS 형식 검사를 원문 검증으로 표현하지 않습니다.
- 외부 원문 URL을 Node에서 직접 fetch하거나 DNS 조회하지 않습니다.
- Gemini는 검색 전용 보안 설정만 둔 OS 임시 폴더에서 실행하고,
  `cli/policies/research-only.toml`로 웹 검색 외의 파일·셸·`web_fetch` 도구를
  차단합니다. hooks·skills·사용자 정의 도구·확장·MCP 서버도 비활성화합니다.
- 요청한 카테고리 수 이상의 `google_web_search` 성공 기록이 확인된 응답만
  채택하며, 큰 단위 검증이 실패하면 카테고리를 하나씩 다시 조사합니다.
- 보안 정책이나 사전 점검을 우회하는 fallback을 추가하지 않습니다.
- Windows 동시 실행 잠금은 결과 경로별 named pipe를 실제 잠금으로 사용하고, 파일은
  진단 정보로만 사용합니다. 사용자에게 잠금 파일 수동 삭제를 지시하지 않습니다.
- 변경 후 저장소 루트에서 `npm --prefix .\cli test`와 mock 실행을 확인합니다.
- `.env`와 `cli/output/`은 읽거나 커밋하지 않습니다.
