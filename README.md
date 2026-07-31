# Gemini CLI 글로벌 통상 모니터링

회사 계정으로 로그인된 Gemini CLI가 관세·수출통제·무역구제 동향을 조사하고,
결과를 PC의 자체 포함 HTML 파일 하나로 저장하는 수동 실행 도구입니다.

## 이 버전이 하는 일

- Gemini CLI 내장 Google 웹 검색으로 최신 동향 조사
- 관세 9개, 수출통제 5개, 무역구제 3개 카테고리 정리
- 중요 동향, 기업 영향, 발표일, 기관, 원문 링크를 한 화면에 표시
- PC 로컬의 `cli/output/monitoring.html` 한 파일만 생성

다음 기능은 사용하지 않습니다.

- 메일 및 SMTP 발송
- 예약·시간 트리거
- Google Drive, Apps Script, Sheets
- Obsidian 저장
- 별도 Gemini API 키

## 최초 한 번만 준비하기

### 1. 필요한 프로그램 확인

PowerShell을 열고 입력합니다.

```powershell
node --version
gemini --version
```

- Node.js는 20 이상이어야 합니다.
- Gemini CLI는 회사에서 승인한 설치 방법을 사용합니다.

### 2. 저장소 준비하기

이 PC에 `newletterintegration` 폴더가 아직 없을 때만 복제합니다.

```powershell
git clone --branch agent/gemini-cli-html-only-v2 https://github.com/jinhsong/newletterintegration.git
cd newletterintegration
```

이미 이전 브랜치를 내려받아 `newletterintegration` 폴더가 있다면 다시 복제하지 말고,
그 폴더에서 새 브랜치로 전환합니다.

```powershell
cd "기존-저장경로\newletterintegration"
git fetch origin
git switch agent/gemini-cli-html-only-v2
git pull
```

### 3. 이 폴더에서 회사 Gemini CLI 로그인·신뢰 설정

반드시 `newletterintegration` 최상위 폴더에서 실행합니다.

```powershell
gemini
```

처음 실행하면 `Sign in with Google`을 선택하고 회사 계정으로 로그인합니다. 이 폴더를
신뢰할지 묻는 화면이 나오면 저장소 내용을 확인한 뒤 신뢰를 승인합니다. Gemini 입력창
`>`에서 다음 문장으로 웹 검색도 확인합니다.

```text
Google 웹 검색을 사용해서 오늘 날짜를 출처 URL과 함께 알려줘
```

답변이 나오면 다음 명령으로 Gemini를 종료합니다.

```text
/quit
```

> 회사 계정에서 Google Cloud 프로젝트를 요구하면 사내 Gemini 관리자에게
> Gemini Code Assist에 연결된 **프로젝트 ID**를 확인해야 합니다.

프로젝트 ID 설정이 필요한 회사만 다음 파일을 만듭니다.

```powershell
Copy-Item .\cli\.env.example .\cli\.env
notepad .\cli\.env
```

열린 파일에서 아래 줄의 맨 앞 `#`을 지우고 실제 회사 프로젝트 ID로 변경한 뒤 저장합니다.

```text
GOOGLE_CLOUD_PROJECT=실제-회사-프로젝트-ID
```

## 매번 실행하는 가장 쉬운 방법

저장소 최상위 `newletterintegration` 폴더에서 다음 한 줄만 실행합니다.

```powershell
.\run-monitoring.cmd
```

파일 탐색기에서 `run-monitoring.cmd`를 더블클릭해도 됩니다. 수집이 끝나면 결과
HTML이 기본 브라우저로 자동으로 열립니다.

실행 흐름은 다음과 같습니다.

```text
[1/3] 관세 조사 시작
  ... Gemini 조사 중 (20초 경과)
[1/3] 관세 완료: 4건
[2/3] 수출통제 조사 시작
[2/3] 수출통제 완료: 2건
[3/3] 무역구제 조사 시작
[3/3] 무역구제 완료: 1건
HTML 저장 완료: ...\cli\output\monitoring.html
```

세 영역을 한 번에 하나씩 조사하므로 PowerShell 창을 닫지 마세요. 회사 네트워크와
검색량에 따라 수분에서 수십 분이 걸릴 수 있습니다.

