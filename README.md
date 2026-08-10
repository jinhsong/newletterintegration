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
git clone --branch agent/claude-cli-full-review-improvements https://github.com/jinhsong/newletterintegration.git
cd .\newletterintegration
```

이미 저장소가 있다면 다시 clone하지 않습니다.

```powershell
cd C:\Users\jinh.song\newletterintegration
git fetch origin
git switch agent/claude-cli-full-review-improvements
git pull --ff-only origin agent/claude-cli-full-review-improvements
```

경로가 다르면 첫 번째 줄만 실제 저장 위치로 바꾸세요.

## 모니터링 실행하기

저장소 폴더에서 다음 한 줄만 입력하면 됩니다.

```powershell
.\run-monitoring.cmd
```

프로그램은 다음 순서로 동작합니다.

1. Claude Code 버전을 확인합니다.
2. 기본 `standard` 깊이로 18개 카테고리를 하나씩 조사합니다.
3. 각 카테고리의 국가·기관 등 조사 대상 수에 맞춰 공식기관 검색과 일반 동향 검색 횟수를
   자동으로 늘립니다. 법령·집행지침·품목, 주요 언론·현지어/업계·한국 공급망 관점을
   나눠 확인합니다.
4. 결과를 `cli\output\monitoring.html`에 안전하게 교체 저장합니다.
5. 저장된 HTML을 기본 브라우저로 엽니다.

메일, 예약 작업, 외부 서비스 저장은 실행하지 않습니다. 다음 실행 때는 clone이나 로그인 명령을
반복할 필요 없이 저장소 폴더에서 `.\run-monitoring.cmd`만 실행하면 됩니다.

정상 전체 실행의 Claude 조사 호출은 18회입니다. 현재 `standard` 설정은 카테고리당
6~10회의 WebSearch를 확인해 전체 114회이며, 국가·기관이 많은 카테고리는 검색 횟수와
항목 한도를 자동으로 늘립니다.
회사 네트워크와 Claude 응답 속도에 따라 시간이 걸릴 수 있으므로 실행 중에는 같은 결과를
대상으로 다른 모니터링을 시작하지 마세요.

현재 프로그램 버전만 확인하려면 다음을 실행합니다. Claude에는 접속하지 않습니다.

```powershell
.\run-monitoring.cmd --version
```

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
Claude 요청으로 합치지 않습니다. 각 카테고리의 조사 근거와 실패 여부를 분리하기 위해
그룹 안의 카테고리를 하나씩 조사합니다.

| 선택 그룹 | 카테고리 | 기본 Claude 조사 호출 | standard 최소 WebSearch | 기본 결과 파일 |
|---|---:|---:|---:|---|
| 관세 | 9개 | 9회 | 60회 | `cli\output\monitoring-customs.html` |
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
1회 수행합니다. `standard`에서는 공식기관 검색과 일반 동향 검색을 각각 최소 3회
확인하고, 조사 대상이 많으면 횟수를 자동으로 늘립니다. 결과 파일명에는 영역과
카테고리가 들어가므로 다른 단일 결과를 덮어쓰지 않습니다.

예를 들어 위 명령의 기본 결과는 다음과 같습니다.

```text
cli\output\monitoring-customs-북미.html
```

조사 기간을 직접 지정할 수도 있습니다.

```powershell
.\run-monitoring.cmd --category "customs:북미" --lookback 72
```

단일 결과를 원하는 위치에 저장하려면 `--out`을 사용합니다.

```powershell
.\run-monitoring.cmd --category "customs:북미" --out "C:\Users\jinh.song\Documents\북미관세.html"
```

브라우저를 자동으로 열지 않으려면 다음을 사용합니다.

```powershell
.\run-monitoring.cmd --no-open
```

최근 3일 또는 7일을 조사하려면 다음과 같이 실행합니다.

```powershell
.\run-monitoring.cmd --lookback 72
.\run-monitoring.cmd --lookback 168
```

다른 위치에 저장하려면 전체 파일 경로를 지정합니다.

```powershell
.\run-monitoring.cmd --out "C:\Users\jinh.song\Documents\통상동향.html"
```

`--lookback`은 `24`, `72`, `168` 중 하나만 허용하며 자동 기간 계산을 그 실행에 한해
재정의합니다. 지정하지 않으면 동일한 전체·그룹·카테고리 범위와 동일한 조사 깊이의
마지막 완전 성공 시각에서 6시간을 겹쳐 다시 조사합니다. 자동 범위는 최대 168시간입니다.
기록이 없는 첫 실행만 월요일 72시간, 나머지 요일 24시간을 사용합니다.

완전 성공 시각은 `cli\output\.trade-monitor-state\state.json`에 PC 로컬로만 기록됩니다.
부분 결과와 목 테스트는 이 시각을 갱신하지 않습니다. 다음 조사 범위가 잘못될 수 있으므로
실행 중 이 상태 파일을 직접 수정하거나 삭제하지 마세요.

### 조사 깊이 선택하기

기본값은 `standard`입니다. 실행 시간보다 범위가 중요하면 `deep`, 빠른 확인이 목적이면
`fast`를 선택합니다.

```powershell
.\run-monitoring.cmd --depth fast --category "customs:북미"
.\run-monitoring.cmd --depth standard --group "수출통제"
.\run-monitoring.cmd --depth deep --group "관세"
```

| 깊이 | 카테고리별 필수 WebSearch | 카테고리별 최대 표시 한도 | 전체 실행 기본 제한 | 용도 |
|---|---:|---:|---:|---|
| `fast` | 4회 | 최대 12건 | 60분 | 연결 확인, 빠른 일일 점검 |
| `standard` | 6~10회 | 최대 20건 | 120분 | 기본 업무 조사 |
| `deep` | 8~10회 | 최대 30건 | 240분 | 국가가 많은 범위, 주간 심층 조사 |

위 검색 횟수는 현재 18개 카테고리 설정 기준입니다. 검색 횟수와 표시 한도는 카테고리의
조사 대상 수에 따라 결정되므로 대상 목록이 바뀌면 함께 달라질 수 있습니다. `deep`은
누락 가능성을 낮추지만 실행 시간과 회사 계정 사용량이 크게 늘 수 있습니다.

`CLAUDE_RUN_TIMEOUT_MS`를 PowerShell이나 `cli\.env`에 설정하면 깊이별 기본값 대신 그
값을 모든 실행에 사용합니다. `.env.example`의 `7200000`은 `standard` 기본인 120분입니다.
깊이별 자동 제한을 사용하려면 복사한 `.env`에서 해당 줄 전체를 지우세요. 빈 값은 유효한
정수 설정이 아니므로 사용할 수 없습니다.

조사 깊이가 다르면 마지막 성공 시각도 별도로 기록합니다. 예를 들어 `standard` 그룹
실행 기록을 `deep` 실행의 자동 시작 시각으로 사용하지 않습니다.

### 부분 결과가 생겼을 때

일부 카테고리만 완료되면 기존 대표 HTML을 덮지 않고 다음처럼 시각이 붙은 별도 파일에
저장합니다.

```text
monitoring-customs.partial-20260810T012345678Z.html
```

이 경우 PowerShell에는 "부분 HTML 별도 저장 완료"가 표시되고 프로그램 종료 코드는
`2`입니다. 파일 상단에서 완료 카테고리와 실패 범위를 확인하세요. 자동화에서 종료 코드
`2`는 완전 실패인 `1`과 구분해야 합니다.

부분 결과로 대표 파일을 교체해야 한다는 판단이 명확한 경우에만 다음 옵션을 사용합니다.

```powershell
.\run-monitoring.cmd --group "관세" --allow-partial-overwrite
```

이 옵션으로 대표 파일을 교체해도 조사가 완전하지 않다는 사실은 바뀌지 않으므로 종료
코드는 계속 `2`입니다.

### 동시 실행과 네트워크 공유 경로

기본적으로 전체·그룹·단일 조사는 전역 잠금으로 동시에 실행되지 않습니다. 회사 계정의
검색 제한을 확인했고 동시 실행이 꼭 필요한 경우에만 `--allow-parallel`을 사용하세요.
각 실행의 출력 파일은 서로 달라야 합니다.

UNC 네트워크 공유 경로는 PC 로컬 저장 원칙 때문에 기본 차단됩니다. 회사 정책상 허용된
공유 폴더임을 확인한 경우에만 명시적으로 허용합니다.

```powershell
.\run-monitoring.cmd --group "관세" --out "\\server\team\관세.html" --allow-network-output
```

네트워크 공유 파일의 잠금은 PC마다 독립적입니다. 여러 PC에서 같은 HTML 경로를 동시에
실행하면 서로 덮어쓸 수 있으므로, 공유 경로 하나는 한 번에 한 PC에서만 생성하세요.

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
.\run-monitoring.cmd --mock .\cli\test\fixtures\responses.json
```

