# 포함된 실행 환경과 라이선스

Challenge Master 설치파일은 다음 실행 환경을 앱 전용 폴더에 포함한다. 각 원문의 라이선스 파일도 설치본 `runtime` 아래에 둔다.

- Node.js 24.21.0 LTS: MIT 및 포함된 제3자 고지. `runtime/node/LICENSE`.
- Python 3.14.7 embeddable: Python Software Foundation License. `runtime/python/LICENSE.txt`.
- pypdf 6.17.0: BSD 3-Clause. `runtime/python/Lib/site-packages/pypdf-6.17.0.dist-info/licenses/LICENSE`.
- NSIS 3.12: zlib/libpng 및 포함된 압축기 라이선스. 설치파일 생성 도구이며 학습 자료나 답안을 수집하지 않는다.

빌드 입력 URL과 SHA-256은 `scripts/build-installer.mjs`에 고정한다. 배포 전에는 서명과 깨끗한 Windows 환경의 설치·제거 검증을 별도로 기록한다.
