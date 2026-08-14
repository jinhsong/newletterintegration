# 회사 AI CLI 글로벌 통상 모니터링

회사 계정으로 로그인된 Claude, Gemini 또는 ChatGPT(Codex) CLI 중 하나를 선택해
관세·수출통제·무역구제 동향을 조사하고, 결과를 PC의 자체 포함 HTML 파일로 저장합니다.

메일 발송, 예약 실행, Google Drive, Apps Script, Obsidian, 외부 데이터베이스는 사용하지
않습니다. 이 저장소에 API 키를 입력하거나 저장할 필요도 없습니다.

## 가장 먼저 알아둘 기본값

옵션 없이 실행하면 모델과 기간을 직접 물어봅니다.

- 모델을 빈칸으로 두면 Claude
- 기간을 빈칸으로 두면 KST 기준 월요일은 직전 72시간
- 월요일이 아닌 날 기간을 빈칸으로 두면 직전 24시간
- 기간을 직접 입력하면 실행 시점부터 직전 1~168시간

Gemini와 ChatGPT를 선택해도 그 회사 CLI에 설정된 기본 세부 모델을 사용합니다. 특정
세부 모델명을 강제하려는 경우에만 뒤의 선택 설정을 사용하세요.

## 처음 한 번만 준비하기

### 1. PowerShell 열기

Windows 시작 메뉴에서 PowerShell을 검색해 실행합니다. 관리자 권한은 보통 필요하지
않습니다.

### 2. Git과 Node.js 확인

아래 명령을 한 줄씩 입력합니다.

    git --version
    node --version

Node.js는 v20 이상이어야 합니다. 명령을 찾을 수 없으면 회사 소프트웨어 센터나 IT
담당자를 통해 설치하세요. 이 프로젝트는 외부 Node 패키지가 없으므로 npm install은
필요하지 않습니다.

### 3. newletterintegration 폴더 만들기

아래 명령은 사용자 홈 폴더 아래에 newletterintegration 폴더를 자동으로 만들고,
이번 작업 브랜치의 코드를 받습니다.

    cd $HOME
    git clone --branch agent/multi-cli-period-selector https://github.com/jinhsong/newletterintegration.git newletterintegration
    cd .\newletterintegration

명령줄 앞에 표시되는 위치가 다음처럼 바뀌면 준비된 것입니다.

    PS C:\Users\사용자이름\newletterintegration>

이미 newletterintegration 폴더를 받은 적이 있다면 다시 clone하지 말고 다음 명령을
사용합니다.

    cd $HOME\newletterintegration
    git fetch origin
    git switch agent/multi-cli-period-selector
    git pull --ff-only origin agent/multi-cli-period-selector

다른 위치에 저장했다면 첫 번째 cd 경로만 실제 폴더에 맞게 바꾸세요.

### 4. 사용할 회사 AI CLI 준비

세 가지를 모두 설치할 필요는 없습니다. 실제로 선택할 CLI만 설치하고 회사 계정으로
로그인하면 됩니다.

#### Claude

    where.exe claude
    claude --version
    claude auth status

로그인되지 않았고 회사 정책이 허용하면 다음 명령으로 SSO 로그인을 시작합니다.

    claude auth login --sso

Claude Code 2.1.214 이상이 필요합니다.

#### Gemini

    where.exe gemini
    gemini --version
    gemini

Gemini 화면이 열리면 회사 Google/Enterprise 로그인 방식을 선택해 로그인을 마칩니다.
로그인 뒤 PowerShell로 돌아올 때는 Ctrl+C를 누릅니다. Gemini CLI에는 이 프로그램이
사용할 별도의 auth status 명령이 없으므로, 실제 연결은 아래의 단일 카테고리 시험으로
확인합니다.

Gemini CLI 0.53.0 이상이 필요합니다.

#### ChatGPT

이 프로그램에서 ChatGPT 선택은 Codex CLI를 뜻합니다.

    where.exe codex
    codex --version
    codex login
    codex login status

마지막 명령이 다음과 같이 나와야 합니다.

    Logged in using ChatGPT

기본값은 ChatGPT OAuth이며 API key 또는 개인 access token은 허용하지 않습니다. 회사가
Agent Identity나 사내 OAuth 주소를 관리하는 경우에는 아래 `CODEX_CLI_AUTH_MODE=managed`
설정을 명시적으로 켤 수 있습니다.