## PowerShell에서 직접 실행하기

`cli` 폴더로 이동한 뒤 실행합니다.

```powershell
cd .\cli
node .\run.mjs --open
```

`--open`을 빼면 파일을 저장만 하고 브라우저는 열지 않습니다.

```powershell
node .\run.mjs
```

결과 파일:

```text
newletterintegration
└─ cli
   └─ output
      └─ monitoring.html
```

메일, 외부 저장, 별도 로그·JSON·Markdown·보관본은 생성하지 않습니다. 다음 실행이
정상 완료되면 같은 HTML 파일이 최신 결과로 교체됩니다.

이전 브랜치에서 만들었던 `output/latest`, `output/archive`, `summary.md`, `result.json`
등이 남아 있다면 새 버전이 만든 파일이 아니라 로컬에 보존된 과거 결과입니다. 필요한
자료인지 확인한 후 직접 이동하거나 삭제하세요. 새 버전은 해당 파일을 읽거나 갱신하지 않습니다.

## 조사 기간 변경

기본값은 평일 24시간이며 월요일은 주말을 포함해 72시간입니다.

```powershell
node .\run.mjs --lookback 24 --open
node .\run.mjs --lookback 72 --open
node .\run.mjs --lookback 168 --open
```

허용 값은 24, 72, 168시간입니다.

## 결과 저장 위치 변경

이번 실행에서만 변경:

```powershell
node .\run.mjs --out "C:\회사자료\통상동향\monitoring.html" --open
```

항상 같은 위치를 사용하려면 `cli/.env`의 값을 바꿉니다.

```text
LOCAL_OUTPUT_FILE=C:\회사자료\통상동향\monitoring.html
```

## 오류 코드별 확인 방법

### `TIMEOUT`

영역별 기본 제한 시간은 10분이며 일시적 오류는 한 번만 재시도합니다. Gemini의
간단한 응답과 웹 검색이 되는지 먼저 확인합니다.

```powershell
gemini -p "pong만 출력해줘" --output-format json
gemini -p "Google 웹 검색으로 오늘 날짜와 출처 URL 하나를 알려줘" --output-format json
```

두 명령은 성공하지만 동향 조사만 시간 초과라면 현재 PowerShell에서 제한을 15분으로
늘려 실행할 수 있습니다.

```powershell
$env:GEMINI_CLI_TIMEOUT_MS = "900000"
node .\run.mjs --open
```

### `AUTH`

```powershell
gemini
```

회사 계정으로 다시 로그인한 뒤 `/quit`으로 나와 재실행합니다.

### `PROJECT`

회사 프로젝트 ID를 `cli/.env`의 `GOOGLE_CLOUD_PROJECT`에 설정합니다. 프로젝트
이름이 아니라 프로젝트 **ID**여야 합니다.

### `POLICY` 또는 `TRUST`

먼저 `newletterintegration` 폴더에서 대화형 `gemini`를 실행해 이 폴더의 신뢰를
승인한 뒤 `/quit`으로 나옵니다. 그래도 계속되면 회사 관리 정책에서 Gemini CLI 웹
검색이나 현재 폴더 사용을 제한한 상태일 수 있으므로 사내 Gemini 관리자에게 화면의
상세 오류를 전달하세요. 저장소는 회사의 중앙 인증·보안 설정을 변경하지 않습니다.

### 실행 중 취소하기

PowerShell에서 `Ctrl+C`를 한 번 누릅니다. 실행 중인 Gemini 하위 프로세스를 정리한 뒤
종료합니다. 이 수동 실행 버전은 영구 잠금 파일을 만들지 않습니다.

## 부분 실패와 기존 결과 보호

- 세 영역 중 일부만 실패하면 성공한 내용을 HTML로 저장하고 상단에 실패 영역·코드를 표시합니다.
- 세 영역이 모두 실패하면 기존 `monitoring.html`을 덮어쓰지 않습니다.
- 모델이 제공한 링크는 공개 HTTPS 형식만 허용합니다. Node 프로그램이 뉴스 사이트에
  직접 접속해 검증하지 않으므로 사내 프록시로 인한 추가 지연을 만들지 않습니다.

## 개발 테스트

```powershell
cd .\cli
npm test
```
