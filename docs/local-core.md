# 개발용 로컬 코어 사용법

현재 CLI는 개발자 검증용이다. 학생에게 JSON을 직접 작성하게 하는 최종 사용 흐름으로 채택하지 않는다. 외부 전송·LLM 호출·과금·알림 예약은 없다. 학생 제공 형태는 Windows 설치파일이며, 현재 개발용 실행을 설치 완료로 보지 않는다.

## 오늘 계획

`node src/cli.mjs plan fixtures/synthetic-plan.json --store private/study.json`

입력 JSON은 날짜, 가용 분, 과업 배열을 포함한다. 과업은 id, title, kind(new/review), minutes를 갖는다. 분할해도 학습 의미가 유지되는 과업에만 splittable:true를 설정한다. 기본값은 분할 불가다. prerequisites는 완료가 확인된 과업 ID와 대조하며, ready:false인 과업은 배정하지 않는다. 저장형 `plan`에서는 근거가 사라지는 `completedTaskIds` 입력을 받지 않는다.

remainingStudyMinutes는 시험 전 전체 가용 시간을 외부에서 확인해 전달하는 값이다. 값이 없으면 준비 범위 상태는 unknown이다. 시스템이 시험 일정이나 학습 가능 시간을 임의로 추정하지 않는다. within_time도 입력한 과업 시간 합계가 예산 이내라는 뜻이며 합격 가능성이나 선행 조건 해결을 보증하지 않는다.

일정 결과의 deferred는 남은 과업이며 자동 삭제하지 않는다. `replan`은 학생이 완료를 명시적으로 확인한 분량만 다음 계획에서 차감한다. 주간 예측은 아래 명령으로 갱신한다. 오류 묶음 자동 병합은 아직 없다.

nextTwoDaysReviewMinutes를 주면 그 복습 예산과 부채를 비교한다. 값이 없으면 오늘의 일반 복습 예산을 두 배 한 값을 임시 기준으로 사용한다. 향후 이틀의 실제 가용 시간을 읽는 기능은 아직 없으므로 휴일 등이 있으면 호출자가 확인한 예산을 제공해야 한다.

## 기록·복원

`node src/cli.mjs record private/event.json --store private/study.json`

예시 이벤트(합성 데이터):

```json
{
  "id": "synthetic-reading-1",
  "type": "attempt_recorded",
  "at": "2026-09-22T01:00:00.000Z",
  "taskId": "unit1",
  "planVersion": 1,
  "evidenceType": "self_reported_reading",
  "assistanceExposure": "unknown",
  "sourceVersion": null,
  "response": "합성 단원을 종이책에서 읽었다고 보고함"
}
```

같은 ID·내용의 재입력은 한 번만 기록한다. 같은 ID로 다른 내용이 들어오면 오류로 중단한다. observed_attempt와 self_reported_reading을 구별하며 어떤 이벤트도 숙달 확정 점수를 자동 생성하지 않는다.

`node src/cli.mjs status --store private/study.json`으로 재시작 후 복원한 상태를 확인한다. 이 명령은 로컬 기록을 표준 출력에 표시하므로 실제 개인정보를 담은 출력을 공유하지 않는다.

## 완료 분량을 다음 계획에 반영

현재 계획에 배정된 과업을 일부 마쳤다면 다음 이벤트를 `record`로 저장한다. 분 단위는 학습 시간이나 숙달 점수가 아니라, 해당 과업에서 끝낸 것으로 학생이 확인한 분량이다.

```json
{
  "id": "synthetic-progress-1",
  "type": "task_progress_recorded",
  "at": "2026-09-22T01:00:00.000Z",
  "taskId": "unit1",
  "planVersion": 1,
  "completedMinutes": 8,
  "learnerConfirmed": true
}
```

`node src/cli.mjs replan private/next-input.json --store private/study.json`

다음 입력에는 처음 정한 과업 ID와 **원래 예상 분량**을 다시 넣는다. 전부 완료한 과업도 같은 ID와 원래 분량을 계속 넣어야 선행관계를 확인할 수 있다. 이전 계획에 배정됐거나 미배정으로 남은 과업을 빼면 재계획은 실패한다. 기존 과업의 분량이 처음 등장한 계획의 값과 다르면 이중 차감 위험이 있어 명령이 실패한다. 새 과업은 추가할 수 있다. 새 계획의 날짜·가용 시간·남은 전체 학습 가능 시간은 호출자가 확인해 입력해야 한다. `replan`은 저장소 잠금을 잡은 뒤 최신 완료 기록을 읽어 계획을 만든다. `completedTaskIds`를 재계획 입력에 넣으면 명령이 실패한다. 저장형 `plan`은 첫 계획에서만 사용할 수 있고 이후에는 완료 기록이 없어도 `replan`을 사용해야 한다. `record`로 `plan_created` 이벤트를 직접 저장할 수도 없다. 과업 범위·원래 예상 분량을 명시적으로 바꾸는 기능은 아직 없다.