회사에서 별도 설치·SSO 절차를 제공하면 회사 안내를 우선 따르세요.

## 처음 실행하기

처음에는 회사 CLI 연결을 빠르게 확인할 수 있도록 newletterintegration 폴더에서
북미 관세 카테고리 하나만 시험하는 다음 한 줄을 권장합니다.

    .\run-monitoring.cmd --category "customs:북미"

화면에는 다음 질문이 나타납니다.

    호출 모델을 선택하세요.
      1. Claude (기본값)
      2. Gemini
      3. ChatGPT (Codex CLI)
    선택 [Enter=1]:

원하는 번호를 입력하고 Enter를 누릅니다. 그냥 Enter를 누르면 Claude입니다.

이어지는 질문에서 시간을 입력합니다.

    모니터링 기간을 시간 단위로 입력하세요. (1~168시간)
    아무 값도 입력하지 않으면 월요일은 72시간, 그 외 요일은 24시간입니다.
    기간 [Enter=요일 기본값]:

예를 들어 직전 이틀을 조사하려면 48을 입력합니다. 기본 규칙을 쓰려면 아무것도
입력하지 않고 Enter를 누릅니다.

시험이 끝난 뒤 18개 카테고리 전체를 조사하려면 다음 명령을 사용합니다.

    .\run-monitoring.cmd

전체 조사는 선택한 AI CLI로 카테고리를 차례대로 조사합니다. 각 카테고리에서
공식기관과 일반 동향을 여러 관점으로 검색하므로 시간이 오래 걸릴 수 있습니다. 전체
표준 조사는 최소 114회(빠름 72회, 심층 146회)의 웹 검색을 수행합니다. 연결 확인은 반드시
위 단일 카테고리부터 시작하세요.

정상 완료되면 기본 브라우저가 열리고 결과는 다음 파일에 저장됩니다.

    newletterintegration\cli\output\monitoring.html

다음 실행부터는 clone과 로그인 명령을 반복할 필요 없이 같은 폴더에서 원하는 실행
명령만 입력하면 됩니다.

## 모델과 기간을 명령에 바로 지정하기

질문에 답하는 대신 명령 한 줄에 값을 지정할 수 있습니다.

    .\run-monitoring.cmd --provider claude --lookback 24
    .\run-monitoring.cmd --provider gemini --lookback 48
    .\run-monitoring.cmd --provider chatgpt --lookback 72

provider 값은 claude, gemini, chatgpt 중 하나입니다. lookback 값은 1~168 사이의 정수
시간입니다.

둘 중 하나만 지정하면 PowerShell 대화형 실행에서는 지정하지 않은 값만 질문합니다.

    .\run-monitoring.cmd --provider gemini
    .\run-monitoring.cmd --lookback 36

파이프나 자동화처럼 질문할 수 없는 환경에서 값을 생략하면 Claude와 요일별 기본 기간을
사용합니다.

## 그룹 하나만 조사하기

관세, 수출통제, 무역구제 중 한 그룹만 조사할 수 있습니다.

    .\run-monitoring.cmd --provider claude --lookback 24 --group "관세"
    .\run-monitoring.cmd --provider gemini --lookback 48 --group "수출통제"
    .\run-monitoring.cmd --provider chatgpt --lookback 72 --group "무역구제"

사용 가능한 그룹은 CLI에 접속하지 않고 확인할 수 있습니다.

    .\run-monitoring.cmd --list-groups

영문 값 customs, export, trade도 사용할 수 있습니다.

## 카테고리 하나만 조사하기

회사 CLI 연결을 처음 확인할 때는 단일 카테고리 실행이 가장 빠릅니다.

    .\run-monitoring.cmd --provider gemini --lookback 24 --category "customs:북미"
    .\run-monitoring.cmd --provider claude --lookback 24 --category "export:미국"
    .\run-monitoring.cmd --provider chatgpt --lookback 24 --category "trade:반덤핑"

18개 카테고리의 정확한 식별자는 다음 명령으로 확인합니다. AI CLI에는 접속하지
않습니다.

    .\run-monitoring.cmd --list-categories

## 결과 파일

