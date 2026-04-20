#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Build the public deploy bundle for heritage-map.

- Reads the latest 世界遺産_地図.html and クイズ.html from ../世界遺産検定/
- Injects:
    1. A password-gate check at the top of <head>
    2. PWA manifest + apple meta tags
    3. Mobile behavior patches (別ウィンドウ → 別タブ)
- Hashes the password with SHA-256 and embeds the hash in index.html
- Writes:
    heritage-map/map.html
    heritage-map/quiz.html
    heritage-map/index.html (rewritten from template with hashed password)

Usage:
    python deploy.py                       # uses default password 'sekaken2026'
    python deploy.py --password 'your-pw'  # override
    python deploy.py --password-file pw.txt
"""

import argparse
import hashlib
import os
import re
import secrets
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.normpath(os.path.join(HERE, '..', '世界遺産検定'))
SRC_MAP = os.path.join(SRC_DIR, '世界遺産_地図.html')
SRC_QUIZ = os.path.join(SRC_DIR, 'クイズ.html')
SRC_SYNC = os.path.join(SRC_DIR, 'sync.js')

OUT_MAP = os.path.join(HERE, 'map.html')
OUT_QUIZ = os.path.join(HERE, 'quiz.html')
OUT_SYNC = os.path.join(HERE, 'sync.js')
GATE_TEMPLATE = os.path.join(HERE, 'index.html')  # also the output

DEFAULT_PASSWORD = 'sekaken2026'

GATE_TOKEN = secrets.token_hex(8)

GATE_CHECK_SNIPPET = """<script>
// Password gate: redirect to login if the session token is missing.
// The hash below is compared in index.html; this script only checks the
// presence of the post-login token.
(function() {
  var GATE_KEY = 'heritage_map_gate_v1';
  var EXPECTED = '__GATE_TOKEN__';
  try {
    if (localStorage.getItem(GATE_KEY) !== EXPECTED) {
      location.replace('index.html');
    }
  } catch (e) {
    location.replace('index.html');
  }
})();
</script>
"""

MOBILE_PATCH = """<script>
// Mobile adjustments injected at deploy time:
//   1. Replace window.open('popup') with a plain new-tab open so iOS
//      Safari / Android Chrome handle it correctly (no popup features).
//   2. YouTube links continue to use the canonical youtube.com URL so
//      the mobile OS offers to open them in the YouTube app.
(function() {
  function isMobile() {
    return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
        || (window.matchMedia && window.matchMedia('(max-width: 900px)').matches);
  }
  if (!isMobile()) return;
  var _open = window.open;
  window.open = function(url, name, features) {
    // On mobile, always open as a new tab (ignore popup features).
    return _open.call(window, url, '_blank');
  };
})();
</script>
"""

PWA_HEAD = """<link rel="manifest" href="manifest.json">
<link rel="apple-touch-icon" href="icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="世界遺産">
<meta name="robots" content="noindex,nofollow">
"""


def sha256_hex(s):
    return hashlib.sha256(s.encode('utf-8')).hexdigest()


def inject_into_html(src_path, out_path, gate_snippet):
    with open(src_path, 'r', encoding='utf-8') as f:
        html = f.read()

    # Insert gate + mobile patch + PWA head right after <head>.
    # The gate runs first so unauthenticated visitors are redirected
    # before any content script executes.
    head_open_m = re.search(r'<head[^>]*>', html)
    if not head_open_m:
        raise RuntimeError(f'<head> tag not found in {src_path}')
    insert_at = head_open_m.end()
    patched = (
        html[:insert_at]
        + '\n'
        + gate_snippet
        + PWA_HEAD
        + MOBILE_PATCH
        + html[insert_at:]
    )

    # Quiz references map via relative links; normalise file names so
    # "クイズ.html" on the source side maps to "quiz.html" on the deploy.
    patched = patched.replace("'クイズ.html?h=", "'quiz.html?h=")
    patched = patched.replace('"クイズ.html?h=', '"quiz.html?h=')
    patched = patched.replace('クイズ.html?', 'quiz.html?')

    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(patched)


def build_gate(password):
    """Rewrite index.html with hashed password and gate token."""
    # Read the existing gate template at HERE. The first time this runs
    # the file contains placeholders; subsequent runs will already have a
    # hash baked in — we still rewrite it with the new one.
    with open(GATE_TEMPLATE, 'r', encoding='utf-8') as f:
        html = f.read()
    pw_hash = sha256_hex(password)
    # Replace placeholders OR previous baked-in values.
    html = re.sub(r"var PASSWORD_SHA256 = '[^']*';",
                  f"var PASSWORD_SHA256 = '{pw_hash}';", html)
    html = re.sub(r"var EXPECTED_TOKEN = '[^']*';",
                  f"var EXPECTED_TOKEN = '{GATE_TOKEN}';", html)
    with open(GATE_TEMPLATE, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f'  index.html   : password-hash embedded (SHA-256)')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--password', default=None,
                    help=f'Gate password (default: {DEFAULT_PASSWORD})')
    ap.add_argument('--password-file', default=None,
                    help='Read password from a file (first line)')
    args = ap.parse_args()

    if args.password_file:
        with open(args.password_file, 'r', encoding='utf-8') as f:
            password = f.readline().strip()
    elif args.password:
        password = args.password
    else:
        password = DEFAULT_PASSWORD

    if not password:
        print('ERROR: empty password')
        sys.exit(1)

    print(f'Source: {SRC_DIR}')
    if not os.path.exists(SRC_MAP):
        print(f'ERROR: {SRC_MAP} not found; run generate_map.py first')
        sys.exit(1)
    if not os.path.exists(SRC_QUIZ):
        print(f'ERROR: {SRC_QUIZ} not found; run generate_map.py first')
        sys.exit(1)

    gate = GATE_CHECK_SNIPPET.replace('__GATE_TOKEN__', GATE_TOKEN)
    inject_into_html(SRC_MAP, OUT_MAP, gate)
    print(f'  map.html     : {os.path.getsize(OUT_MAP):,} bytes')
    inject_into_html(SRC_QUIZ, OUT_QUIZ, gate)
    print(f'  quiz.html    : {os.path.getsize(OUT_QUIZ):,} bytes')
    build_gate(password)

    if os.path.exists(SRC_SYNC):
        shutil.copyfile(SRC_SYNC, OUT_SYNC)
        print(f'  sync.js      : {os.path.getsize(OUT_SYNC):,} bytes (Gist sync)')
    else:
        print(f'  [warn] {SRC_SYNC} not found; Gist sync will not work')

    print()
    print(f'Password is: "{password}"')
    print(f'Gate token : {GATE_TOKEN}')
    print()
    print('Next:')
    print('  cd heritage-map')
    print('  git add -A && git commit -m "Deploy update"')
    print('  git push')


if __name__ == '__main__':
    main()
