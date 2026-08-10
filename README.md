# Claude Code CLI 글로벌 통상 모니터링

회사 계정으로 로그인된 Claude Code CLI가 관세·수출통제·무역구제의 최신 동향을
`WebSearch`로 조사하고, 결과를 PC의 자체 포함 HTML 파일 하나로 저장합니다.

메일 발송, 예약 실행, Google Drive, Apps Script, Obsidian, 외부 데이터베이스는 사용하지
않습니다. 별도 API 키를 이 저장소에 입력하거나 저장할 필요도 없습니다.

## 처음 한 번만 준비하기

### 1. PowerShell 열기

Windows 시작 메뉴에서 `PowerShell`을 검색해 실행합니다. 관리자 권한은 보통 필요하지
않습니다.

### 2. 필수 프로그램 확인

아래 두 줄을 한 줄씩 입력합니다.

```powershell
node --version
claude --version
```

- Node.js는 `v20` 이상이어야 합니다.
- Claude Code는 `2.1.214` 이상이어야 합니다. 가능하면 회사가 승인한 최신 버전을
  사용하세요.
- 명령을 찾을 수 없으면 회사 소프트웨어 센터나 IT 담당자를 통해 설치해야 합니다.

Claude 실행 파일이 PATH에 없고 실제 위치를 알고 있다면 다음처럼 확인할 수 있습니다.

```powershell
& "C:\Program Files\Company Claude\claude.exe" --version
```

### 3. 회사 계정 로그인 확인

```powershell
claude auth status --text
```

로그인되지 않았다고 나오면 회사 정책이 허용하는 경우 다음 명령으로 SSO 로그인을
시작합니다.

```powershell
claude auth login --sso
```

회사에서 별도 로그인 방법이나 AWS·Google Cloud·Microsoft Foundry 연결을 배포했다면
그 안내를 우선 따르세요. 이 프로그램은 현재 PowerShell에 이미 설정된 회사 인증,
프록시, 사내 인증서 환경을 Claude 프로세스에 전달합니다.

> `ANTHROPIC_API_KEY` 또는 `ANTHROPIC_AUTH_TOKEN`이 PowerShell에 이미 설정되어 있으면
> Claude Code의 회사 구독 로그인보다 우선할 수 있습니다. 프로그램이 값을 만들거나
> 저장하지는 않습니다. 회사에서 의도적으로 배포한 값인지 IT 담당자에게 확인하세요.

### 4. 저장소 받기

원하는 상위 폴더로 이동한 다음 아래 명령을 한 번만 실행합니다.

```powershell
git clone --branch agent/claude-cli-category-deep-scan https://github.com/jinhsong/newletterintegration.git
cd .\newletterintegration
```

이미 저장소가 있다면 다시 clone하지 않습니다.

```powershell
cd C:\Users\jinh.song\newletterintegration
git fetch origin
git switch agent/claude-cli-category-deep-scan
git pull --ff-only origin agent/claude-cli-category-deep-scan
```

경로가 다르면 첫 번째 줄만 실제 저장 위치로 바꾸세요.

## 모니터링 실행하기

저장소 폴더에서 다음 한 줄만 입력하면 됩니다.

```powershell
.\run-monitoring.cmd
```

프로그램은 다음 순서로 동작합니다.

1. Claude Code 버전을 확인합니다.
2. 18개 카테고리를 하나씩 순서대로 조사합니다.
3. 각 카테고리에서 서로 다른 검색어로 신뢰 공식기관 검색 3회와 일반 동향 검색 3회를
   실행합니다. 법령·집행지침·품목, 주요 언론·현지어/업계·한국 공급망 관점을 나눠 봅니다.
4. 결과를 `cli\output\monitoring.html`에 안전하게 교체 저장합니다.
5. 저장된 HTML을 기본 브라우저로 엽니다.

메일, 예약 작업, 외부 저장은 실행하지 않습니다. 다음 실행 때는 clone이나 로그인 명령을
반복할 필요 없이 저장소 폴더에서 `.\run-monitoring.cmd`만 실행하면 됩니다.

정상 실행 기준으로 Claude 조사 호출은 18회이고, 성공한 WebSearch는 최소 108회입니다.
중복 제거 후 카테고리별로 최대 10건을 HTML에 담습니다.
회사 네트워크와 Claude 응답 속도에 따라 시간이 걸릴 수 있으므로 실행 중에는 같은 결과를
대상으로 다른 모니터링을 시작하지 마세요.

