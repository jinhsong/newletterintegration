# Gemini CLI 글로벌 통상 모니터링

회사 계정으로 로그인된 Gemini CLI가 관세·수출통제·무역구제 동향을 조사하고,
결과를 Windows PC의 자체 포함 HTML 파일 하나로 저장하는 수동 실행 도구입니다.

이 저장소는 메일·SMTP 발송, 예약 트리거, Google Drive·Apps Script·Sheets,
Obsidian, 별도 Gemini API 키를 사용하지 않습니다.

## 결과물과 한계

- 기본 결과: `cli/output/monitoring.html`
- 관세 9개, 수출통제 6개, 무역구제 3개(총 18개) 카테고리를 조사합니다.
- 관세 지역 분류에는 `동남아/오세아니아`와 `동아시아`(중국·한국·일본·대만·홍콩),
  수출통제에는 `영국/캐나다/호주/인도` 카테고리가 포함됩니다.
- 결과는 **AI 예비 조사 자료**입니다. 링크, 발표일, 적용 대상, 수치를 원문에서
  직접 확인한 뒤 업무 판단에 사용하세요.
- 링크는 공개 HTTPS 형식만 표시하지만, 프로그램이 대상 페이지의 존재나 내용을
  별도로 검증하지는 않습니다.
- 동시 실행 잠금은 같은 Windows PC 안에서만 조정됩니다. 여러 PC가 하나의 네트워크
  공유 HTML을 동시에 갱신하는 용도로 사용하지 말고 PC별 로컬 파일을 사용하세요.

## 최초 한 번만 준비하기

### 1. Node.js와 Gemini CLI 확인

PowerShell을 열고 다음을 입력합니다.

```powershell
node --version
gemini --version
```

- Node.js 20 이상이 필요합니다.
- Gemini CLI는 회사에서 승인한 설치 방법을 사용하세요.
- `gemini`가 아닌 사용자 지정 경로를 쓴다면 아래처럼 `cli/.env`에 설정할 수
  있으며, 실행기는 더 이상 `where gemini`를 강제하지 않습니다.
- Gemini 실행 파일이 PATH에 없다면 위의 두 번째 명령 대신 실제 경로로 확인합니다.

```powershell
& "C:\Program Files\Company Gemini\gemini.cmd" --version
```

### 2. 저장소 받기

이 PC에 `newletterintegration` 폴더가 없을 때만 실행합니다.

```powershell
git clone --branch agent/gemini-cli-html-only-v3 https://github.com/jinhsong/newletterintegration.git
Set-Location .\newletterintegration
```

이미 폴더가 있다면 다시 복제하지 말고 해당 폴더로 이동합니다.

```powershell
Set-Location "C:\기존-저장경로\newletterintegration"
git fetch origin
git switch agent/gemini-cli-html-only-v3
git pull --ff-only
```

이후 문서의 모든 실행 명령은 `newletterintegration` 최상위 폴더에서 입력합니다.

### 3. 회사 Gemini CLI 로그인·웹 검색 확인

임의의 PowerShell 폴더에서 다음을 실행합니다.

```powershell
gemini
```

PATH에 없는 회사 전용 실행 파일이라면 대신 다음처럼 실행합니다.

```powershell
& "C:\Program Files\Company Gemini\gemini.cmd"
```

처음 실행하면 `Sign in with Google`을 선택하고 회사 계정으로 로그인합니다. Gemini
입력창 `>`에 다음을 넣어 사내 계정의 웹 검색 사용 가능 여부를 확인합니다.

```text
Google 웹 검색을 사용해서 오늘 날짜를 출처 URL과 함께 알려줘
```

답변이 나오면 다음으로 종료합니다.

```text
/quit
```

> 실제 모니터링은 매번 검색 전용 보안 설정만 둔 별도의 임시 폴더에서
> `--skip-trust`로 실행되므로,
> 저장소 폴더를 Gemini에 신뢰 승인할 필요가 없습니다. 임시 폴더는 실행 후 자동으로
> 삭제됩니다.

회사 계정에서 Google Cloud 프로젝트를 요구하면 사내 Gemini 관리자에게 Gemini
Code Assist에 연결된 **프로젝트 ID**를 문의하세요. 필요한 회사만 설정 파일을
만듭니다.

```powershell
Copy-Item .\cli\.env.example .\cli\.env
notepad .\cli\.env
```

열린 파일에서 해당 줄의 `#`을 지우고 실제 값을 넣습니다.

```text
GOOGLE_CLOUD_PROJECT=실제-회사-프로젝트-ID
```

Gemini 실행 파일이 PATH에 없을 때는 다음과 같이 절대경로를 설정합니다.

```text
GEMINI_CLI_BIN=C:\Program Files\Company Gemini\gemini.cmd
```

## 매번 실행하는 방법

PowerShell을 열고 `newletterintegration` 최상위 폴더로 이동한 뒤 **한 줄만**
실행합니다.