- 전체: cli\output\monitoring.html
- 관세 그룹: cli\output\monitoring-customs.html
- 수출통제 그룹: cli\output\monitoring-export.html
- 무역구제 그룹: cli\output\monitoring-trade.html
- 단일 카테고리: cli\output\monitoring-{영역}-{카테고리}.html
- 목 화면 시험: cli\output\mock-monitoring.html

저장 위치를 직접 지정할 수도 있습니다. --out 상대경로는 newletterintegration 저장소
폴더 기준입니다.

    .\run-monitoring.cmd --provider claude --lookback 24 --category "customs:북미" --out .\cli\output\북미-오늘.html

일부 카테고리만 성공하면 기존 정상 결과는 보존하고, 이름에 partial과 시각이 붙은 별도
HTML을 저장합니다. 이 경우 종료 코드는 2이며 화면에 저장 경로가 표시됩니다.

브라우저를 자동으로 열지 않으려면 다음 옵션을 추가합니다.

    .\run-monitoring.cmd --provider gemini --lookback 24 --category "customs:북미" --no-open

## 기간 계산 방식

직접 입력한 시간은 실행 시점 기준입니다. 예를 들어 화요일 오전 9시에 48을 입력하면
일요일 오전 9시부터 화요일 오전 9시까지를 조사합니다.

빈 입력은 KST 요일을 기준으로 다음처럼 계산합니다.

- 월요일: 주말을 포함하도록 직전 72시간
- 화요일~일요일: 직전 24시간

발표시각이 원문에서 확인된 항목은 정확한 시각으로 판정합니다. 시각이 없고 발표일만
확인되는 항목은 KST 달력 날짜 기준으로 판정한다는 안내가 HTML에도 표시됩니다.

## 조사 결과를 볼 때 주의할 점

결과는 AI가 웹 검색을 바탕으로 정리한 예비 조사 자료입니다. 링크, 발표일, 적용 품목,
대상 국가, 수치와 시행일을 원문에서 다시 확인한 뒤 의사결정에 사용하세요.

- Claude는 CLI가 반환한 구조화 검색결과 URL과 항목 URL을 연결합니다.
- Gemini와 Codex 이벤트는 실행된 검색어는 보여 주지만 원 검색결과의 URL 목록은 모두
  제공하지 않습니다. 모델이 검색별로 보고한 URL을 형식·공식 도메인·항목 출처와
  대조하며, HTML에는 더 낮은 증거 수준인 모델 보고 검색 URL로 표시합니다. Gemini의
  공식 Grounding 리다이렉트는 허용하되 원문 직접 일치보다 낮은 근거로 경고합니다.
- 검색 최소 횟수·공식/일반 검색 비율·신뢰 도메인은 계속 강제합니다. 일부 하위 국가가
  검색어에서 확인되지 않으면 전체 카테고리를 폐기하지 않고 HTML에 검색 범위 경고를
  표시합니다.
- 프로그램은 원문 URL을 Node에서 직접 내려받거나 DNS 조회하지 않습니다.
- 모델이 보고한 안전한 공개 HTTPS 링크만 HTML 링크로 만듭니다.

선택한 CLI 서비스에는 조사 프롬프트가 전송되고, 그 서비스가 외부 공식기관·언론 사이트를
검색합니다. 회사의 데이터 처리 정책과 AI 사용 지침을 따르세요.

## 안전 경계

- Claude는 비어 있는 임시 폴더에서 WebSearch만 허용하고 MCP·셸·파일 도구를 차단합니다.
- Gemini는 비어 있는 임시 폴더의 고정 설정으로 google_web_search만 허용하고
  MCP·hooks·skills·agents·프로젝트 컨텍스트를 끕니다.
- Codex는 빈 임시 폴더, ephemeral 실행, read-only sandbox, 승인 금지, 사용자 설정·규칙
  무시를 적용합니다. 스킬·앱·협업·환경 안내 주입을 명시적으로 끄고, 사전 점검에서
  셸·hooks·앱·플러그인·MCP·브라우저·컴퓨터 사용·이미지·메모리·goal·다중 에이전트
  기능이 실제로 비활성화됐는지 확인한 뒤 실행합니다. 검토하지 않은 새 활성 기능이나
  내용이 있는 CODEX_HOME 전역 AGENTS 파일이 발견되면 외부 요청 전에 중단합니다.
