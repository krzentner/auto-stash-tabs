# Tasks for packaging the extension. Run `just` to list them.

# Run recipes with PowerShell, since `sh` usually isn't on the PATH on
# Windows. (On just 1.2+ this could be `set windows-shell` instead, which
# would leave other platforms on their default shell.)
set shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

# Files that are in the repo but don't belong in the packaged extension.
ignored := '"vendor" "vendor/**" "web-ext-artifacts" "web-ext-artifacts/**" "test" "test/**" "README.md" "Justfile" "package.json" "package-lock.json"'

# List the available recipes.
default:
    @just --list

# Package the extension into web-ext-artifacts/ for addons.mozilla.org.
build:
    npx web-ext build --overwrite-dest --ignore-files {{ignored}}

# Run the integration tests headless in a real browser (throwaway profile).
test: _test-setup
    node --test test/integration.test.mjs

# Like `test`, but with a visible browser window so you can watch it run.
test-headful: _test-setup
    $env:HEADFUL = '1'; node --test test/integration.test.mjs

# Builds a separate copy of the package for the tests, so a copy loaded in
# your own browser can't lock the file, and installs the test dependencies.
_test-setup:
    npx web-ext build --overwrite-dest --artifacts-dir web-ext-artifacts/test --ignore-files {{ignored}}
    npm install --no-audit --no-fund

# Run the same checks addons.mozilla.org runs on upload.
lint:
    npx web-ext lint --ignore-files {{ignored}}
