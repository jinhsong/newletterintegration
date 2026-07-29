# 글로벌 통상 모니터링 — 사내 Gemini CLI 로컬판

관세·수출통제·무역구제 17개 분야를 사내 Gemini Code Assist Enterprise 계정으로
조사하고, PC에서 HTML 뉴스레터를 만든 뒤 회사 SMTP 릴레이로 자동 발송합니다.

## 데이터 흐름

```text
회사 Gemini CLI OAuth
  → PC에서 뉴스 수집·중복 제거·HTML 생성
  → 회사 SMTP 릴레이로 자동 발송
  → PC 로컬 폴더에 결과·이력·발송 상태 저장
```

- Gemini API 키 없음
- Google Drive 없음
- Google Apps Script 없음
- 외부 데이터베이스 없음
- 실제 수신자, SMTP 비밀번호, 실행 결과는 Git에 커밋되지 않음

루트의 `.gs` 파일은 기존 프롬프트·정규화·HTML 디자인의 단일 기준으로 로컬
Node.js 실행기가 읽어 사용합니다. Apps Script 프로젝트에 올릴 필요는 없습니다.

## 1. 회사 메일 관리자에게 받을 정보

다음 문구를 그대로 전달해도 됩니다.

> 회사 PC에서 정기 뉴스레터를 자동 발송하려고 합니다. 사내 SMTP 릴레이의
> 호스트명, 포트, TLS 방식(STARTTLS/직접 TLS/없음), 인증 방식
> (IP 릴레이/LOGIN/PLAIN), 허용된 발신 주소, 1회 최대 수신자 수를 알려주세요.

필요한 설정값:

| 항목 | 예시 |
|---|---|
| SMTP 호스트 | `smtp.company.local` |
| 포트 | `587`, `465`, 사내 릴레이는 `25`일 수도 있음 |
| TLS | STARTTLS / 직접 TLS / 없음 |
| 인증 | 없음(IP 릴레이) / LOGIN / PLAIN |
| 발신 주소 | `trade-monitor@company.com` |
| 배치 한도 | 예: 40명 |

메일 관리자의 승인 없이 외부 SMTP 서비스나 개인 메일 계정을 사용하지 마세요.

## 2. 사전 요구사항

- Windows PC
- Node.js 20 이상
- 공식 Gemini CLI
- 회사 계정에 Gemini Code Assist Standard/Enterprise 라이선스
- 회사 Google Cloud 프로젝트 ID
- 회사 SMTP 릴레이 접근 권한

설치 확인:

```powershell
node --version
npm --version
gemini --version
```

Gemini CLI가 없다면 회사 정책을 확인한 후 설치합니다.

```powershell
npm install -g @google/gemini-cli@latest
```

## 3. 회사 계정으로 Gemini CLI 로그인

저장소 루트에서 실행합니다.

```powershell
$env:GOOGLE_CLOUD_PROJECT = '회사-GCP-프로젝트-ID'
gemini
```

1. `Sign in with Google` 선택
2. Gemini Code Assist 라이선스가 할당된 회사 계정 로그인
3. 현재 저장소를 신뢰할지 물으면 회사 정책에 따라 승인
4. `pong만 출력해줘` 입력 후 응답 확인
5. `/quit` 입력

headless 실행 확인:

```powershell
gemini -p "pong만 출력해줘" --output-format json
```

`response`가 포함된 JSON이 나오면 준비가 끝났습니다.

## 4. 로컬 설정

```powershell
cd cli
Copy-Item .env.example .env
notepad .env
```

최소한 다음 값을 실제 회사 설정으로 변경합니다.

```dotenv
GOOGLE_CLOUD_PROJECT=회사-GCP-프로젝트-ID

SMTP_HOST=smtp.company.local
SMTP_PORT=587
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
SMTP_AUTH=none

MAIL_FROM=trade-monitor@company.com
MAIL_FROM_NAME=통상 모니터링 시스템
```

SMTP 유형별 예:

### STARTTLS, 587

```dotenv
SMTP_PORT=587
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
SMTP_AUTH=login
SMTP_USER=회사계정
SMTP_PASSWORD=회사비밀번호
```

### 직접 TLS, 465

```dotenv
SMTP_PORT=465
SMTP_SECURE=true
SMTP_REQUIRE_TLS=true
SMTP_AUTH=login
SMTP_USER=회사계정
SMTP_PASSWORD=회사비밀번호
```

### 사내 IP 릴레이, 인증 없음

TLS를 지원하는 경우:

```dotenv
SMTP_PORT=25
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
SMTP_AUTH=none
```

TLS가 전혀 없는 릴레이는 메일 관리자가 승인한 사내 서버일 때만 사용합니다.

```dotenv
SMTP_PORT=25
SMTP_SECURE=false
SMTP_REQUIRE_TLS=false
SMTP_ALLOW_INSECURE=true
SMTP_AUTH=none
```

