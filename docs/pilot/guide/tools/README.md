# 학생 가이드 다시 만들기

`../guide-windows.html`과 `../guide-mac.html`은 학생에게 PDF로 배포하는 초보자용 설치·사용 가이드의 원본이다. 두 도구는 저장소 의존성이 아닌 `playwright-core`와 이 PC의 Chrome을 쓴다. 이 폴더(구글 드라이브 폴더가 아닌 로컬 폴더에 복사한 곳)에서 `npm install playwright-core`로 설치해 실행한다.

- `shots.mjs <저장소 경로>`: 임시 기록 폴더로 앱을 띄우고 헤드리스 Chrome으로 화면을 단계별로 찍어 `../shots/`에 저장한다. 같은 폴더에 합성 PDF `../sample.pdf`(글자 2쪽 + 이미지만 있는 1쪽)가 있어야 한다. 찍은 파일은 `../img/`로 옮긴다.
- `shots-calendar.mjs <저장소 경로>`: 날짜를 실행일 기준으로 잡은 합성 기록(5일 전 등록, 기록 2일, 휴식 1일, 기록 없는 2일)으로 앱 서버를 띄워 10절 캘린더 화면 네 장(`s7-*.png`)을 `../shots/`에 찍는다. 화면의 날짜는 찍은 날에 따라 바뀐다.
- `render.mjs guide-windows guide-mac`: 가이드 HTML을 A4 PDF로 만든다. 글꼴은 Paperlogy(CDN)를 쓰므로 인터넷 연결이 필요하다.

Windows 설치·제거 화면(`win-*.png`)은 자동으로 다시 만들 수 없다. 설치 위치 화면은 개발 PC에서 찍은 뒤 사용자 이름을 가렸고, 제거 화면은 Windows 샌드박스에서 찍었다. MCP 브라우저 도구는 화면 배율(150%) 때문에 요소 좌표가 어긋나므로 쓰지 않는다.
