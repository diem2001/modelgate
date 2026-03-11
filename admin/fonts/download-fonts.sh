#!/bin/sh
# Download Google Fonts as woff2 for self-hosting (GDPR compliance).
# Extracts current URLs from the CSS API so they stay up-to-date.
set -e

FONTS_DIR="admin/fonts"
CSS_URL="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600&family=Plus+Jakarta+Sans:wght@300;400;500;600;700&display=swap"
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

# Fetch CSS (with browser UA to get woff2 format)
CSS=$(wget -q -O - --header="User-Agent: $UA" "$CSS_URL")

# Extract woff2 URLs and download
echo "$CSS" | grep -oE 'https://fonts\.gstatic\.com/[^)]+\.woff2' | while read -r url; do
  # Derive filename from font family in the CSS context
  filename=$(echo "$url" | sed 's|.*/s/||; s|/.*||').woff2
  wget -q -O "$FONTS_DIR/$filename" "$url"
done

echo "Fonts downloaded to $FONTS_DIR:"
ls -lh "$FONTS_DIR"/*.woff2