완료 기록은 당시 계획에 배정된 분량 이내에서만 받는다. 이전 계획에 대한 늦은 완료 기록은 거부한다. 읽었다는 자기보고, 미응답, 미수행 확인은 완료 분량으로 바꾸지 않는다. 과업의 원래 분량을 모두 마치면 다음 과업의 선행 조건을 풀 수 있지만, 그 사실만으로 개념 숙달이나 시험 준비도를 확정하지 않는다.

저장 파일은 최대 5 MiB의 평문 이벤트 기록이다. 동시 쓰기는 잠금으로 막고, 임시 파일을 완성한 뒤 교체한다. 손상된 파일을 빈 기록으로 초기화하지 않는다. 비정상 종료 후 잠금이 남으면 새 쓰기는 실패한다. 자동으로 잠금을 지우지 않으며, 실행 중인 작성자가 없는지 확인하는 복구 기능은 후속 구현이다. 운영체제·동기화 드라이브 장애나 다른 프로그램의 파일 변경까지 막는 데이터베이스는 아니다.

## 자료 반입 계약

`src/ingest.mjs`는 변환 결과 계약이다. `src/pdf.mjs`와 `scripts/pdf_extract.py`가 로컬 PDF의 선택 페이지에서 텍스트를 추출하고 원본 SHA-256을 계산한다. 개발 환경에는 Python 3과 pypdf가 필요하다. 데모 명령은 여전히 합성 Markdown을 사용한다. 페이지는 1부터 시작하며 선택 목록은 중복 없이 오름차순이다.

`node src/cli.mjs pdf <source.pdf> <metadata.json>`은 원본을 읽고 `private/ingest/` 아래에 추출 초안과 검토 템플릿을 저장한다. metadata 예시:

```json
{"sourceId":"my-local-book","title":"자료 제목","edition":"판본 표기","selectedPages":[1,2]}
```

검토자는 원본 PDF와 `draft.md`를 대조한 뒤 `review-template.json`의 사본에서 해당 페이지의 `structureChecked`, `sourceCompared`, `reviewerConfirmed`를 `true`로 바꾼다. `node src/cli.mjs pdf-review <out-dir> <source.pdf> <review.json>`은 원본 해시·변환 버전·추출 초안 해시를 다시 검사하고, 확인된 페이지만 `faithful.md`에 쓴다. 빈/스캔 페이지는 텍스트 추출본만으로 준비 완료로 바뀌지 않는다. 이 명령은 검토자의 판단을 기록하며 육안 대조를 자동 수행했다고 주장하지 않는다.

`structureChecked`와 `sourceCompared`는 검토자가 확인한 결과 필드다. 이 값만으로 독립적인 원문 충실도 검사가 자동 수행된 것은 아니다. 생성된 MD는 신뢰하지 않는 원문 데이터이며 화면에서 HTML로 렌더링할 때는 별도 안전 처리가 필요하다.

canTransmit는 외부 전송 전 조건을 계산할 뿐 전송 기능이 아니다. 동의 시각은 UTC ISO 형식(예: 2026-09-22T01:00:00.000Z)을 사용한다. 자료 권리, 제공자, 자료, 작업 범위, 철회를 모두 검사한다. 실제 제공자 연동과 처리 이력·삭제 확인은 미구현이다.

## 주간 예측과 화면

`node src/cli.mjs week <input.json> --store private/study.json`은 입력의 `days` 배열과 원래 과업 목록, 저장된 확인 기록을 이용한다. 예측 결과의 `tentativeAllocations`는 앞으로 할 예정 분량이다. 확인된 수행 기록과 섞지 않고, 주간 끝에 남는 과업은 `deferredScope`로 남긴다. 기존 계획에 있던 과업이나 원래 분량을 입력에서 바꾸면 오류가 난다. 이 명령은 예측만 출력하고 저장 상태를 바꾸지 않는다.

`node src/web.mjs`는 로컬호스트 화면을 연다. 기본 입력은 합성 데모이고, 실제 로컬 과업 JSON은 `CHALLENGE_MASTER_INPUT` 환경 변수로 지정한다. 화면은 시작·실제 공부 시간 기록·가능 시간 줄이기·오늘 쉬기·선택 과업 스킵을 제공한다. 확인된 분량만 현재 권고에서 즉시 줄이고 다음 계획에 반영한다. 스킵은 같은 계획의 화면 추천에서 빼지만 과업 자체를 완료 처리하지 않는다. 주간 예측도 저장 기록이 바뀌면 다시 계산한다. 화면은 학생 사용성 시험과 설치파일 검증을 아직 거치지 않았다.
