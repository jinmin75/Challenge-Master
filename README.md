# Challenge Master

한국교원대학교 학생의 대한민국 중등교사 임용시험 준비를 돕는 개인 학습 가이드 프로젝트다.

학생이 보유 자료와 학습 범위를 정하면, 자신의 LLM 계정과 개인 Wiki를 이용해 공부할 방향을 잡고 연속 학습·답안 연습·교정을 진행한다. 학습 기록을 남기고 가용 시간 안에서 다음 일정을 조정하는 시스템을 목표로 한다.

**현재 상태: 설계 v4.2 + Windows 시험 설치본 v0.4.** 실제 PDF의 선택 페이지에서 텍스트 초안을 만들고, 로컬 화면에서 계획·공부 시간·주간 예측을 사용할 수 있다. 설치본은 앱 전용 Node.js·Python·pypdf를 포함하며 이 PC에서 설치·반입·재시작·제거를 확인했다. 깨끗한 Windows PC, 코드 서명, 스캔 OCR·LLM 계정 연결, 실제 학생 사용성과 학습효과는 아직 검증하지 않았다.

## Windows 설치본

`dist/Challenge-Master-Setup-0.4.0-win-x64.exe`가 시험용 설치파일이다. 설치하면 시작 메뉴의 **Challenge Master**로 연다. 학생이 Node.js나 Python을 따로 설치할 필요는 없다. 첫 화면에서 PDF, 추출할 시작·끝 페이지, 공부할 일과 가용 시간을 입력한다. 추출된 텍스트는 **원본 대조 필요** 상태로 남으며 검토 없이 학습 성과로 표시되지 않는다. 앱 화면의 **앱 종료**로 로컬 서버를 닫는다.

학습 기록과 PDF 원본·추출 초안은 `%LOCALAPPDATA%\ChallengeMaster`에 평문으로 저장한다. 앱 제거는 이 개인 기록을 보존한다. 앱이나 폴더를 공유하기 전에 자신의 PDF와 학습 기록이 포함됐는지 확인해야 한다. 설치본은 현재 서명되지 않았고, 깨끗한 Windows 환경의 배포 검증은 남아 있다. 배포 판단은 [설치파일 배포 조건](docs/distribution.md)과 [v0.4 검증 기록](docs/verification-v0.4.md)을 따른다.

개발자가 Windows x64에서 설치파일을 다시 만들려면 `npm run build:installer`를 실행한다. 빌드는 공식 Node.js·Python·pypdf·NSIS 배포물을 고정한 SHA-256으로 확인한 뒤 앱 전용 런타임을 묶는다. 생성물과 다운로드 캐시는 Git에서 제외한다.

## 로컬 실행

개발 실행에는 Node.js 22 이상이 필요하다. PDF 텍스트 추출에는 Python 3과 `pypdf`가 추가로 필요하다. 이번 개발 환경은 Node.js 25.6.1, Python 3.12, pypdf 6.17.0이다. 설치본은 별도의 앱 전용 런타임을 사용한다. 계정 인증과 외부 모델 호출은 현재 흐름에 없다.

```sh
npm test
npm run check
npm run demo
```

데모는 합성 과업의 60분 계획과 일부 페이지만 준비된 자료 상태를 출력한다. 데모 명령 자체는 실제 PDF를 읽거나 모델을 호출하지 않는다.

로컬 화면은 `node src/web.mjs`로 열고, 표시된 `127.0.0.1` 주소에서 확인한다. 첫 화면의 기본 입력은 합성 자료이며 PDF와 공부 범위를 등록하면 로컬 설정으로 바뀐다. 개발자는 `CHALLENGE_MASTER_INPUT` 환경 변수에 로컬 과업 JSON 경로를 지정할 수 있다. 기록은 기본적으로 `private/study-web.json`에 평문으로 저장된다. `CHALLENGE_MASTER_DATA_DIR`을 지정하면 웹 기록과 PDF 반입 기본 저장 위치를 그 폴더로 바꾼다.

텍스트 PDF 반입은 `node src/cli.mjs pdf <source.pdf> <metadata.json>`으로 실행한다. metadata에는 `sourceId`, `title`, `edition`, 1부터 시작하는 `selectedPages` 배열을 넣는다. 결과는 Git에서 제외된 `private/ingest/` 아래의 `manifest.json`, `draft.md`, `review-template.json`이다. 초안은 원본 대조 전까지 학습 근거로 쓰지 않는다. 원본과 대조한 검토자가 템플릿 사본의 확인 필드를 채운 뒤 `node src/cli.mjs pdf-review <out-dir> <source.pdf> <review.json>`을 실행하면 확인된 페이지만 `faithful.md`에 기록된다. 그림·스캔·표·수식의 자동 충실 변환은 아직 지원하지 않는다.

주간 예측은 `node src/cli.mjs week <input.json> [--store private/study.json]`으로 확인할 수 있고, 로컬 화면에서는 저장 기록이 바뀔 때 다시 계산한다. 미래 배정은 예정이며 완료나 숙달을 뜻하지 않는다.

로컬 저장·재시작 확인:

```sh
node src/cli.mjs plan fixtures/synthetic-plan.json --store private/study.json
node src/cli.mjs status --store private/study.json
```

첫 계획은 `plan`, 같은 저장 파일의 다음 계획은 `replan`으로 만든다. 새 계획을 저장하면 버전이 증가하고 이전 계획이 남는다. 완료한 분량을 반영하려면 명시적인 완료 기록을 저장한 뒤 `replan`을 실행한다. 오류로 중단된 작업은 저장 성공으로 표시하지 않는다. 기록·입력 형식과 현재 한계는 [개발용 CLI 안내](docs/local-core.md)를 따른다. 현재 저장 파일은 암호화되지 않은 평문이다. 학생 실자료를 넣지 말고 합성 자료로 검증한다.

## 문서

- [제품 요구사항](docs/prd.md): 현재 합의한 기능과 범위
- [검증 명세](docs/test-spec.md): 구현 후 확인할 정상·실패·권한 시나리오
- [결정 기록](docs/decisions.md): 대화에서 확정한 변경과 반영 위치
- [작업 상태](docs/status.md): 문서 반영·구현·실행 검증의 구분
- [향후 확장](docs/expansion-backlog.md): 다른 공적 시험과 상용화 보류 항목
- [작업 규칙](AGENTS.md): 대화 반영과 공개 저장소 보호
- [첫 구현 범위](docs/implementation-v0.1.md): 모듈별 범위와 제외 항목
- [설치파일 배포 조건](docs/distribution.md): 학생 제공 형태와 실제 설치 검증 기준

## 기본 학습 흐름

자료와 범위 지정 → PDF를 충실한 MD로 변환·검증 → 개인 Wiki 반입 → 오늘의 학습 묶음 → 수행 확인·교정 → 기록·일정 조정.

중간 변환 작업을 학생의 수동 과제로 돌리지 않는다. 모든 활동을 한 문제씩 끊지 않고 교재 범위·여러 문항·통합 답안 단위로 진행한다. 자료 반입 완료와 학생의 학습 완료는 구분한다.

## 공개 범위

이 저장소에는 프로젝트 설계, 검증 명세, 로컬 코어 코드와 합성 테스트를 저장한다. 수험서 원문, 학생 답안·개인 기록, 개인 볼트, 계정 인증정보는 올리지 않는다. 공개 저장소에 있다는 이유로 제3자 자료의 이용 권한이 생기지 않는다.