- 알려지지 않은 도구·파일·저장·백그라운드·권한 변경 이벤트는 결과를 저장하지 않고
  중단합니다. 새 버전의 수동 상태·시간·사용량 진단 필드는 경고로 기록하고 계속합니다.
- Gemini와 Codex 조사 프로세스에는 흔히 쓰이는 개인 API 키 환경변수를 전달하지 않습니다.
  기본 ChatGPT 모드에서는 Codex의 OAuth 갱신·해지·Auth API 주소를 바꾸는 환경변수도
  제거합니다. 관리형 모드는 회사 설정을 의도적으로 보존합니다.

## 선택 설정

대부분의 사용자는 이 절을 건드릴 필요가 없습니다. 회사 전용 실행 파일 경로나 세부 모델,
시간 제한을 바꿔야 할 때만 예제 파일을 복사합니다.

    Copy-Item .\cli\.env.example .\cli\.env
    notepad .\cli\.env

세부 모델을 빈칸으로 두면 각 회사 CLI의 기본 모델을 사용합니다.

    CLAUDE_CLI_MODEL=
    GEMINI_CLI_MODEL=
    CODEX_CLI_MODEL=

회사 Codex가 Agent Identity 또는 관리형 OAuth/SSO 주소를 요구할 때만 다음 설정을
추가합니다. 이 모드는 회사가 주입한 `OPENAI_BASE_URL`, Codex Auth API, refresh/revoke
주소를 조사 프로세스에 보존하므로 IT가 승인한 환경에서만 사용하세요.

    CODEX_CLI_AUTH_MODE=managed

회사 전용 CLI가 PATH에 없다면 실행 파일의 전체 경로를 설정할 수 있습니다.

    CLAUDE_CLI_BIN=C:\회사도구\claude.exe
    GEMINI_CLI_BIN=C:\회사도구\gemini.cmd
    CODEX_CLI_BIN=C:\회사도구\codex.cmd

시간 제한 기본값은 공급자별 사전 점검 60초, 카테고리 호출 10분입니다. 전체 standard
실행 기본 제한은 120분입니다. 보안 검사나 사내 프록시 때문에 정상 호출이 더 오래 걸릴
때만 .env.example의 해당 값을 조정하세요.

cli\.env에는 API 키를 넣을 수 없으며, 허용되지 않은 설정은 시작 단계에서 거부됩니다.

## 자주 생기는 오류

### 명령을 찾을 수 없음

선택한 CLI 위치를 확인합니다.

    where.exe claude
    where.exe gemini
    where.exe codex

원하는 CLI가 나오지 않으면 회사 승인 경로로 설치하거나 .env의 해당 CLI_BIN에 전체 경로를
지정합니다.

### AUTH

선택한 CLI에 회사 계정으로 다시 로그인합니다.

Claude:

    claude auth status
    claude auth login --sso

Gemini:

    gemini

ChatGPT:

    codex logout
    codex login
    codex login status

기본 ChatGPT 모드는 상태가 `Logged in using ChatGPT`가 아니면 실행하지 않습니다. 회사
Agent Identity라면 `.env`의 `CODEX_CLI_AUTH_MODE=managed`를 확인하세요. managed 모드도
API key와 개인 access token은 거부합니다.

### CLI_VERSION 또는 보안 기능 고정 실패

회사 소프트웨어 센터나 IT 담당자를 통해 해당 CLI를 승인된 최신 버전으로 업데이트합니다.
특히 Codex는 먼저 현재 버전의 기능 목록을 읽고, 그 버전이 실제 지원하는 검색 외 기능을
실행 전에 끈 뒤 상태를 다시 확인합니다. 구버전에 아직 없는 기능 이름은 오류로 보지
않지만, 새 위험 기능을 끌 수 없거나 비활성화가 적용되지 않으면 안전을 위해 중단합니다.

### SECURITY_POLICY와 Codex 전역 AGENTS

ChatGPT 실행에서 CODEX_HOME의 AGENTS.md 또는 AGENTS.override.md가 감지되면 그 내용이 조사
요청에 섞이지 않도록 파일을 자동 변경하지 않고 중단합니다. 본인이 만든 전역 지시문이라도
임의로 삭제하지 말고 회사 정책을 확인하세요. 회사가 별도 Codex 홈 사용을 허용한다면 새
PowerShell에서 다음처럼 모니터링 전용 홈을 만들고 그 홈에 회사 ChatGPT 로그인을 한 뒤,
같은 창에서 프로그램을 실행할 수 있습니다.

    $env:CODEX_HOME="$HOME\.codex-trade-monitor"
    New-Item -ItemType Directory -Force $env:CODEX_HOME
    codex login
    codex login status
    .\run-monitoring.cmd --provider chatgpt --category "customs:북미"

