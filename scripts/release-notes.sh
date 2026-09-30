#!/usr/bin/env bash
# Release notes for a version tag, as Markdown: the commits since the previous
# release grouped by kind, and the Docker images built from the tag.
# Used by the release workflow (.github/workflows/release.yml) and release.sh.
#
#   scripts/release-notes.sh v1.2.3 [previous-tag]
set -euo pipefail

tag="${1:?usage: release-notes.sh <tag> [previous-tag]}"
version="${tag#v}"
# The release before: the nearest version tag behind this one.
prev="${2:-$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' "${tag}^" 2>/dev/null || true)}"
range="${prev:+$prev..}$tag"
repo="${GITHUB_REPOSITORY:-simno/homecast}"
image="ghcr.io/$(echo "$repo" | tr '[:upper:]' '[:lower:]')"

# Commit subjects in the release, oldest first, without the release commits.
commits=$(git log --no-merges --reverse --format='%s%x09%h' "$range" | grep -vE '^Release v[0-9]' || true)

# "fix(webos): the thing" -> "The thing"
tidy() {
    local subject
    subject=$(echo "$1" | sed -E 's/^[a-z]+(\([^)]*\))?!?: //')
    echo "$(echo "${subject:0:1}" | tr '[:lower:]' '[:upper:]')${subject:1}"
}

section() { # title, pattern the subject matches, 'invert' to take the rest
    local lines
    if [ "${3:-}" = invert ]; then
        lines=$(echo "$commits" | grep -vE "$2" || true)
    else
        lines=$(echo "$commits" | grep -E "$2" || true)
    fi
    [ -z "$lines" ] && return 0
    printf '### %s\n\n' "$1"
    while IFS=$'\t' read -r subject sha; do
        [ -n "$subject" ] && printf -- '- %s (%s)\n' "$(tidy "$subject")" "$sha"
    done <<< "$lines"
    printf '\n'
}

if [ -z "$commits" ]; then
    printf 'No changes since %s.\n\n' "${prev:-the start}"
else
    section 'Features' '^feat(\(|!|:)'
    section 'Fixes' '^fix(\(|!|:)'
    section 'Other changes' '^(feat|fix)(\(|!|:)' invert
fi

cat <<NOTES
### Docker images

\`\`\`bash
docker pull $image:$version        # full
docker pull $image:$version-lite   # without the headless browser
\`\`\`
NOTES

if [ -n "$prev" ]; then
    printf '\n**Full changelog:** https://github.com/%s/compare/%s...%s\n' "$repo" "$prev" "$tag"
fi
