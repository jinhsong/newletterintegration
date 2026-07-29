# 글로벌 통상 통합 모니터링 (관세 + 수출통제 + 무역구제)

기존에 **관세 / 수출통제 / 무역구제** 3개로 분리되어 각각 메일을 보내던
Google Apps Script 모니터링 시스템을, **하나의 파이프라인으로 통합하여
단 한 통의 메일**로 발송하도록 합친 버전입니다.

Gemini 호출은 두 가지 실행 모드를 지원합니다.

| 모드 | 모델 인증 | 실행 위치 | 용도 |
|------|-----------|-----------|------|
| Gemini API | `GEMINI_API_KEY` | Apps Script | 기존 서버리스 방식 |
| Gemini CLI | 사내 Gemini Code Assist Enterprise OAuth | Windows PC + Apps Script | API 키 없는 사내 계정 방식 |

## 무엇이 바뀌었나
- 메일 3통 → **1통** (관세 · 수출통제 · 무역구제 3개 섹션으로 구성)
- API 모드 트리거 3세트 → **1세트** (평일 09시 정기 + 5분 요청 폴링)
- 중복되던 공통 로직(출처 URL 확보, grounding 매핑, 뉴스 RSS, 인사이트,
  옵시디안 저장, 중복 제거)을 **단일 엔진**으로 통합
- API 모드는 17개 요청을 `FETCH_CONCURRENCY` 단위로 병렬 처리
- CLI 모드는 사내 OAuth로 17개 요청을 동시성 제한·개별 재시도하고 Drive inbox로 전달

## 파일 구성 (Apps Script 한 프로젝트에 모두 붙여넣기)
| 파일 | 역할 |
|------|------|
| `01_Config.gs` | 공통 설정 + 3개 도메인 정의(카테고리/프롬프트/정규화/색상/DB 스키마) |
| `02_Main.gs` | 오케스트레이션, 주말/소급 정책, 통계, 날짜 필터 |
| `03_Gemini.gs` | 전 도메인 병렬 호출 + 재시도 + 응답 파싱 + grounding 매핑 |
| `04_Sources.gs` | 원문 URL 확보(리다이렉트 해소 → 모델 URL 검증 → 뉴스 RSS) |
| `05_Insights.gs` | 도메인별 AI 인사이트(병렬 생성) |
| `06_Email.gs` | 단일 통합 HTML 메일 빌드 + BCC 발송 |
| `07_Sheets.gs` | 시트 초기화/저장(도메인별 DB)/중복 제거/수신자/로그 |
| `08_Obsidian.gs` | 통합 마크다운 1개 저장(Drive 경유) |
| `09_Requests_Triggers.gs` | 이메일 요청(온디맨드) + 트리거 등록 |
| `10_Cli_Bridge.gs` | Drive inbox의 Gemini CLI 결과 검증·발송 |
| `cli/` | 사내 Gemini CLI용 Node.js 수집기, 테스트, 작업 스케줄러 스크립트 |

> 10개 `.gs` 파일은 같은 전역 스코프를 공유합니다. 기존 3개 프로젝트의
> 중복 함수명(`buildEmailHTML`, `sendEmail`, `attachSources`, `extractDomain` 등)은
> 충돌이 없도록 단일 구현으로 정리했습니다.

## 공통 초기 설정
1. **새 스프레드시트** 1개 생성 → 확장프로그램 > Apps Script 로 진입
2. 위 10개 `.gs` 파일 내용을 각각 추가
3. **프로젝트 설정 > 스크립트 속성**
   - `ADMIN_EMAIL` (선택, 오류 알림 수신)
   - `OBSIDIAN_FOLDER_ID` (선택, 옵시디안 저장 폴더 ID 또는 Drive URL)
4. `initializeSheets()` 실행 → 시트 생성
   - `관세_동향DB`, `수출통제_동향DB`, `무역구제_동향DB`, `발송인 명단`, `발송로그`
5. **`발송인 명단`** 시트에 수신자 입력
   - A:이름, B:이메일, E:발송여부(`N` 이면 제외, 비었거나 그 외 값이면 발송),
     **F:관심영역**(`관세`/`수출통제`/`무역구제` — 입력 시 그 영역이 메일 맨 앞 PART 1에 배치)
   - `initializeSheets()`가 만드는 예시 이메일은 반드시 삭제하거나 E열을 `N`으로 변경
   - 기존 3개 프로젝트의 수신자를 이 한 시트로 합치기

이후 아래의 **API 모드** 또는 **Gemini CLI 모드** 중 하나만 설정합니다.

## Gemini CLI Enterprise 모드

Gemini API 키를 사용하지 않습니다. 공식 Gemini CLI 프로세스가 사내 OAuth를
직접 처리하며, 수집 결과만 Google Drive 동기화 폴더로 전달합니다.

### 1. 사전 요구사항

- Node.js 20 이상
- Gemini CLI 설치
- 본인 계정에 Gemini Code Assist Standard/Enterprise 라이선스 할당
- 사내 Google Cloud 프로젝트와 `GOOGLE_CLOUD_PROJECT` 값
- Google Drive for desktop
- 작업 시간에 켜져 있고 인터넷에 연결된 Windows PC

회사 계정으로 최초 로그인을 완료합니다.

```powershell
$env:GOOGLE_CLOUD_PROJECT = '회사-GCP-프로젝트-ID'
gemini
gemini -p "pong만 출력해줘" --output-format json
```

마지막 명령이 JSON envelope를 반환해야 합니다. 로컬 수집기는 환경에 남아 있는
`GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI`를 자식 프로세스에서
제거하므로 사내 OAuth 외의 키로 잘못 실행되지 않습니다.

### 2. Drive inbox 준비

