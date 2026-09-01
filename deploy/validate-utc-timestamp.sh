#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 1 ]] || exit 1
timestamp=$1
[[ "$timestamp" =~ ^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$ ]] || exit 1

year=$((10#${BASH_REMATCH[1]}))
month=$((10#${BASH_REMATCH[2]}))
day=$((10#${BASH_REMATCH[3]}))
hour=$((10#${BASH_REMATCH[4]}))
minute=$((10#${BASH_REMATCH[5]}))
second=$((10#${BASH_REMATCH[6]}))
(( year >= 1970 && month >= 1 && month <= 12 )) || exit 1
(( hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59 )) || exit 1

case "$month" in
  2)
    maximum_day=28
    if (( year % 400 == 0 || (year % 4 == 0 && year % 100 != 0) )); then
      maximum_day=29
    fi
    ;;
  4|6|9|11) maximum_day=30 ;;
  *) maximum_day=31 ;;
esac
(( day >= 1 && day <= maximum_day )) || exit 1
