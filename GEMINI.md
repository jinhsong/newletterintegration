# 프로젝트 작업 지침

이 저장소는 회사 Gemini CLI를 이용해 통상 동향을 조사하고 PC 로컬 HTML 한 파일을
생성하는 수동 실행 도구입니다.

- 런타임은 순수 Node.js ES modules이며 Apps Script 코드를 추가하지 않습니다.
- 메일, SMTP, Gmail, Google Drive, Sheets, Obsidian, 예약·시간 트리거를 추가하지 않습니다.
- 별도 Gemini API 키를 요구하지 않고 현재 회사 Gemini CLI 인증을 사용합니다.
- 조사 영역과 프롬프트의 기준은 `cli/src/config.mjs`입니다.
- 최종 산출물은 `cli/output/monitoring.html` 하나입니다.
- HTML은 외부 CSS, JavaScript, 이미지 없이 자체 포함 형태로 렌더링합니다.
- 모델 텍스트는 반드시 HTML escape하고 출처는 공개 HTTPS URL 형식만 허용합니다.
- 외부 원문 URL을 Node에서 직접 fetch하거나 DNS 조회하지 않습니다.
- 변경 후 `cd cli`에서 `npm test`와 mock 실행을 확인합니다.
- `.env`와 `cli/output/`은 읽거나 커밋하지 않습니다.