1. 회사 Google Drive에 `통상모니터링_CLI_INBOX` 폴더를 생성
2. Google Drive for desktop에서 해당 폴더를 PC에 동기화
3. Apps Script 편집기에서 다음을 한 번 실행

```javascript
setCliInboxFolderId('https://drive.google.com/drive/folders/폴더ID');
setupCliModeTriggers();
```

`setupCliModeTriggers()`는 기존 API 정기 트리거와 이메일 온디맨드 트리거를
제거하고 `processCliInbox()`만 5분마다 실행합니다. CLI 모드에서는
`GEMINI_API_KEY` 스크립트 속성이 필요하지 않습니다.

### 3. 로컬 설정

```powershell
cd cli
Copy-Item .env.example .env
notepad .env
```

`.env`에서 아래 두 값을 반드시 수정합니다.

```dotenv
GOOGLE_CLOUD_PROJECT=회사-GCP-프로젝트-ID
CLI_INBOX_PATH=G:\내 드라이브\통상모니터링_CLI_INBOX
```

`.env`는 `.gitignore`에 포함돼 저장소에 커밋되지 않습니다.

### 4. 테스트와 실행

Gemini 호출 없이 파서·정규화·Apps Script 문법을 검증합니다.

```powershell
cd cli
npm test
node .\run.mjs --mock .\test\fixtures\responses.json
```

실제 Gemini CLI를 호출하되 메일은 보내지 않는 안전한 로컬 실행:

```powershell
node .\run.mjs
```

결과는 `cli/output/<날짜-runId>/result.json`, `summary.md`에 저장됩니다.

실제 Drive inbox 전달:

```powershell
node .\run.mjs --deliver
```

Drive 동기화 후 Apps Script가 5분 이내에 파일을 읽어 중복·날짜·원문 URL을
재검증하고 기존 BCC 메일, 시트, 옵시디안 파이프라인을 실행합니다. 같은 날짜의
`deliveryKey`는 한 번만 처리되어 작업 스케줄러 재시작으로 인한 중복 발송을 막습니다.

같은 날짜 파일을 로컬에서 명시적으로 덮어쓸 때만 `--force`를 사용합니다.
이미 Apps Script가 처리한 `deliveryKey`는 `--force`로도 다시 발송되지 않습니다.

### 5. Windows 작업 스케줄러

PowerShell에서 한 번 실행하면 평일 08:35 작업이 등록됩니다. 17개 분야 조사와
Drive 동기화 시간을 감안해 09시 전부터 시작하며, PC가 꺼져 있었으면 켜진 뒤 실행됩니다.

```powershell
cd cli
powershell -ExecutionPolicy Bypass -File .\install-windows-task.ps1
```

시간을 바꾸려면:

```powershell
.\install-windows-task.ps1 -At '08:20'
```

### CLI 모드 제한사항

- Code Assist IDE가 아니라 **공식 Gemini CLI headless 프로세스**가 운영 실행 주체
- CLI JSON에는 API의 원본 `groundingMetadata`가 없으므로 모델 URL 검증 → 뉴스 RSS
  → Google 검색 순으로 보완
- 이메일 제목 `통상 요청` 온디맨드 기능은 CLI 모드에서 비활성
- PC, 회사 VPN/프록시, Drive 동기화가 정상이어야 함
- `_processed`, `_failed` 하위 폴더에 처리 결과가 이동됨

## Gemini API 모드

1. 스크립트 속성 `GEMINI_API_KEY` 설정
2. `verifyModel()` 실행
3. `setupApiModeTriggers()` 실행
4. `runMonitoringNow()`로 테스트 발송

`setupApiModeTriggers()`는 CLI inbox 트리거를 제거하고 평일 09시 정기 +
5분 이메일 요청 폴링을 다시 등록합니다.

## 운영 정책
- **정기 발송**: 평일(월~금) 09시. 월=직전 72h(주말 포함), 화~금=24h, 주말 미발송
- **담당자별 순서**: `관심영역`이 지정된 수신자는 그 영역이 맨 앞(PART 1)에 오도록
  재배열된 버전을 받음. 수집은 1회, HTML 조립만 그룹별로 반복(비용 미미)
- **온디맨드**: 명단 수신자가 제목에 **`통상 요청`** 포함해 메일 보내면 **현재 전체 현황**을
  회신 (API 모드 전용, 이력 중복제거 없이. 요청자 1인당 일일 `ONDEMAND_DAILY_LIMIT`회)
- **재전송**: `resendLastBriefing()` — 직전 발송분을 재수집 없이 그대로 재발송(스냅샷 재생).
  `resendLastBriefing('a@x.com, b@y.com')` 로 특정 수신자에게만 재전송 가능.
  발송 실패분 보완·뒤늦게 추가된 수신자 대상에 사용.
- **출처 링크 폴백**: grounding 원문 → 모델 제공 URL 검증 → 뉴스 RSS → Google 검색
- **6분 제한 대응**: 시간 예산이 부족하면 인사이트/출처 후순위 단계를 순서대로
  포기하여 **저장·발송은 반드시 완료**

## 주요 함수
- `runMonitoringNow()` — 즉시 강제 실행(주말 테스트 가능)
- `resendLastBriefing([toEmails])` — 직전 발송분 재전송(재수집 없음)
- `runDailyMonitoring()` — 정기 트리거 핸들러
- `checkEmailRequests()` — 요청 폴링 핸들러
- `initializeSheets()` / `setupApiModeTriggers()` / `verifyModel()` — API 모드 설정
- `setCliInboxFolderId()` / `setupCliModeTriggers()` / `processCliInbox()` — CLI 모드 설정
- `setObsidianFolderId(urlOrId)` / `showObsidianFolderId()` — 옵시디안 폴더 지정
