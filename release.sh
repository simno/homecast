#!/bin/bash
set -e

# Release a new version: check, bump, commit, tag, push. The tag starts the
# release workflow (.github/workflows/release.yml), which tests the tag, builds
# and pushes its Docker images, and publishes a GitHub release listing the
# commits since the last one (scripts/release-notes.sh, previewed below).

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

REPO=simno/homecast

# Check if version type is provided
if [ -z "$1" ]; then
    echo -e "${RED}Error: Version type required (patch, minor, or major)${NC}"
    echo "Usage: ./release.sh [patch|minor|major]"
    exit 1
fi

VERSION_TYPE=$1

if [[ ! "$VERSION_TYPE" =~ ^(patch|minor|major)$ ]]; then
    echo -e "${RED}Error: Invalid version type. Must be patch, minor, or major${NC}"
    exit 1
fi

# Get current branch
BRANCH=$(git rev-parse --abbrev-ref HEAD)

if [ "$BRANCH" != "main" ]; then
    echo -e "${YELLOW}Warning: You are not on the main branch (current: $BRANCH)${NC}"
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 1
    fi
fi

# Check for uncommitted changes
if [[ -n $(git status -s) ]]; then
    echo -e "${RED}Error: You have uncommitted changes. Please commit or stash them first.${NC}"
    git status -s
    exit 1
fi

# The release has to sit on top of what's on GitHub, or the push fails
# halfway (the tag would go, the commit wouldn't).
echo -e "${GREEN}Checking origin...${NC}"
git fetch --quiet --tags origin "$BRANCH"
BEHIND=$(git rev-list --count "HEAD..origin/$BRANCH")
if [ "$BEHIND" -gt 0 ]; then
    echo -e "${RED}Error: $BRANCH is $BEHIND commit(s) behind origin/$BRANCH. Pull first.${NC}"
    exit 1
fi

# Something to release: commits since the last version tag, other than releases.
LAST_TAG=$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null || true)
NEW_COMMITS=$(git log --no-merges --format='%s' "${LAST_TAG:+$LAST_TAG..}HEAD" | grep -cvE '^Release v[0-9]' || true)
if [ "$NEW_COMMITS" -eq 0 ]; then
    echo -e "${RED}Error: nothing to release, no commits since ${LAST_TAG}.${NC}"
    exit 1
fi

echo -e "${GREEN}Running checks...${NC}"
npm run check

echo -e "${GREEN}Bumping version ($VERSION_TYPE)...${NC}"
NEW_VERSION=$(npm version $VERSION_TYPE --no-git-tag-version)

# Extract version number without 'v' prefix
VERSION_NUMBER=${NEW_VERSION#v}

# Update version in index.html (BSD sed compatible)
echo -e "${GREEN}Updating version in index.html...${NC}"
sed -i.bak "s/<span class=\"version\">v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*<\/span>/<span class=\"version\">v${VERSION_NUMBER}<\/span>/" public/index.html
rm -f public/index.html.bak

# Update package.json and create commit
git add package.json package-lock.json public/index.html
git commit -m "Release $NEW_VERSION"

# Annotated tag (npm version already adds the 'v' prefix)
git tag -a "$NEW_VERSION" -m "Release $NEW_VERSION"

echo -e "${GREEN}Version bumped to $NEW_VERSION${NC}"
echo ""
echo -e "${YELLOW}Release notes for GitHub:${NC}"
echo ""
scripts/release-notes.sh "$NEW_VERSION" | sed 's/^/    /'
echo ""

# Ask for confirmation before pushing
read -p "Push release to origin? (Y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Nn]$ ]]; then
    # Together, so the tag never reaches GitHub without its commit.
    echo -e "${GREEN}Pushing $BRANCH and tag $NEW_VERSION...${NC}"
    git push --atomic origin "$BRANCH" "$NEW_VERSION"

    echo ""
    echo -e "${GREEN}✓ Release pushed!${NC}"
    echo "  The release workflow now tests the tag, builds the Docker images and publishes the release:"
    echo "  Workflow: https://github.com/$REPO/actions/workflows/release.yml"
    echo "  Release:  https://github.com/$REPO/releases/tag/$NEW_VERSION (once the workflow finishes)"
else
    echo ""
    echo -e "${YELLOW}Push cancelled. To push manually:${NC}"
    echo -e "  ${GREEN}git push --atomic origin $BRANCH $NEW_VERSION${NC}"
    echo ""
    echo "  To undo the release:"
    echo "    git tag -d $NEW_VERSION"
    echo "    git reset --hard HEAD~1"
fi
