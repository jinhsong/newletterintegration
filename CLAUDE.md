# 프로젝트 작업 지침

이 저장소는 회사 Claude Code CLI를 이용해 통상 동향을 조사하고 PC 로컬 HTML 한 파일을
생성하는 수동 실행 도구입니다.

- 런타임은 순수 Node.js ES modules이며 Apps Script 코드를 추가하지 않습니다.
- 메일, SMTP, Gmail, Google Drive, Sheets, Obsidian, 예약·시간 트리거를 추가하지 않습니다.
- 별도 API 키를 요구하거나 저장하지 않고 현재 회사 Claude Code CLI 인증을 사용합니다.
- `cli/.env`에서 읽을 수 있는 키는 실행기에 필요한 명시적 allowlist로 제한하며,
  Claude Code 인증·회사 관리 설정을 저장소 설정으로 주입하지 않습니다.
- 조사 영역과 프롬프트의 기준은 `cli/src/config.mjs`입니다.
- 전체 조사 산출물은 `cli/output/monitoring.html`, 단일 카테고리 조사 산출물은
  `cli/output/monitoring-category.html`입니다.
- HTML은 외부 CSS, JavaScript, 이미지 없이 자체 포함 형태로 렌더링합니다.
- 모델 텍스트는 반드시 HTML escape하고 출처는 공개 HTTPS URL 형식만 허용합니다.
- HTML은 '검색 후 0건', '수집 실패로 확인 불가', '구버전 상태 정보 없음'을
  서로 다르게 표시해야 합니다.
- 모든 결과에 'AI 예비 조사·원문 수동 확인 필수'를 표시하고, 출처명·실제 hostname·
  `sourceVerification`을 함께 보여줍니다. HTTPS 형식 검사를 원문 검증으로 표현하지 않습니다.
- 외부 원문 URL을 Node에서 직접 fetch하거나 DNS 조회하지 않습니다.
- Claude Code는 비어 있는 OS 임시 폴더에서 `--safe-mode`로 실행하고,
  `--tools WebSearch`, `--permission-mode dontAsk`, 엄격한 MCP 차단 인수로
  파일·셸·WebFetch·사용자 정의 도구를 사용할 수 없게 합니다.
- 회사 hardening이 요청한 `dontAsk`를 `default`로 강제하는 경우도
  `--allowedTools WebSearch`, 정확한 init 도구 목록, 권한 거부 없음과 실제 도구 이벤트를
  모두 검증한 때에만 허용합니다. 다른 권한 모드는 거부합니다.
- 18개 카테고리는 각각 별도의 Claude 호출로 순차 조사합니다. 단일 카테고리 실행은
  선택한 하나만 호출합니다.
- 각 카테고리는 `cli/src/config.mjs`에 비어 있지 않은 신뢰 공식 도메인 목록을 둡니다.
  stream-json 기록에서 서로 다른 검색어, 그 목록 또는 하위 도메인만 넣은
  `allowed_domains` 공식기관 검색 1회 이상, 도메인 제한 없는 일반 동향 검색 1회 이상이
  모두 성공한 응답만 채택합니다. 목록 밖 도메인과 응답·검색 검증 오류는 해당
  카테고리를 한 번만 재조사합니다.
- 보안 정책이나 사전 점검을 우회하는 fallback을 추가하지 않습니다.
- Windows 동시 실행 잠금은 결과 경로별 named pipe를 실제 잠금으로 사용하고, 파일은
  진단 정보로만 사용합니다. 사용자에게 잠금 파일 수동 삭제를 지시하지 않습니다.
- 변경 후 저장소 루트에서 `npm --prefix .\cli test`와 mock 실행을 확인합니다.
- `.env`와 `cli/output/`은 읽거나 커밋하지 않습니다.