```powershell
.\run-monitoring.cmd
```

파일 탐색기에서 `run-monitoring.cmd`를 더블클릭해도 됩니다. 수집이 끝나면
`cli/output/monitoring.html`이 새로 저장되고 기본 브라우저로 열립니다. 실행 중에는
PowerShell 창을 닫지 마세요. 회사 네트워크와 검색량에 따라 수분에서 수십 분이
걸릴 수 있습니다. 연속 시간초과로 무한정 기다리지 않도록 실제 조사는 기본 45분에
중단되며, 그때까지 완료된 영역이 있으면 나머지를 `확인 불가`로 표시한 부분 HTML을
저장합니다.

다음 실행이 완료되면 같은 HTML 파일을 최신 결과로 교체합니다. 세 영역이 모두
실패하면 기존 HTML을 보존합니다.

### 조사 기간 바꾸기

기본은 평일 24시간이며, 월요일은 주말을 포함해 72시간입니다.

```powershell
.\run-monitoring.cmd --lookback 24
.\run-monitoring.cmd --lookback 72
.\run-monitoring.cmd --lookback 168
```

허용 값은 24, 72, 168시간입니다.

### 저장 위치 바꾸기

이번 실행에서만 변경합니다.

```powershell
.\run-monitoring.cmd --out "C:\회사자료\통상동향\monitoring.html"
```

항상 같은 위치를 사용하려면 `cli/.env`에 설정합니다.

```text
LOCAL_OUTPUT_FILE=C:\회사자료\통상동향\monitoring.html
```

### 저장만 하고 브라우저는 열지 않기

```powershell
.\run-monitoring.cmd --no-open
```

### 도움말과 목 응답 테스트

Gemini를 호출하지 않고 실행 인자를 확인할 때:

```powershell
.\run-monitoring.cmd --help
```

내장된 테스트 응답으로 HTML 생성만 확인할 때:

```powershell
.\run-monitoring.cmd --mock .\cli\test\fixtures\responses.json --out .\cli\output\mock-monitoring.html --no-open
```

`--help`와 `--mock`는 Gemini CLI가 없어도 실행됩니다. `--mock`에서 `--out`을
생략해도 실사용 파일이 아닌 `cli/output/mock-monitoring.html`에 저장되며, HTML
상단에 **테스트 데이터**라고 표시됩니다.

## 자동 사전 점검과 보안 제한

실제 조사를 시작하기 전에 프로그램이 회사 Gemini CLI를 한 번 자동 점검합니다.
다음 최소 기능이 없는 구버전 CLI는 조사를 시작하지 않습니다.

- JSON headless 출력과 웹 검색 통계
- 도구 허용·차단 정책 파일
- 확장·MCP 서버 비활성화
- 신뢰 프롬프트 건너뛰기

실행기는 임시 작업 폴더의 설정에서 내장 도구를 `google_web_search` 하나로
allowlist하고 hooks·skills·사용자 정의 도구를 끕니다. 여기에
`cli/policies/research-only.toml` 정책을 함께 적용하고 확장과 MCP 서버도
비활성화합니다. 도구 통계에 다른 도구가 나타나면 `SECURITY_POLICY`로 중단하고
결과를 폐기합니다.

회사 관리자가 배포한 시스템 설정과 Admin 정책은 Gemini CLI 설계상 로컬 설정보다
우선합니다. 회사 정책이 추가 도구를 강제하는 환경에서는 이 실행기가 해당 정책을
우회하지 않으며, 검색 전용 실행을 허용할지 사내 Gemini 관리자에게 확인해야 합니다.
`cli/.env`에서는 이 실행기에 필요한 설정 이름만 허용하므로, 저장소 파일로 Gemini의
시스템 설정 경로나 중앙 관리 정책을 바꿀 수 없습니다.

보안 정책 파일은 수정하지 마세요. 정책 무결성 점검에 실패하면 조사를 시작하지
않습니다.

## HTML에 표시되는 상태

- **검색 실행 완료**: 요청 카테고리 수 이상의 Google 웹 검색 성공 기록이 있는
  결과입니다. 큰 단위에서 이 조건을 충족하지 못하면 카테고리별로 다시 조사합니다.
- **검색 실행 · 0건**: 검색은 실행했지만 조사 기간과 포함 기준을 충족한
  항목이 없었습니다.
- **재조사 결과**: 큰 단위 조사가 실패해 해당 카테고리를 하나씩 다시 조사한
  결과입니다.
- **확인 불가**: 시간초과, 정책, 인증, JSON 형식 등의 문제로 조사하지 못했습니다.
  `0건`을 의미하지 않습니다.
- **상태 정보 없음**: 새 상태 필드가 없는 구버전 결과입니다. 검색 완료로 간주하지
  않습니다.

