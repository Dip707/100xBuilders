#!/usr/bin/env bash
# Toggles chaos on mini-shop for the 5-minute demo.
# usage: ./demo.sh rename|coupon|cosmetic|reset
set -euo pipefail
BASE=${SHOP_URL:-http://localhost:3005}
case "${1:-}" in
  rename)   curl -s -X POST "$BASE/__chaos" -H 'content-type: application/json' -d '{"renameCheckoutButton":true}' ;;
  coupon)   curl -s -X POST "$BASE/__chaos" -H 'content-type: application/json' -d '{"breakCoupon":true}' ;;
  cosmetic) curl -s -X POST "$BASE/__chaos" -H 'content-type: application/json' -d '{"cosmeticChange":true}' ;;
  reset)    curl -s -X POST "$BASE/__chaos" -H 'content-type: application/json' -d '{"renameCheckoutButton":false,"breakCoupon":false,"cosmeticChange":false}' ;;
  *) echo "usage: $0 rename|coupon|cosmetic|reset"; exit 1 ;;
esac
echo
