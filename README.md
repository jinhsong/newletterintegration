# 회사 Claude CLI 통상 모니터링 · 7.2.0

회사 계정으로 로그인된 Claude Code CLI가 통상 동향을 조사하고 PC에 HTML 보고서를 저장합니다.
기존 `sfu5of`의 관세 9개·수출통제 5개·무역구제 3개, 총 17개 분류를 유지합니다.

프로그램에서 별도 Gemini·Claude API 키를 입력하거나 LLM API를 직접 호출하지 않습니다.
회사 Claude CLI의 기존 인증·프록시·관리 설정으로 접속합니다. 메일이나 Google Sheets 설정은 필요 없습니다.
실제 조사는 회사 Claude 서비스와 웹 검색에 접속하므로 회사 계정의 Claude Code·웹 검색 사용 권한이 필요합니다.

## 1. 처음 한 번만 준비

회사 승인 경로로 설치된 Git, Node.js 20 이상, Claude Code 2.1.214 이상을 사용합니다.
PowerShell에서 확인합니다.

```powershell
git --version
node --version
claude --version
claude auth status
```

회사 계정 로그인이 필요하면 사내 안내를 우선 따르세요. 회사에서 SSO를 사용하는 경우:

```powershell
claude auth login --sso
```

이미 회사 계정으로 로그인되어 있으면 다시 로그인하지 않아도 됩니다.
API 키 발급이나 `--console` 로그인은 이 도구의 준비 절차에 포함하지 않습니다.

이번 브랜치를 받습니다.

```powershell
git clone --branch codex/sfu5of-claude-local-html https://github.com/jinhsong/newletterintegration.git newletterintegration-company
cd .\newletterintegration-company
```

별도 Node 패키지가 없으므로 `npm install`은 필요 없습니다.

## 2. 먼저 카테고리 하나로 연결 확인

```powershell
.\run-monitoring.cmd --category "export:US" --lookback 24
```

회사 Claude CLI로 미국 수출통제만 조사한 후 브라우저에서 보고서를 엽니다.
결과는 `cli/output/monitoring-export-미국.html`에 저장됩니다.

모든 분류를 조사하려면:

```powershell
.\run-monitoring.cmd
```

Claude는 고정되어 모델 선택 질문이 나오지 않습니다. 조사 기간만 입력합니다.
빈 입력은 KST 월요일 72시간, 그 외 요일 24시간입니다. 직접 입력은 1~168시간입니다.
완료되면 `cli/output/monitoring.html`을 브라우저로 엽니다.

전체 표준 조사는 17개 카테고리를 순차 실행하고 각 카테고리에서 공식기관과 일반 동향을 여러 번 검색합니다.
단일 카테고리보다 오래 걸리며 회사 Claude 사용량이 소모됩니다.
기본 제한은 카테고리당 10분, 표준 전체 조사 120분입니다.

## 3. 자주 쓰는 명령

```powershell
# 최근 이틀 전체 조사
.\run-monitoring.cmd --lookback 48

# 수출통제만
.\run-monitoring.cmd --group "수출통제" --lookback 24

# 중국 관세만
.\run-monitoring.cmd --category "customs:중국" --lookback 24

# 더 빠르게 / 더 깊게
.\run-monitoring.cmd --depth fast --lookback 24
.\run-monitoring.cmd --depth deep --lookback 72

# 지정한 파일에 저장하고 자동으로 열지 않기
.\run-monitoring.cmd --lookback 24 --out ".\보고서\통상동향.html" --no-open

# 분류 목록·도움말
.\run-monitoring.cmd --list-groups
.\run-monitoring.cmd --list-categories
.\run-monitoring.cmd --help
```

수출통제 식별자 `US`, `KR`, `EUJP`, `CNVN`, `UNETC`를 그대로 쓸 수 있습니다.
예를 들어 `export:UNETC`와 `export:UN 및 기타`는 같은 분류입니다.
`UN 및 기타`의 범위는 원본처럼 UN·다자 수출통제체제 발표입니다.

## 4. 결과를 확인하는 방법

| 실행 범위 | 기본 파일 |
|---|---|
| 전체 | `cli/output/monitoring.html` |
| 관세 | `cli/output/monitoring-customs.html` |
| 수출통제 | `cli/output/monitoring-export.html` |
| 무역구제 | `cli/output/monitoring-trade.html` |
| 카테고리 하나 | `cli/output/monitoring-{영역}-{카테고리}.html` |
| 예제 화면 | `cli/output/mock-monitoring.html` |

