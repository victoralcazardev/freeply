#!/usr/bin/env bash
#
# Creates .dev.vars and fills in the four values a machine can generate:
# META_VERIFY_TOKEN, ENCRYPTION_KEY, DASHBOARD_PASSWORD, API_TOKEN.
#
#   npm run init
#
# The generated values are written straight into the file and never printed — not
# to the terminal, not into an agent's transcript. Only names and lengths appear.
#
# What's left afterwards is the four Meta credentials, which you copy from the Meta
# dashboard yourself, and OPERATOR_EMAIL. Then: npm run setup
#
# Safe to re-run: an existing value is never overwritten, so this can't orphan the
# Instagram tokens already encrypted under your current ENCRYPTION_KEY.

set -euo pipefail
cd "$(dirname "$0")/.."

VARS_FILE=".dev.vars"
EXAMPLE_FILE=".dev.vars.example"

if [[ ! -f "$EXAMPLE_FILE" ]]; then
  echo "error: $EXAMPLE_FILE not found — are you in the repo root?" >&2
  exit 1
fi

if [[ ! -f "$VARS_FILE" ]]; then
  cp "$EXAMPLE_FILE" "$VARS_FILE"
  echo "created $VARS_FILE from $EXAMPLE_FILE"
else
  echo "$VARS_FILE already exists — filling only what's still a placeholder"
fi

read_from() {
  sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*//p" "$1" \
    | head -1 | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

# Hex from openssl, or node if openssl isn't on the box. Both are CSPRNGs.
random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    node -e 'process.stdout.write(require("crypto").randomBytes(+process.argv[1]).toString("hex"))' "$1"
  fi
}

# Replace KEY="..." in place. The value reaches the file through a temp file and is
# never passed to echo, so it stays out of scrollback and shell history.
set_var() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  VALUE="$value" KEY="$key" node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const key = process.env.KEY;
    const value = process.env.VALUE;
    const line = new RegExp(`^(\\s*${key}\\s*=\\s*).*$`, "m");
    let text = fs.readFileSync(file, "utf8");
    text = line.test(text)
      ? text.replace(line, `$1"${value}"`)
      : `${text.replace(/\n*$/, "\n")}${key}="${value}"\n`;
    fs.writeFileSync(process.argv[2], text);
  ' "$VARS_FILE" "$tmp"
  mv "$tmp" "$VARS_FILE"
}

# name:bytes — 24 bytes of hex is 48 chars, which is plenty for a verify token,
# and ENCRYPTION_KEY must be 32 bytes because that's what AES-GCM takes.
GENERATED=(META_VERIFY_TOKEN:24 ENCRYPTION_KEY:32 DASHBOARD_PASSWORD:12 API_TOKEN:24)

echo
for entry in "${GENERATED[@]}"; do
  name="${entry%%:*}"
  bytes="${entry##*:}"
  current="$(read_from "$VARS_FILE" "$name")"
  example="$(read_from "$EXAMPLE_FILE" "$name")"

  if [[ -n "$current" && "$current" != "$example" ]]; then
    echo "  kept     $name (${#current} chars, already set)"
    continue
  fi

  value="$(random_hex "$bytes")"
  set_var "$name" "$value"
  echo "  wrote    $name (${#value} chars, generated)"
done

status_of() {
  local name="$1" current example
  current="$(read_from "$VARS_FILE" "$name")"
  example="$(read_from "$EXAMPLE_FILE" "$name")"
  if [[ -z "$current" || "$current" == "$example" ]]; then
    echo "  todo     $name"
  else
    echo "  ok       $name (${#current} chars)"
  fi
}

echo
echo "Still yours to fill in, by hand, in $VARS_FILE:"
for name in INSTAGRAM_APP_ID INSTAGRAM_APP_SECRET OPERATOR_EMAIL; do
  status_of "$name"
done

echo
echo "Optional — setup won't block on these:"
for name in CLOUDFLARE_ACCOUNT_ID META_APP_ID META_APP_SECRET; do
  status_of "$name"
done

echo
echo "The Instagram pair comes from your Meta app dashboard, under the Instagram"
echo "product -> \"API setup with Instagram login\". README step 2 has a prompt that"
echo "walks you through getting there. Copy them in yourself, then: npm run setup"
echo
echo "CLOUDFLARE_ACCOUNT_ID is only needed if your Cloudflare login can see more"
echo "than one account."