각 원문 링크에는 출처명과 실제 hostname을 함께 표시합니다. `HTTPS 형식 확인`은
URL 문자열의 형식만 통과했다는 뜻이며 페이지 존재, 발표 기관, 내용의 정확성을 검증했다는
뜻이 아닙니다. `검색 근거와 연결`이라고 표시되어도 업무 사용 전에 원문을 열어
수동으로 확인하세요.

## 오류 코드별 확인 방법

### `CLI_VERSION`

회사 Gemini CLI가 위의 보안 플래그를 지원하지 않는 구버전입니다. 최소 0.40.0이
필요하며, 회사 승인 소프트웨어 채널에서 Gemini CLI 업데이트를 요청하세요. 프로그램이 보안 제한을
빼고 계속 실행하지는 않습니다.

### `SECURITY_POLICY`

보안 정책 파일이 변경되었거나 금지된 도구 사용이 관찰됐습니다. 저장소의 임의
정책 수정을 되돌리고 다시 실행하세요. 계속되면 화면의 상세 오류를 사내 Gemini
관리자에게 전달하세요.

### `TIMEOUT` 또는 `TURN_LIMIT`

영역 또는 카테고리 재조사의 제한을 넘었습니다. 프로그램이 재조사를 시도한 후에도
실패한 카테고리는 HTML에 `확인 불가`로 표시됩니다. 시간을 15분으로 늘려
다시 실행하려면:

```powershell
$env:GEMINI_CLI_TIMEOUT_MS = "900000"
$env:GEMINI_RUN_TIMEOUT_MS = "3600000"
.\run-monitoring.cmd
```

첫 줄은 Gemini 호출 1회 제한을 15분, 둘째 줄은 전체 실행 제한을 60분으로
늘립니다. PowerShell 창을 닫으면 설정은 사라집니다.

### `RUN_TIMEOUT`

기본 전체 실행 제한 45분에 도달했습니다. 이미 완료된 영역이 있으면 부분 HTML을
저장하고, 하나도 완료하지 못했다면 기존 HTML을 보존합니다. 회사 네트워크가 느린
경우 위 예시처럼 `GEMINI_RUN_TIMEOUT_MS`를 늘릴 수 있습니다.

### `PARTIAL_COVERAGE`

큰 단위 조사와 카테고리별 재조사 후에도 일부 카테고리를 완료하지
못했습니다. HTML에서 `확인 불가`로 표시된 카테고리와 사유를 확인하고, 네트워크
상태가 좋을 때 재실행하세요. 나머지 카테고리 결과는 HTML에 보존됩니다.

### `AUTH`

```powershell
gemini
```

PATH에 없는 전용 실행 파일은 최초 로그인 때와 동일하게
`& "실제경로\gemini.cmd"`로 실행합니다.

회사 계정으로 다시 로그인한 뒤 `/quit`으로 나와 `run-monitoring.cmd`를 재실행합니다.

### `PROJECT`

프로젝트 이름이 아닌 프로젝트 **ID**를 `cli/.env`의 `GOOGLE_CLOUD_PROJECT`에 설정합니다.

### `POLICY` 또는 `TRUST`

실행기는 검색 전용 보안 설정만 둔 임시 폴더와 `--skip-trust`를 사용하므로 저장소 신뢰 승인은 필요하지
않습니다. 오류가 계속되면 회사 관리 정책이 Gemini CLI 웹 검색, 정책 파일,
또는 필수 플래그를 차단하는지 사내 관리자에게 문의하세요.

### `ALREADY_RUNNING` 또는 다른 모니터링이 실행 중이라고 나올 때

PowerShell 창과 작업 관리자에서 이미 실행 중인 모니터링이 있는지 확인하고 먼저
끝날 때까지 기다립니다. 강제로 잠금 파일을 지우지 마세요. 이전 프로세스가
비정상 종료되면 Windows가 실제 실행 잠금을 자동으로 해제하며, 다음 실행이 남은
진단 정보를 교체합니다. 계속 나오면 PowerShell에 표시된 시작 시각을 확인한 뒤
해당 내용을 전달하세요.

### 실행 중 취소하기

PowerShell에서 `Ctrl+C`를 한 번 누릅니다. 재시도 대기 중이어도 즉시 취소하고,
실행 중인 Gemini 하위 프로세스와 임시 작업 폴더를 정리한 뒤 종료합니다.
회사 보안 정책이 Windows `taskkill`을 막으면 `프로세스 트리 종료 경고` 또는
`액세스가 거부되었습니다`가 나타날 수 있습니다. 이때는 작업 관리자에서 남은
Gemini 프로세스를 종료하고, 반복되면 사내 IT 관리자에게 `taskkill /T` 허용 여부를
문의하세요.

## 개발 테스트

저장소 최상위 폴더에서:

```powershell
npm --prefix .\cli test
```

실제 Gemini CLI를 호출하지 않고 mock으로 종료·HTML 안전성·출력 교체·실패 보호를
검증합니다.
