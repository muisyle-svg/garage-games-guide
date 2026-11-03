#!/bin/sh
# Saves the scorekeeper's latest live scores into a year's folder, so that year's Scores page
# keeps them after the live scores move on to the next year.
# Usage: sh tools/save-scores.sh 2026
set -e
YEAR="${1:?Usage: sh tools/save-scores.sh <year>}"
[ -d "content/years/$YEAR" ] || { echo "No content/years/$YEAR folder"; exit 1; }
git fetch --depth=1 origin live-scores
git show FETCH_HEAD:scores.json > "content/years/$YEAR/scores.json"
echo "Saved content/years/$YEAR/scores.json. Commit it to keep $YEAR's scores."
