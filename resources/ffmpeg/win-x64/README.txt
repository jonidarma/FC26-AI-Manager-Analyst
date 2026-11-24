FC26 AI Manager — Windows x64 Bundled FFmpeg Resource Directory
===============================================================

Place verified Windows x64 binaries in this directory before running:
  npm run electron:dist:win

Required files (copied to `<installDir>/resources/ffmpeg/` by electron-builder):
  - ffmpeg.exe
  - ffprobe.exe
  - LICENSE.txt (from the chosen FFmpeg release build)

Recommended build-time staging command:
  npm run prepare:ffmpeg:win64 -- --from-dir "C:\path\to\ffmpeg\bin"

Verification command:
  npm run prepare:ffmpeg:win64 -- --verify

Do NOT commit large binaries into git. See docs/FFMPEG_LICENSING_AND_PACKAGING.md for
pinned build provenance, required codecs, and GPLv3 / LGPLv2.1 licensing obligations.