회사에서 CODEX_HOME 변경을 금지하면 이 방법을 쓰지 말고 IT 담당자에게 문의하세요.

### WEB_SEARCH_UNAVAILABLE 또는 정책 차단

회사 AI 관리자에게 선택한 CLI 계정에서 웹 검색 도구가 허용되어 있는지 확인해 달라고
요청하세요. 검색 없이 모델 기억만으로 대체하는 fallback은 제공하지 않습니다.

### 다른 모니터링 실행이 진행 중

같은 PC에서 먼저 시작한 실행이 끝날 때까지 기다린 뒤 다시 실행하세요. 잠금 파일을
수동으로 삭제하지 마세요. 별도 동시 조사는 사용량과 결과 충돌 위험이 있어 기본 차단됩니다.

### TIMEOUT 또는 RUN_TIMEOUT

먼저 단일 카테고리와 24시간으로 시험합니다.

    .\run-monitoring.cmd --provider gemini --lookback 24 --category "customs:북미" --no-open

단일 카테고리도 반복해서 시간 초과되면 사내 프록시, 보안 검사, 해당 CLI 서비스 상태와
웹 검색 권한을 확인하세요. 단순히 제한 시간을 계속 늘리기 전에 화면의 최초 오류 코드를
확인하는 편이 좋습니다.

### PROCESS_CLEANUP 또는 taskkill 경고

원래 조사 오류 뒤에 프로세스 정리 경고가 함께 표시될 수 있습니다. 화면의 첫 오류와
`상세`에 적힌 원래 오류를 먼저 확인하세요. `PROCESS_CLEANUP`은 AI CLI 자손 프로세스의
종료를 확인하지 못했다는 별도 안전 오류입니다. 회사 보안 정책이 `taskkill`을 막는다면
IT에 승인된 native 실행 파일 경로 또는 프로세스 종료 정책을 문의하세요. 프로그램은
종료 확인 없이 다음 조사나 HTML 교체를 진행하지 않습니다.

### 결과가 너무 적음

- 기간을 48시간 또는 72시간으로 늘립니다.
- 전체 실행보다 관련 그룹이나 카테고리를 먼저 확인합니다.
- standard가 기본이며 더 넓은 탐색이 필요하면 deep을 사용할 수 있습니다.

    .\run-monitoring.cmd --provider claude --lookback 72 --group "수출통제" --depth deep

deep은 검색 횟수와 최대 항목 수, 실행 시간이 늘어납니다.

## 프로그램 버전과 화면 시험

AI CLI에 접속하지 않고 프로그램 버전을 확인합니다.

    .\run-monitoring.cmd --version

AI CLI에 접속하지 않고 예제 HTML 화면만 만듭니다.

    .\run-monitoring.cmd --mock .\cli\test\fixtures\responses.json --no-open

개발자용 전체 자동 테스트:

    npm --prefix .\cli test

자동 테스트는 Windows 가짜 Claude·Gemini·Codex 실행 파일로 명령 인자, stdin, 이벤트
검증, 오류 분류, API 키 제거, HTML과 저장 로직을 확인합니다. 실제 회사 SSO·프록시·웹
검색 권한은 자동 테스트로 대신할 수 없으므로 회사 PC에서 단일 카테고리 시험을 한 번
실행해야 합니다.

## 공식 CLI 문서

- Claude Code CLI: https://docs.anthropic.com/en/docs/claude-code/cli-reference
- Gemini headless mode: https://geminicli.com/docs/cli/headless/
- Gemini authentication: https://geminicli.com/docs/get-started/authentication/
- Gemini Enterprise: https://geminicli.com/docs/cli/enterprise/
- Codex non-interactive mode: https://learn.chatgpt.com/docs/non-interactive-mode
- Codex authentication: https://learn.chatgpt.com/docs/auth
- Codex web search: https://learn.chatgpt.com/docs/web-search
