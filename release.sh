#!/bin/bash
set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

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

echo -e "${GREEN}Running checks...${NC}"
npm run check

echo -e "${GREEN}Bumping version ($VERSION_TYPE)...${NC}"
NEW_VERSION=$(npm version $VERSION_TYPE --no-git-tag-version)

# Update package.json and create commit
git add package.json package-lock.json
git commit -m "Release $NEW_VERSION"

# Create tag (npm version already adds 'v' prefix)
git tag $NEW_VERSION

echo -e "${GREEN}Version bumped to $NEW_VERSION${NC}"
echo ""
echo -e "${YELLOW}Changes made:${NC}"
echo "  - Updated package.json to $NEW_VERSION"
echo "  - Created git commit"
echo "  - Created git tag $NEW_VERSION"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "  Review the changes with: git show"
echo "  If everything looks good, push with:"
echo -e "    ${GREEN}git push origin main --follow-tags${NC}"
echo ""
echo "  To undo if you made a mistake:"
echo "    git tag -d $NEW_VERSION"
echo "    git reset --hard HEAD~1"
