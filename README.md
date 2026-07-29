# 글로벌 통상 모니터링 — Gemini CLI 로컬 HTML판

관세·수출통제·무역구제 17개 분야를 사내 Gemini Code Assist Enterprise 계정으로
조사하고, 결과를 PC에 스타일이 적용된 HTML 파일로 저장합니다.

```text
회사 Gemini CLI OAuth
  → 뉴스 조사·중복 제거·출처 검증
  → PC 로컬 newsletter.html 저장
```

- Gemini API 키 없음
- Google Drive 없음
- Google Apps Script 실행 없음
- SMTP·메일 발송 없음
- 외부 데이터베이스 없음
- 별도 웹 서버 없음

CSS는 `newsletter.html` 내부에 포함되어 있습니다. 파일을 더블클릭하면 브라우저에서
바로 볼 수 있습니다.

루트의 `.gs` 파일은 기존 프롬프트·정규화·HTML 디자인 정의를 로컬 Node.js
실행기가 읽어 재사용합니다. Apps Script 프로젝트에 올릴 필요는 없습니다.

## 1. 필요한 프로그램

- Windows PC
- Node.js 20 이상
- 공식 Gemini CLI
- 회사 계정의 Gemini Code Assist Standard/Enterprise 라이선스
- 회사 Google Cloud 프로젝트 ID

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

## 2. 회사 계정으로 Gemini CLI 로그인

저장소 루트에서 PowerShell로 실행합니다.

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

## 3. 로컬 설정

```powershell
cd cli
Copy-Item .env.example .env
notepad .env
```

프로젝트 ID를 실제 값으로 변경합니다.

```dotenv
GOOGLE_CLOUD_PROJECT=회사-GCP-프로젝트-ID
LOCAL_OUTPUT_DIR=.\output
```

API 키나 메일 정보를 입력하지 않습니다. `.env`는 Git에서 제외됩니다.

## 4. 안전한 모의 실행

코드 테스트:

```powershell
cd cli
npm test
```

Gemini를 호출하지 않고 예제 데이터로 HTML 생성:

```powershell
node .\run.mjs --mock .\test\fixtures\responses.json
```

생성된 HTML 열기:

```powershell
Start-Process .\output\latest\newsletter.html
```

## 5. 실제 Gemini 결과 저장

다음 한 줄만 실행하면 됩니다.

```powershell
cd cli
node .\run.mjs
```

이 명령은 메일을 보내지 않습니다. 외부 저장소에도 업로드하지 않습니다.

완료 메시지:

```text
HTML 저장 완료: ...\cli\output\latest\newsletter.html
메일을 발송하거나 외부 저장소에 업로드하지 않았습니다.
```

결과 열기:

```powershell
Start-Process .\output\latest\newsletter.html
```

파일 탐색기에서 다음 파일을 직접 더블클릭해도 됩니다.

```text
newletterintegration
└─ cli
   └─ output
      └─ latest
         └─ newsletter.html
```

## 6. 저장되는 파일

가장 최근 결과:

```text
cli/output/latest/newsletter.html   스타일 적용 결과
cli/output/latest/summary.md        텍스트 요약
cli/output/latest/result.json       구조화된 원본 결과
```

실행별 보관본:

```text
cli/output/archive/<날짜-runId>/
├─ newsletter.html
├─ summary.md
└─ result.json
```

새로 실행할 때 `latest` 파일은 최신 결과로 교체되지만 `archive`의 이전 결과는
그대로 남습니다.

## 7. 수집 기간 변경

기본값:

- 월요일: 최근 72시간
- 화요일~일요일: 최근 24시간

직접 지정:

```powershell
node .\run.mjs --lookback 72
node .\run.mjs --lookback 168
```

인사이트 생성을 생략해 빠르게 확인:

```powershell
node .\run.mjs --skip-insights
```

## 8. 평일 자동 HTML 생성

수동 실행이 정상적으로 완료된 뒤 등록합니다.

```powershell
cd cli
powershell -ExecutionPolicy Bypass -File .\install-windows-task.ps1
```

기본 실행 시간은 평일 08:35입니다.

```powershell
.\install-windows-task.ps1 -At '08:20'
```

작업 이름:

```text
TradeMonitoring-GeminiCLI
```

실패 로그는 `cli/logs`에 저장됩니다. PC가 실행 시간에 켜져 있고 회사
네트워크/VPN에 연결되어 있어야 합니다.

## 9. 문제 해결

도움말:

```powershell
node .\run.mjs --help
```

이전 실행이 비정상 종료되어 잠금 오류가 발생했고 실제로 실행 중인
`node` 프로세스가 없다면 다음 잠금 파일만 삭제한 뒤 다시 실행합니다.

```powershell
Remove-Item .\output\.monitor.lock
```

Gemini 로그인 오류가 나면 저장소 루트에서 다시 실행합니다.

```powershell
$env:GOOGLE_CLOUD_PROJECT = '회사-GCP-프로젝트-ID'
gemini
```

## 보안

- Gemini CLI 자식 프로세스에서 `GEMINI_API_KEY`, `GOOGLE_API_KEY`를 비움
- 회사 OAuth와 `GOOGLE_CLOUD_PROJECT`만 사용
- 모델 URL은 HTTPS·공개 DNS·리다이렉트를 검사한 뒤 HTML 링크로 사용
- HTML에 외부 CSS·JavaScript를 삽입하지 않음
- `.env`, 결과 HTML·JSON, 실행 로그는 Git에 커밋하지 않음