### 관세·수출통제·무역구제 그룹 하나만 조사하기

먼저 선택할 수 있는 그룹을 확인합니다. 이 명령은 Claude에 접속하지 않습니다.

```powershell
.\run-monitoring.cmd --list-groups
```

그룹 이름은 한글과 영문을 모두 사용할 수 있습니다.

```powershell
.\run-monitoring.cmd --group "관세"
.\run-monitoring.cmd --group "수출통제"
.\run-monitoring.cmd --group "무역구제"
```

영문으로는 각각 `customs`, `export`, `trade`입니다. 그룹 실행도 여러 카테고리를 한 번의
Claude 요청으로 합치지 않습니다. 현재의 심층 조사 품질을 유지하기 위해 그룹 안의 각
카테고리를 하나씩 조사합니다.

| 선택 그룹 | 카테고리 | 기본 Claude 조사 호출 | 최소 WebSearch | 기본 결과 파일 |
|---|---:|---:|---:|---|
| 관세 | 9개 | 9회 | 54회 | `cli\output\monitoring-customs.html` |
| 수출통제 | 6개 | 6회 | 36회 | `cli\output\monitoring-export.html` |
| 무역구제 | 3개 | 3회 | 18회 | `cli\output\monitoring-trade.html` |

응답 검증에 실패해 재조사가 필요한 카테고리는 한 번 더 호출될 수 있으므로 실제 호출 수와
실행 시간은 표보다 늘어날 수 있습니다.

따라서 세 그룹 결과는 서로 덮어쓰지 않으며, 전체 결과인 `monitoring.html`도 그대로
보존됩니다. 원하는 파일명을 직접 지정하려면 `--out`을 함께 사용하세요.

```powershell
.\run-monitoring.cmd --group "관세" --out "C:\Users\jinh.song\Documents\관세동향.html"
```

`--group`과 `--category`는 동시에 사용할 수 없습니다.

### 카테고리 하나만 조사하기

먼저 선택할 수 있는 18개 카테고리 이름을 확인합니다. 이 명령은 Claude에 접속하지
않습니다.

```powershell
.\run-monitoring.cmd --list-categories
```

목록에 표시된 ID 하나를 복사해 실행합니다. 예를 들어 관세의 북미만 조사하려면 다음과
같이 입력합니다.

```powershell
.\run-monitoring.cmd --category "customs:북미"
```

다른 예시는 다음과 같습니다.

```powershell
.\run-monitoring.cmd --category "export:미국"
.\run-monitoring.cmd --category "trade:반덤핑"
```

단일 실행은 사전 버전 확인을 제외하고 선택한 카테고리에 대해서만 Claude 조사 호출을
1회 수행하며, 공식기관 검색 3회와 일반 동향 검색 3회를 모두 확인합니다. 결과는 기본적으로
`cli\output\monitoring-category.html`에 저장되므로 전체 결과인 `monitoring.html`을
덮어쓰지 않습니다. 조사 기간을 함께 지정할 수도 있습니다.

```powershell
.\run-monitoring.cmd --category "customs:북미" --lookback 72
```

단일 결과를 원하는 위치에 저장하려면 `--out`을 사용합니다.

```powershell
.\run-monitoring.cmd --category "customs:북미" --out "C:\Users\jinh.song\Documents\북미관세.html"
```

브라우저를 자동으로 열지 않으려면 다음을 사용합니다.

```powershell
node .\cli\run.mjs --no-open
```

최근 3일 또는 7일을 조사하려면 다음과 같이 실행합니다.

```powershell
node .\cli\run.mjs --lookback 72 --open
node .\cli\run.mjs --lookback 168 --open
```

다른 위치에 저장하려면 전체 파일 경로를 지정합니다.

```powershell
node .\cli\run.mjs --out "C:\Users\jinh.song\Documents\통상동향.html" --open
```

`--lookback`은 `24`, `72`, `168` 중 하나만 허용합니다. 월요일 기본 실행은 주말을
포함해 72시간, 나머지 요일은 24시간입니다.

## 실제 조사 전에 연결만 짧게 확인하기

회사 PC에서 실제 인증과 WebSearch 사용 가능 여부는 이 저장소의 자동 테스트로 대신할
수 없습니다. 처음 한 번만 아래 명령을 실행해 보세요.

