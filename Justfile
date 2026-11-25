# Tasks for packaging the extension. Run `just` to list them.

# Run recipes with PowerShell, since `sh` usually isn't on the PATH on
# Windows. (On just 1.2+ this could be `set windows-shell` instead, which
# would leave other platforms on their default shell.)
set shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

# Files that are in the repo but don't belong in the packaged extension.
ignored := '"vendor" "vendor/**" "README.md" "Justfile"'

# List the available recipes.
default:
    @just --list

# Package the extension into web-ext-artifacts/ for addons.mozilla.org.
build:
    npx web-ext build --overwrite-dest --ignore-files {{ignored}}

# Run the same checks addons.mozilla.org runs on upload.
lint:
    npx web-ext lint --ignore-files {{ignored}}
