# Tasks for packaging the extension. Run `just` to list them.

# Run recipes with PowerShell, since `sh` usually isn't on the PATH on
# Windows. (On just 1.2+ this could be `set windows-shell` instead, which
# would leave other platforms on their default shell.)
set shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

# Files that are in the repo but don't belong in the packaged extension.
ignored := '"vendor" "vendor/**" "web-ext-artifacts" "web-ext-artifacts/**" "test" "test/**" "tools" "tools/**" "screenshots" "screenshots/**" "README.md" "Justfile" "package.json" "package-lock.json"'

# List the available recipes.
default:
    @just --list

# Package the extension into web-ext-artifacts/ for addons.mozilla.org.
build: _check-package-unlocked icons
    npx web-ext build --overwrite-dest --ignore-files {{ignored}}

# Render icons/icon.svg to the icons/icon-<size>.png files the manifest lists.
icons:
    npm install --no-audit --no-fund
    node tools/build-icons.mjs

# On Windows, a browser that has the package loaded as a temporary add-on
# keeps the file open, and the build then fails with an unhelpful
# "UNKNOWN: unknown error, open ...zip". Say what is actually wrong.
_check-package-unlocked:
    @foreach ($f in Get-ChildItem web-ext-artifacts -Filter *.zip -ErrorAction SilentlyContinue) { try { [IO.File]::Open($f.FullName, 'Open', 'ReadWrite', 'None').Close() } catch { Write-Host "Cannot rebuild: $($f.Name) is open in another program, most likely a browser that has it loaded as a temporary add-on. Remove it under about:debugging (This Firefox / This Zen), then run 'just build' again."; exit 1 } }

# Run the integration tests headless in a real browser (throwaway profile).
test: _test-setup
    node --test test/integration.test.mjs

# Like `test`, but with a visible browser window so you can watch it run.
test-headful: _test-setup
    $env:HEADFUL = '1'; node --test test/integration.test.mjs

# Write screenshots of the popup and options page to screenshots/.
screenshots: _test-setup
    node test/screenshots.mjs

# Builds a separate copy of the package for the tests, so a copy loaded in
# your own browser can't lock the file, and installs the test dependencies.
_test-setup: icons
    npx web-ext build --overwrite-dest --artifacts-dir web-ext-artifacts/test --ignore-files {{ignored}}

# Run the same checks addons.mozilla.org runs on upload.
lint:
    npx web-ext lint --ignore-files {{ignored}}