```powershell
claude --safe-mode --no-chrome --disable-slash-commands --strict-mcp-config --disallowedTools "mcp__*" --tools "WebSearch" --allowedTools "WebSearch" --permission-mode dontAsk --no-session-persistence -p "WebSearch를 한 번 사용해 Claude Code 공식 문서의 제목과 공개 HTTPS URL 하나만 알려줘."
```

정상 답변과 URL이 나오면 연결이 준비된 것입니다. 오류가 나오면 아래 오류 안내를 먼저
확인하세요. 회사 관리 정책이 WebSearch를 금지하면 이 프로그램이 우회하지 않습니다.

## 테스트 데이터로 HTML만 확인하기

Claude Code에 접속하지 않고 화면과 저장 기능만 확인할 수 있습니다.

```powershell
node .\cli\run.mjs --mock .\cli\test\fixtures\responses.json --open
```

결과는 `cli\output\mock-monitoring.html`에 저장되고, 문서 상단에 테스트 데이터라고
표시됩니다. 실제 동향 자료로 사용하면 안 됩니다.

## 선택 설정

필요할 때만 `cli\.env.example`을 `cli\.env`로 복사해 수정합니다.

```powershell
Copy-Item .\cli\.env.example .\cli\.env
notepad .\cli\.env
```

주요 설정은 다음과 같습니다.

```dotenv
CLAUDE_CLI_BIN=claude
CLAUDE_CLI_PREFLIGHT_TIMEOUT_MS=60000
CLAUDE_CLI_TIMEOUT_MS=600000
CLAUDE_CLI_RETRY_MAX=2
CLAUDE_RUN_TIMEOUT_MS=5400000
LOCAL_OUTPUT_FILE=
```

회사 전용 실행 파일이 PATH에 없으면 절대경로를 적습니다.

```dotenv
CLAUDE_CLI_BIN=C:\Program Files\Company Claude\claude.exe
```

특정 모델을 회사에서 지정하라고 안내받은 경우에만 다음 줄을 추가합니다.

```dotenv
CLAUDE_CLI_MODEL=sonnet
```

인증 토큰, API 키, 프록시 비밀번호를 `cli\.env`에 넣지 마세요. 실행기는 허용된 로컬
설정 이름 외의 줄을 무시합니다. 회사 인증과 네트워크 설정은 IT가 구성한 운영체제 환경을
그대로 사용합니다.

## 안전하게 제한하는 방식

실제 조사 호출은 비어 있는 임시 폴더에서 다음 경계를 동시에 적용합니다.

- `--safe-mode`: 사용자·프로젝트의 지침, skills, plugins, hooks, MCP, auto-memory를
  로드하지 않습니다. 인증, 모델 선택, 회사 관리 정책은 유지됩니다.
- `--tools WebSearch`: Claude에게 보이는 일반 도구를 WebSearch로 제한합니다.
- `--allowedTools WebSearch`와 `--permission-mode dontAsk`: WebSearch만 자동 승인합니다.
  회사 보안 정책이 권한 모드를 `default`로 강제해도 실제 노출 도구가 WebSearch뿐이고
  권한 거부가 없는 경우에는 같은 검색 전용 경계로 실행합니다.
- `--strict-mcp-config`와 `--disallowedTools "mcp__*"`: MCP 도구를 이중으로 차단합니다.
- `--no-session-persistence`: 조사 대화와 prompt history를 저장하지 않습니다.
- `--no-chrome`: Chrome 연동을 사용하지 않습니다.
- `stream-json`: 실제 `WebSearch` 호출과 대응하는 성공 결과를 ID와 검색어로 확인합니다.
- 카테고리마다 서로 다른 검색어 6개, 해당 카테고리의 신뢰 목록 안에서만
  `allowed_domains`를 사용한 공식기관 검색 3회, 도메인 제한이 없는 일반 동향 검색 3회를
  확인한 결과만 채택합니다. 목록 밖 도메인을 공식 검색으로 사용하면 결과를 폐기합니다.
- 필수 6회가 모두 성공한 뒤 시도한 추가 검색만 실패한 경우에는 실패를 경고로 남기고
  검증된 결과는 보존합니다.