SMTP 계정 인증은 TLS 없는 연결에서 차단됩니다.

## 5. 수신자 파일

예제 파일을 복사합니다.

```powershell
Copy-Item .\config\recipients.example.csv .\config\recipients.csv
notepad .\config\recipients.csv
```

형식:

```csv
name,email,enabled,focus
홍길동,hong.gildong@company.com,Y,관세
김수출,kim.export@company.com,N,수출통제
```

- `enabled=Y`인 행만 발송
- 빈 값은 발송하지 않음
- `focus`: `관세`, `수출통제`, `무역구제` 또는 빈 값
- 같은 이메일이 여러 번 나오면 첫 행만 사용
- 처음에는 반드시 본인 회사 이메일 한 명만 `Y`로 설정

`cli/config/recipients.csv`는 Git에서 제외됩니다.

## 6. 안전한 테스트 순서

### 코드 테스트

```powershell
cd cli
npm test
```

### Gemini와 SMTP를 사용하지 않는 모의 실행

```powershell
node .\run.mjs --mock .\test\fixtures\responses.json
```

결과가 `cli/output`에 생성됩니다.

```text
result.json
summary.md
newsletter.html
```

`newsletter.html`을 브라우저로 열어 내용을 확인합니다.

### SMTP 연결만 확인

메일은 보내지 않고 연결, TLS, 인증, `NOOP`만 수행합니다.

```powershell
node .\run.mjs --check-smtp
```

### 모의 데이터로 본인에게 시험 메일

```powershell
node .\run.mjs --mock .\test\fixtures\responses.json `
  --test-email 본인@company.com
```

시험 메일 제목에는 `[시험]`이 붙으며 정식 발송 이력에 기록되지 않습니다.

### 실제 Gemini 수집, 메일은 보내지 않음

```powershell
node .\run.mjs
```

`cli/output/.../newsletter.html`을 열어 결과를 검토합니다.

### 실제 Gemini 수집 후 본인 시험 메일

```powershell
node .\run.mjs --test-email 본인@company.com
```

### 전체 자동 발송

`recipients.csv`를 다시 확인한 후 실행합니다.

```powershell
node .\run.mjs --send
```

## 7. 로컬 저장 구조

```text
cli/
├─ output/                  실행별 JSON·Markdown·HTML
├─ data/
│  ├─ history.json         최근 발송 제목과 중복 제거 이력
│  ├─ deliveries/          날짜별 발송/부분 실패 상태
│  └─ .monitor.lock        동시 실행 방지용 임시 잠금
├─ logs/                   작업 스케줄러 실행 로그
└─ config/
   └─ recipients.csv       실제 수신자
```

발송 성공 후에만 `history.json`에 기사가 추가됩니다. 같은 날짜의
`deliveryKey`는 다시 전송되지 않습니다.

발송 도중 일부 SMTP 배치가 실패한 경우 같은 명령을 다시 실행합니다.

```powershell
node .\run.mjs --send
```

첫 실행에서 저장한 뉴스레터를 그대로 사용하고, 성공 기록이 없는 수신자만 이어서
발송합니다. 실제로 발송한 뒤 `data/deliveries` 파일을 임의로 삭제하지 마세요.

## 8. 평일 자동 실행

수동 전체 발송까지 성공한 뒤에만 등록합니다.

```powershell
cd cli
powershell -ExecutionPolicy Bypass -File .\install-windows-task.ps1
```

기본 시간은 평일 08:35입니다.

```powershell
.\install-windows-task.ps1 -At '08:20'
```

등록 작업 이름:

```text
TradeMonitoring-GeminiCLI
```

작업은 `node .\run.mjs --send`를 실행합니다. 실패 시 `cli/logs`의 최신 로그를
확인하세요. PC는 실행 시간에 켜져 있고 회사 네트워크/VPN에 연결돼 있어야 합니다.

## 9. 보안·중복 방지

- Gemini CLI 자식 프로세스에서 `GEMINI_API_KEY`, `GOOGLE_API_KEY`를 비움
- 회사 OAuth와 `GOOGLE_CLOUD_PROJECT`만 사용
- SMTP 비밀번호와 실제 수신자 명단은 Git 제외
- 기본 TLS 필수, 인증정보의 평문 전송 차단
- 모델 URL은 HTTPS·공개 DNS·리다이렉트를 검사한 뒤 메일 링크로 사용
- BCC 배치 사용, 메일 헤더에 BCC 주소를 기록하지 않음
- 발송 상태를 배치마다 원자적으로 저장해 부분 실패 재개
- 최근 7일 제목을 로컬 이력과 비교해 중복 기사 제거
- 동일 날짜 중복 발송 차단

## 주요 명령

```powershell
node .\run.mjs --help
node .\run.mjs --check-smtp
node .\run.mjs --mock .\test\fixtures\responses.json
node .\run.mjs --test-email 본인@company.com
node .\run.mjs --send
```
