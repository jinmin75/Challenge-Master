# 개발용 로컬 코어 사용법

현재 CLI는 개발자 검증용이다. 학생에게 JSON을 직접 작성하게 하는 최종 사용 흐름으로 채택하지 않는다. 외부 전송·LLM 호출·과금·알림 예약은 없다.

## 오늘 계획

`node src/cli.mjs plan fixtures/synthetic-plan.json --store private/study.json`

입력 JSON은 날짜, 가용 분, 과업 배열을 포함한다. 과업은 id, title, kind(new/review), minutes를 갖는다. 분할해도 학습 의미가 유지되는 과업에만 splittable:true를 설정한다. 기본값은 분할 불가다. prerequisites는 완료가 확인된 과업 ID와 대조하며, ready:false인 과업은 배정하지 않는다.

remainingStudyMinutes는 시험 전 전체 가용 시간을 외부에서 확인해 전달하는 값이다. 값이 없으면 준비 범위 상태는 unknown이다. 시스템이 시험 일정이나 학습 가능 시간을 임의로 추정하지 않는다. within_time도 입력한 과업 시간 합계가 예산 이내라는 뜻이며 합격 가능성이나 선행 조건 해결을 보증하지 않는다.

일정 결과의 deferred는 남은 과업이며 자동 삭제하지 않는다. 이번 버전에서는 분할 과업의 수행 결과를 토대로 다음 입력의 잔여 분량을 자동 산정하지 않는다. 주간 일정·오류 묶음 자동 병합도 아직 없다.

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

저장 파일은 최대 5 MiB의 평문 이벤트 기록이다. 동시 쓰기는 잠금으로 막고, 임시 파일을 완성한 뒤 교체한다. 손상된 파일을 빈 기록으로 초기화하지 않는다. 비정상 종료 후 잠금이 남으면 새 쓰기는 실패한다. 자동으로 잠금을 지우지 않으며, 실행 중인 작성자가 없는지 확인하는 복구 기능은 후속 구현이다. 운영체제·동기화 드라이브 장애나 다른 프로그램의 파일 변경까지 막는 데이터베이스는 아니다.

## 자료 반입 계약

src/ingest.mjs는 변환 결과를 받는 모듈이다. 실제 PDF 판독기는 없고, 데모는 합성 Markdown을 직접 전달한다. 원본 SHA-256은 64자리 16진수이며 실제 파일 해시 계산·비교는 후속 변환기 책임이다. 페이지는 1부터 시작하며 선택 목록은 중복 없이 오름차순이다.

structureChecked/sourceCompared는 검증 도구가 전달할 결과 필드다. 이 값이 true라는 사실만으로 현재 모듈이 원문을 직접 대조했다는 뜻은 아니다. 향후 모델이 이 값을 임의로 자기승인하지 못하도록 검증 경로를 분리해야 한다. 생성된 MD는 신뢰하지 않는 원문 데이터이며 화면에서 HTML로 렌더링할 때는 별도 안전 처리가 필요하다.

canTransmit는 외부 전송 전 조건을 계산할 뿐 전송 기능이 아니다. 동의 시각은 UTC ISO 형식(예: 2026-09-22T01:00:00.000Z)을 사용한다. 자료 권리, 제공자, 자료, 작업 범위, 철회를 모두 검사한다. 실제 제공자 연동과 처리 이력·삭제 확인은 미구현이다.
