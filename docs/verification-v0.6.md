# Windows·macOS 시범판 v0.6 검증 기록

검증일: `2026-09-27`. 대상은 합성 PDF와 v0.6.0 산출물이다. 학생 교재·계정은 사용하지 않았다. 근거 결정은 [D018](decisions.md)이다.

| 산출물 | 크기 | SHA-256 |
|---|---|---|
| `dist/Challenge-Master-Setup-0.6.0-win-x64.exe` (이 PC에서 빌드) | 25,394,960바이트 | `2396a0ec33c5c070c342e213a31b45719a2d662b5c68a4ae3ead4b6bfdad3f2a` |
| `Challenge-Master-0.6.0-macos.zip` (GitHub Actions 실행 36302307868에서 빌드) | 82,886,482바이트 | `3b1fcc13f12f273e91031301f5ae700d8dbb79bbeffcb8f25dd4ccdf1f2ca043` |

맥 압축파일은 GitHub에서 내려받은 뒤 이 PC에서 해시를 다시 계산해 빌드 기록의 값과 같음을 확인했다.

## v0.5 대비 변경

- PDF 글자 추출을 Python·pypdf에서 pdf.js(`pdfjs-dist` 6.3.289, Apache-2.0)로 바꿨다. 변환 버전 표기는 `pdfjs-text-v1`이다. 추출은 별도 Node 프로세스(`src/pdf-extract.mjs`)에서 V8 힙 512MB 상한과 60초 제한으로 돈다. v0.5의 Python 추출기는 운영체제 수준(Windows 작업 개체, POSIX `RLIMIT_AS`)으로 프로세스 전체 메모리를 제한했지만, 새 상한은 JavaScript 힙에만 걸린다. 암호가 걸린 PDF는 이전처럼 모두 거부한다. 쪽 번호표(page label)가 있는 PDF는 인쇄된 쪽 번호를 기록한다.
- 한국어 PDF에 필요한 문자 코드표(CMap)와 표준 글꼴 데이터를 함께 묶는다. 볼트의 실제 한국어 PDF 두 개로 시제품을 돌려 한국어 줄이 나오는 것을 확인했다. 추출 결과는 저장하지 않았다.
- 글자가 없는 쪽(스캔·빈 쪽)은 등록할 때 `textlessPages`로 저장하고, 화면에 `글자 없음(스캔 또는 빈 쪽)`으로 표시한다. v0.5까지는 이런 쪽이 `추출 초안`으로 보이는 결함이 있었다. v0.6 이전에 저장된 설정은 이 목록이 없어 기존 표시를 유지한다.
- 데이터 폴더와 브라우저 열기를 운영체제별로 나눴다(`src/platform.mjs`). Windows는 `%LOCALAPPDATA%\ChallengeMaster`(변경 없음), macOS는 `~/Library/Application Support/ChallengeMaster`다.
- 저장소 경로 검사가 macOS의 `/var`·`/tmp`(root 소유 시스템 링크)를 거부해 macOS에서 기록을 쓸 수 없었다. 첫 CI 실행에서 발견해, Windows 밖에서는 root 소유 링크만 허용하도록 고쳤다. 사용자가 만든 링크는 계속 거부한다.
- 설치파일에서 Python 런타임을 뺐다. Windows 설치파일이 34.7MB에서 25.4MB로 줄었다.
- macOS 앱: `Challenge Master.app` 하나에 Apple Silicon·Intel용 Node 24.21.0을 모두 넣고, 실행기가 CPU에 맞는 쪽을 고른다. 실행기는 서버를 뒤에서 띄우고 끝난다. 앱은 서명·공증하지 않았다. `Info.plist`의 최소 macOS는 Node.js 24의 지원 하한인 13.5다.
- 이 PC의 구글 드라이브 폴더에서 `npm install`을 하면 파일 대부분이 0바이트로 써진다(두 번 재현). 그래서 패키징 단계가 0바이트 파일을 거부하게 했다.

## 실행한 확인

| 항목 | 환경 | 결과 |
|---|---|---|
| 단위 테스트 | 이 PC(Windows), GitHub의 ubuntu-latest·windows-latest·macos-latest | 102/102 통과(이 PC), CI 세 운영체제 통과 |
| 추출기 | 이 PC | 영어·한글(ToUnicode) 추출, 빈 쪽, 이미지만 있는 쪽(글자 없음·이미지 1개), 범위 밖·정렬 오류·PDF 아님 거부 |
| Windows 설치본 | 이 PC 임시 설치 | 기록 보존 제거·기록 삭제 제거·실행 중 제거 거부 통과. Python 런타임 폴더 없음 확인 |
| Windows 설치본 | Windows 샌드박스(Windows 11 Enterprise 10.0.26100, node·python 없음, 네트워크 끔) | 두 흐름 모두 통과 |
| macOS 앱 | GitHub macos-latest(이미지 macos-26-arm64, `uname -m` arm64) | 압축 해제, 실행 권한, `Info.plist` 검사, 실행기로 PDF 반입·5분 기록·재시작 후 유지, `open` 명령으로 실행 후 서버 동작·종료 통과 |
| macOS 앱 | GitHub macos-15-intel(이미지 macos-15, `uname -m` x86_64) | 같은 압축파일로 같은 시험 통과 |
| Gatekeeper 판정 | 위 두 macOS 환경의 `spctl --assess --type execute` | 두 곳 모두 `rejected`, `source=no usable signature` |

Gatekeeper 판정은 서명이 없다는 사실만 보여 준다. 시험 환경의 파일에는 인터넷에서 받았다는 표시(quarantine)가 없으므로, 학생이 드라이브 링크로 받은 앱을 처음 열 때의 화면과 같다고 보지 않는다.

## 남은 검증

- 실제 Mac에서 학생이 드라이브 링크로 받아 압축을 풀고 처음 허용하는 과정: **NOT RUN**. 운영자에게 Mac이 없어 첫 Mac 참여자의 첫 사용에서 관찰한다.
- macOS 13.5~14 환경: **NOT RUN**. CI는 macOS 15와 26에서만 돌았다.
- Windows 경고 화면, 제거 화면 육안 확인, 제거 후 재설치 시 기록 복원: **NOT RUN**.
- owner 암호만 걸린 PDF의 거부, 대용량 PDF에서의 메모리 상한 동작: **NOT RUN**.
- 스캔 OCR, 실제 교재 충실도, 학생 사용성, LLM 계정 연결·학습효과: **NOT RUN**.

K01–K25의 제품 전체 시나리오 통과를 이 기록으로 주장하지 않는다.
