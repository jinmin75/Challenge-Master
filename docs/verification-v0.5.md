# Windows 시범 설치본 v0.5 검증 기록

검증일: `2026-09-27`. 대상은 합성 PDF와 이 개발 PC에 설치한 Windows x64 시범 설치본이다. 학생 교재·계정은 사용하지 않았다.

최종 산출물: `dist/Challenge-Master-Setup-0.5.0-win-x64.exe` (34,698,788바이트). SHA-256 `8a3da84ad60fd8d12060ab5187c62f9c8a864f07dd907e79f39769fb4d108b70`. 같은 디렉터리의 `.exe.sha256` 파일에도 기록했다.

## v0.4 대비 변경

- 제거기에 **개인 학습 기록·PDF 사본도 삭제** 선택 칸을 추가했다. 기본값은 선택 안 함(기록 보존)이다. 무인 제거는 `/DELETEDATA`를 줄 때만 기록을 지운다.
- 앱이 실행 중이면 제거기가 아무것도 지우지 않고 종료 안내를 띄운 뒤 종료 코드 3으로 멈춘다. 실행 중인 `node.exe`에 쓰기 열기가 실패하는지로 판단한다.
- 버전 표기를 `package.json` 한 곳에서 읽어 설치파일 이름·등록 정보에 넣는다.
- 빌드가 Git Bash의 GNU tar 대신 `System32\tar.exe`를 쓰도록 고정했다. GNU tar는 `H:\...` 경로를 원격 호스트로 해석해 빌드가 실패했다.
- 깨끗한 Windows 시험용 `npm run test:sandbox`(`scripts/run-sandbox.mjs`, `scripts/sandbox-run.ps1`)를 추가했다.
- 주간 예측 웹 테스트 2건이 `2026-09-23` 고정 날짜를 써서 날짜가 지나면 실패했다. 앱은 오늘 이전 날짜를 예측에서 빼는 것이 의도된 동작이므로, 테스트가 실행일 기준 오늘·내일을 쓰도록 고쳤다.

## 실행한 확인

| 항목 | 실행한 확인 | 결과와 경계 |
|---|---|---|
| 빌드 | `npm run build:installer` | 고정 SHA-256 압축파일 네 개 확인, NSIS 경고·오류 출력 없음 |
| 기록 보존 제거 | 임시 폴더 설치 → `node scripts/smoke-installer.mjs <설치 폴더> --uninstall` | 반입·5분 기록·재시작 통과, 실행 중 제거 거부(종료 코드 3), 제거 후 설치 폴더·바로가기·등록 정보 삭제, 기록 보존 |
| 기록 삭제 제거 | 실제 `%LOCALAPPDATA%\ChallengeMaster`가 없는 것을 확인한 뒤 설치 → `--uninstall-delete-data` | 위와 같은 흐름 통과, `/DELETEDATA` 제거 뒤 기록 폴더 삭제 확인 |
| 로컬 회귀 | `npm test`, `npm run check`, `git diff --check` | 97 pass/0 fail, 23개 JavaScript 모듈 구문·공백 통과 |

기록 삭제 시험은 실제 사용자 데이터 위치를 쓴다. 그래서 시험 스크립트는 그 폴더가 이미 있으면 시작하지 않는다. 일회용 샌드박스(`CHALLENGE_MASTER_DISPOSABLE_VM=1`)에서만 이 보호를 풀어 준다.

## 남은 검증

- 깨끗한 Windows 샌드박스 시험(L16): **NOT RUN**. 이 PC(Windows 11 Pro 빌드 26200)에서 Windows 샌드박스 기능이 꺼져 있다. 기능을 켜고 재시작한 뒤 `npm run test:sandbox`로 실행한다.
- 제거 화면의 선택 칸을 눈으로 확인하는 시험: **NOT RUN**. 무인 모드 세 경우만 자동으로 확인했다.
- 코드 서명: **없음**(D016에 따라 시범판은 서명하지 않음). 스마트 앱 컨트롤이 켜진 PC에서의 차단 여부는 실제로 시험하지 않았다.
- 스캔 OCR, 복잡한 표·수식, 실제 교재 충실도, 학생 사용성, LLM 계정 연결·학습효과: **NOT RUN**.

K01–K25의 제품 전체 시나리오 통과를 이 기록으로 주장하지 않는다.