결과는 `cli\output\mock-monitoring.html`에 저장됩니다. 브라우저 탭 제목, 문서 상단과
빨간 테두리에 `MOCK · 테스트 전용`이라고 표시되므로 실제 동향 자료와 구분할 수 있습니다.
실제 업무 판단 자료로 사용하면 안 됩니다.

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
CLAUDE_CLI_MAX_TURNS=32
CLAUDE_RUN_TIMEOUT_MS=7200000
LOCAL_OUTPUT_FILE=
```

회사 전용 실행 파일이 PATH에 없으면 절대경로를 적습니다.

```dotenv
CLAUDE_CLI_BIN=C:\Program Files\Company Claude\claude.exe
```

PATH에서 이름이 같은 다른 프로그램이 실행되는 위험을 줄이려면 회사 IT가 승인한 절대경로를
고정할 수 있습니다.

```dotenv
CLAUDE_CLI_BIN=C:\Program Files\Company Claude\claude.exe
CLAUDE_CLI_REQUIRE_ABSOLUTE_BIN=1
```

IT가 승인 실행 파일의 SHA-256도 관리하는 경우에만 다음 값을 추가합니다. 현재 파일의
해시는 PowerShell에서 확인할 수 있지만, 어떤 값을 승인할지는 사용자가 아니라 IT가
결정해야 합니다. 이 기능은 실제 payload인 네이티브 `.exe` 또는 `.com`에만 사용할 수
있습니다. npm의 `.cmd`·`.bat` 래퍼 해시는 그 아래 Node/JavaScript 파일을 보장하지 못하므로
설정하면 안전상 실행을 거부합니다.

```powershell
Get-FileHash "C:\Program Files\Company Claude\claude.exe" -Algorithm SHA256
```

```dotenv
CLAUDE_CLI_ALLOWED_SHA256=IT에서_확인한_64자리_SHA256
```

Claude Code가 업데이트되면 SHA-256이 달라져 실행이 차단됩니다. 이때 검사를 끄는 대신
IT가 새 버전과 해시를 승인했는지 확인한 뒤 값을 갱신하세요.

특정 모델을 회사에서 지정하라고 안내받은 경우에만 다음 줄을 추가합니다.

```dotenv
CLAUDE_CLI_MODEL=sonnet
```

인증 토큰, API 키, 프록시 비밀번호를 `cli\.env`에 넣지 마세요. 실행기는 허용된 로컬
설정 이름 외의 줄을 무시합니다. 회사 인증과 네트워크 설정은 IT가 구성한 운영체제 환경을
그대로 사용합니다.

## 안전하게 제한하는 방식

실제 조사 호출은 비어 있는 임시 폴더에서 다음 경계를 동시에 적용합니다.

- OS 임시 폴더가 로컬 일반 폴더인지 확인하고, 각 정상 호출 전후와 다음 호출 직전에
  작업 폴더가 비어 있는지 다시 검사합니다. 예상하지 않은 파일이 생기면 결과를 폐기합니다.
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
  근거 URL은 구조화된 각 검색 결과 또는 그 바로 아래 `content` 항목의 URL만 인정하며,
  metadata·related·thumbnail 같은 임의 중첩 URL은 제외합니다. 최종 결과는 공식 스키마의
  메타데이터 필드와 직접 입력(`origin: human`)만 허용하며, 연기된 도구·백그라운드 후속
  실행 또는 알 수 없는 필드가 있으면 폐기합니다.
- 선택한 `--depth`와 카테고리 조사 대상 수에 맞춘 서로 다른 검색어를 요구합니다.
  해당 카테고리의 신뢰 목록 안에서만 `allowed_domains`를 사용한 공식기관 검색과 도메인
  제한이 없는 일반 동향 검색이 각각 정책상 최소 횟수를 충족한 결과만 채택합니다. 목록 밖
  도메인을 공식 검색으로 사용하면 결과를 폐기합니다.
- 해당 카테고리의 필수 검색이 모두 성공한 뒤 시도한 추가 검색만 실패한 경우에는 경고를 남기고
  검증된 결과는 보존합니다.
- 알려진 init·assistant·user·WebSearch 진행·result 이벤트와 허용 content block 외의 새
  이벤트 형식이 나타나면 조용히 무시하지 않고 보안 오류로 중단합니다.

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

- `검색 N회 · 0건`: 선택한 깊이가 요구한 공식기관·일반 동향 검색은 성공했지만 신규
  동향이 없음
- `확인 불가`: 조사 호출, 검색 또는 응답 검증 실패
- `검색 상태 정보 없음`: 검색 성공 증거를 확인할 수 없음

상단에는 완료 카테고리 수, 완전 완료 영역 수와 함께 다음 검증 처리 건수를 표시합니다.

- `검증 제외`: 필수 필드·날짜·출처 근거 검증을 통과하지 못한 원시 항목
- `표시 한도 제외`: 조사에는 포함됐지만 선택한 깊이의 카테고리 표시 한도를 넘은 항목
- `중복 제거`: 같은 사건으로 판정되어 대표 항목 하나로 합쳐진 항목

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

조사 호출 한 번은 기본 10분입니다. 전체 실행 제한은 `fast` 60분, `standard` 120분,
`deep` 240분을 자동 적용합니다. `TIMEOUT`은 시간
제한이고 `TURN_LIMIT`은 한 호출에서 허용한 Claude 진행 단계 수를 모두 사용했다는
의미이므로 서로 다른 설정을 사용합니다. 회사 네트워크가 정상인데 응답만 느린 경우에만
시간 제한을 늘립니다.

```powershell
$env:CLAUDE_CLI_TIMEOUT_MS = "900000"
$env:CLAUDE_RUN_TIMEOUT_MS = "14400000"
.\run-monitoring.cmd
```

`TURN_LIMIT`이 반복되며 상세 로그에서 WebSearch가 정상적으로 진행된 경우에만 turn 수를
기본 32에서 늘립니다. 허용 범위는 1~50입니다.

```powershell
$env:CLAUDE_CLI_MAX_TURNS = "40"
.\run-monitoring.cmd --category "customs:북미"
```

`TURN_LIMIT`에 `CLAUDE_CLI_TIMEOUT_MS`만 늘려도 해결되지 않습니다. `deep`은 검색 횟수가
많아 turn도 더 사용할 수 있으므로 먼저 단일 카테고리에서 확인하세요.

한 카테고리만 확인하려면 전체 제한 시간을 늘리기 전에 `--category` 실행으로 연결과 검색
성능을 먼저 확인하는 편이 좋습니다.

### `PROCESS_CLEANUP`

시간초과나 중단 뒤 Windows가 Claude 프로세스 트리 종료를 확인하지 못했습니다. 이 상태로
새 조사 프로세스를 계속 만들지 않고 즉시 전체 실행을 중단합니다. 작업 관리자에서 이번
실행과 연결된 Claude 프로세스가 남아 있는지 확인하고, 회사 정책이 `taskkill /T /F`를
차단하는 경우 IT 담당자에게 문의하세요. 실행기는 `taskkill`이 제한되면 기다림을 짧게
끝내고 직접 소유한 루트 프로세스 종료도 시도하지만, 네이티브 `.exe`와 `.cmd`·`.bat`
래퍼 모두 하위 프로세스 트리 종료까지 증명할 수는 없습니다. 따라서 결과를 성공으로
간주하지 않고 `PROCESS_CLEANUP`으로 중단합니다.

현재 어떤 실행 파일을 쓰는지 확인하려면 다음을 실행합니다.

```powershell
where.exe claude
Get-Command claude -All
```

`.cmd`만 나오고 같은 오류가 반복되면 파일 확장자만 바꾸지 말고, 회사 승인 네이티브
`claude.exe` 설치 경로나 프로세스 트리 종료 정책을 IT 담당자에게 요청하세요.

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
git pull --ff-only origin agent/claude-cli-full-review-improvements
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
인수, stdin, stream-json, 깊이·대상 수에 따라 달라지는 다각도 WebSearch 증거, 18개 조사,
그룹별 조사, 단일 카테고리 조사, timeout·중단·프로세스 정리와 HTML 저장을 검증합니다.
GitHub Actions도 Windows에서 Node 20·22·24의 테스트와 목 HTML 생성을 확인합니다. 실제
회사 인증과 회사 WebSearch 연결은 회사 PC의 짧은 연결 확인을 별도로 통과해야 합니다.
