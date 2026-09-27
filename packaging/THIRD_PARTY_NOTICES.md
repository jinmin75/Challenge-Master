# 포함된 실행 환경과 라이선스

Challenge Master의 Windows 설치파일과 macOS 앱은 다음 구성요소를 앱 전용 폴더에 포함한다. 각 원문의 라이선스 파일도 함께 둔다.

- Node.js 24.21.0 LTS: MIT 및 포함된 제3자 고지. Windows는 `runtime/node/LICENSE`, macOS는 `Contents/Resources/runtime/node-arm64/LICENSE`·`node-x64/LICENSE`.
- pdf.js(`pdfjs-dist`) 6.3.289: Apache License 2.0. `app/node_modules/pdfjs-dist/LICENSE`. PDF 글자 추출에만 쓰며, 포함한 문자 코드표(CMap)와 표준 글꼴 데이터도 이 패키지에 딸린 것이다.
- NSIS 3.12(Windows만): zlib/libpng 및 포함된 압축기 라이선스. 설치파일 생성 도구이며 학습 자료나 답안을 수집하지 않는다.

빌드 입력 URL과 SHA-256은 `scripts/build-installer.mjs`와 `scripts/build-macos.mjs`에, pdf.js 버전은 `package.json`과 `package-lock.json`에 고정한다. v0.5까지 포함했던 Python과 pypdf는 v0.6부터 포함하지 않는다.