`--allowedTools`가 지정 도구를 사전 승인하고 권한 규칙이 권한 모드 위에 함께 적용되는
방식은 [Claude Code 공식 권한 문서](https://code.claude.com/docs/en/permissions)에서
확인할 수 있습니다. `allowed_domains` 입력 형식은
[WebSearch 도구 문서](https://code.claude.com/docs/en/tools-reference)를 따릅니다.

`Read`, `Write`, `Bash`, `PowerShell`, `WebFetch`, `Agent`, MCP 등 다른 도구가 실제
출력에서 감지되면 결과를 저장하지 않습니다. 회사 정책으로 설치된 managed hook은
Claude Code의 `--safe-mode`보다 우선할 수 있어 일반 사용자가 사전에 우회할 수 없습니다.
hook 이벤트가 감지되면 프로그램은 결과를 폐기하며, 관리 hook 자체를 없애야 한다면 IT
담당자의 정책 변경이 필요합니다.

## HTML 결과 읽기

전체 실행의 모니터링 범위는 18개 카테고리입니다. `--group` 실행의 HTML에는 선택한
영역의 9개·6개·3개 카테고리만 표시되고, `--category` 실행의 HTML에는 선택한 카테고리
하나만 표시됩니다.

- 관세 9개 지역
- 수출통제 6개 국가·다자 범위
- 무역구제 3개 조치 유형

HTML은 다음 상태를 구분합니다.

- `검색 6회 · 0건`: 공식기관·일반 동향 검색은 성공했지만 기간과 기준을 충족한 신규
  동향이 없음
- `확인 불가`: 조사 호출, 검색 또는 응답 검증 실패
- `검색 상태 정보 없음`: 검색 성공 증거를 확인할 수 없음

모든 항목은 AI 예비 조사입니다. 링크, 발표일, 적용 대상, 수치와 실제 시행 여부를 원문에서
다시 확인한 뒤 업무에 사용하세요.

## 오류 해결

### `CLI_NOT_FOUND`

```powershell
where.exe claude
Get-Command claude -All
```

아무 경로도 나오지 않으면 회사 승인 경로로 Claude Code를 설치하세요. 경로가 있다면
`CLAUDE_CLI_BIN`에 `.exe` 또는 `.cmd`의 절대경로를 지정할 수 있습니다. `.ps1`은 자동
실행 대상으로 사용하지 않습니다.

### `CLI_VERSION`

Claude Code가 `2.1.214`보다 낮거나 필수 보안 인수를 지원하지 않습니다.

```powershell
claude --version
```

회사 승인 채널에서 업데이트를 요청하세요. `claude --help`에 모든 인수가 표시되는 것은
아니므로 help 출력만으로 지원 여부를 판정하지 않습니다.

### `CLI_STARTUP_TIMEOUT`

버전 확인이 기본 60초 안에 끝나지 않았습니다. 직접 시간을 재봅니다.

```powershell
Measure-Command { claude --version | Out-Null }
```

회사 보안 검사가 느리지만 명령이 정상 종료된다면 임시로 120초까지 늘릴 수 있습니다.

```powershell
$env:CLAUDE_CLI_PREFLIGHT_TIMEOUT_MS = "120000"
.\run-monitoring.cmd
```

최대 5분까지 허용됩니다. 직접 실행도 끝나지 않으면 Claude Code 창과 남은 프로세스를
정리한 뒤 IT 담당자에게 문의하세요.

### `AUTH`

```powershell
claude auth status --text
```

회사 SSO 로그인 만료, 회사 게이트웨이, 프록시 또는 클라우드 공급자 자격 증명을
확인하세요. 저장소에 API 키를 추가하는 방식으로 우회하지 마세요.

### `WEB_SEARCH_UNAVAILABLE`, `POLICY`, `SECURITY_POLICY`

회사 관리 정책이나 사용 중인 공급자가 WebSearch를 제공하지 않거나 검색 전용 경계가
지켜지지 않았습니다. Amazon Bedrock의 서버측 WebSearch와 Azure 호스팅 Foundry의
WebSearch는 Claude Code 공식 지원 범위가 아닐 수 있으므로 IT 담당자에게 현재 공급자와
정책을 확인하세요.

상세 메시지에 `permission mode forced to default`와
`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`이 함께 표시되면 먼저 이 브랜치의 최신 코드를
받으세요. 실행기는 이 변수를 자체적으로 켜지 않으며, 회사가 설정한 값은 그대로
존중합니다.

```powershell
git pull --ff-only
Get-ChildItem Env:CLAUDE_CODE_SUBPROCESS_ENV_SCRUB -ErrorAction SilentlyContinue
```

업데이트 후에도 두 번째 명령이 `1`을 표시한다면 회사 정책에서 설정한 값입니다.
`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0`으로 우회하지 마세요. 최신 실행기는 권한 모드가
`default`로 낮아져도 `--allowedTools WebSearch`, 실제 노출 도구, 권한 거부, 도구 이벤트를
모두 확인해 검색 전용 경계가 유지되면 실행합니다. 여전히 실패하면 상세 메시지에 표시된
도구, hook, MCP 또는 권한 거부 내용을 IT 담당자에게 전달하세요.

### `TIMEOUT` 또는 `TURN_LIMIT`

조사 호출 한 번은 기본 10분, 전체 실행은 108회 심층 검색을 고려해 기본 90분으로
제한됩니다. `TIMEOUT`은 같은 카테고리를 반복 실행하지 않습니다. 회사 네트워크가
정상인데 응답만 느린 경우에 한해
다음처럼 늘릴 수 있습니다.

```powershell
$env:CLAUDE_CLI_TIMEOUT_MS = "900000"
$env:CLAUDE_RUN_TIMEOUT_MS = "7200000"
.\run-monitoring.cmd
```

한 카테고리만 확인하려면 전체 제한 시간을 늘리기 전에 `--category` 실행으로 연결과 검색
성능을 먼저 확인하는 편이 좋습니다.

### `PROCESS_CLEANUP`

시간초과나 중단 뒤 Windows가 Claude 프로세스 트리 종료를 확인하지 못했습니다. 이 상태로
새 조사 프로세스를 계속 만들지 않고 즉시 전체 실행을 중단합니다. 작업 관리자에서 이번
실행과 연결된 Claude 프로세스가 남아 있는지 확인하고, 회사 정책이 `taskkill /T /F`를
차단하는 경우 IT 담당자에게 문의하세요.

### `ALREADY_RUNNING`

같은 HTML 파일을 대상으로 이미 실행 중인 모니터링이 있습니다. 기존 PowerShell 창의
실행이 끝나거나 중단 정리가 완료될 때까지 기다리세요. 잠금 파일을 수동 삭제하지 마세요.

### `BAD_OUTPUT`, `SEARCH_NOT_RUN`, `SEARCH_INCOMPLETE`, `SEARCH_FAILED`

Claude 응답 스트림이 손상됐거나 해당 카테고리의 신뢰 공식 도메인 검색과 일반 동향
검색을 서로 다른 검색어로 모두 확인하지 못했습니다. 신뢰 목록 밖 도메인, 잘못된 hostname,
검색 실패도 거부합니다. 불완전한 내용을 정상 결과로 저장하지 않기 위한 오류입니다. 회사
연결 확인 명령을 다시 실행하고, 반복되면 오류 코드와 상세 메시지를 IT 담당자에게
전달하세요.

상세에 `Whitehouse.gov`가 표시되는 북미 관세 오류는 예전 코드의 신뢰 목록 누락입니다.
이 브랜치의 최신 버전은 백악관과 미국 관세·통상 관련 공식기관 도메인을 허용하므로,
저장소 폴더에서 다음 명령으로 업데이트한 뒤 북미만 다시 실행하세요.

```powershell
git pull --ff-only origin agent/claude-cli-category-deep-scan
.\run-monitoring.cmd --category "customs:북미"
```

## 개발자 테스트

저장소 루트에서 실행합니다.

```powershell
node --check .\cli\run.mjs
npm --prefix .\cli test
node .\cli\run.mjs --mock .\cli\test\fixtures\responses.json --out .\cli\output\mock-monitoring.html --no-open
```

테스트는 Windows의 가짜 `claude.cmd`를 실제 자식 프로세스로 실행해 버전, 고정 보안
인수, stdin, stream-json, 카테고리별 6회 다각도 WebSearch 증거, 18개 순차 조사, 그룹별 조사,
단일 카테고리 조사, timeout·중단·프로세스 정리와 HTML 저장을 검증합니다. 실제 회사 인증과 회사
WebSearch 연결은 회사 PC의 짧은 연결 확인을 별도로 통과해야 합니다.