HTML은 외부 CSS·이미지·스크립트가 없는 단일 파일이어서 저장·인쇄할 수 있습니다.
보고서에는 원문 링크, 발표일·시행일, 기업 영향, 영역·카테고리별 분석, 완료 범위와 검증 제외 건수가 표시됩니다.

검색 후 0건인 분류와 조사 실패로 확인할 수 없는 분류는 다르게 표시합니다.
잘못된 JSON·필수 항목 누락·날짜 또는 출처 검증 실패를 정상 무동향으로 처리하지 않습니다.
일부만 완료되면 시각이 붙은 `.partial-*.html`로 저장하고 기존 대표 보고서는 보존합니다.
전체 실패 시에는 기존 대표 보고서를 교체하지 않습니다. 부분 완료 종료 코드는 2입니다.

발표시각이 확인된 항목은 정확한 시각으로, 날짜만 확인된 항목은 KST 달력 날짜로 판정합니다.
중복 제거는 이번 보고서 안에서 적용합니다. 예전 Google Sheets 이력은 조회하지 않으므로
기간이 겹치는 여러 실행 사이에는 같은 동향이 다시 포함될 수 있습니다.

Claude의 실제 웹 검색 기록과 항목의 출처 URL을 연결하지만, 법령 원문 전체의 수치·문장을
자동 대조하는 기능은 아닙니다. 업무에 적용할 때는 원문을 확인하세요.

## 5. 회사 환경에서 필요한 설정

PATH에서 `claude`를 찾을 수 없거나 보고서 위치를 고정할 때만 설정합니다.

```powershell
Copy-Item .\cli\.env.example .\cli\.env
notepad .\cli\.env
```

`CLAUDE_CLI_BIN`에는 회사 설치 파일 경로를, `LOCAL_OUTPUT_FILE`에는 결과 경로를 지정할 수 있습니다.
`CLAUDE_CLI_MODEL`을 비워두면 회사 CLI 기본 모델을 사용합니다.
API 키·계정 비밀번호·인증 토큰은 이 파일에 넣지 않습니다.

로그인 또는 프록시 오류는 회사 Claude CLI 설정에서 확인하세요.
웹 검색이 차단되어 있으면 모델 기억으로 대신 작성하지 않고 실패로 표시합니다.
CLI가 허용되지 않은 파일·셸·MCP 도구를 사용하거나 회사 정책과 충돌하면 실행을 중단합니다.
회사에서 관리하는 인증·프록시 설정을 프로그램이 삭제하거나 변경하지 않습니다.

## 6. 로그인 없이 화면 시험

아래 명령은 실제 AI 호출 없이 예제 HTML만 생성합니다.

```powershell
.\run-monitoring.cmd --mock .\cli\test\fixtures\company-responses.json
```

예제 화면에는 `MOCK · 테스트 전용`이 표시됩니다.

개발자 검사:

```powershell
npm --prefix .\cli test
```

Windows Node 20·22·24에서 기존 실행기 검사와 회사 전용 17개 분류 검사를 수행하도록 구성했습니다.
실제 사내 SSO·프록시·검색 권한은 회사 PC의 단일 카테고리 실행으로 최종 확인해야 합니다.

## 소스 구성

- `cli/company.mjs`: 회사 Claude 고정 실행기
- `cli/src/config.mjs`: 기존 통합 모니터링 17개 분류 및 검색 기준
- `cli/src/claude-client.mjs`: 회사 CLI 실행·검색 이벤트 검증
- `cli/src/pipeline.mjs`: 수집·날짜/출처 검증·중복 제거·부분 실패 처리
- `cli/src/html-renderer.mjs`: 단일 HTML 보고서
- `01_Config.gs`~`09_Requests_Triggers.gs`: 기존 Apps Script 소스 보관
- [기존 Apps Script 설치 문서](docs/APPS_SCRIPT.md)

기존 다중 CLI 엔진은 내부 재사용 코드로 남아 있습니다. 사내 실행은 `run-monitoring.cmd` 또는
`node cli/company.mjs`를 사용하세요.

공식 참고: [Claude CLI](https://code.claude.com/docs/en/cli-reference) ·
[회사 인증](https://code.claude.com/docs/en/authentication)
