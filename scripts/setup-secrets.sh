#!/bin/bash
# =============================================================================
# !! DO NOT EXECUTE THIS FILE DIRECTLY !!
#
# This is a REFERENCE GUIDE — not a runnable script.
# Commands must be run manually, one at a time, so you can paste secrets
# interactively at the prompt. Running this as a script would fail or expose
# secrets via shell history.
# =============================================================================

# -----------------------------------------------------------------------------
# HMAC_SECRET
# Shared secret embedded in the mobile app binary.
# Used to sign outgoing requests so the Worker can verify they come from the app.
#
# 1. Generate a strong random value:
openssl rand -base64 32
#
# 2. Copy the output, then upload it to Cloudflare (you'll be prompted to paste):
npx wrangler secret put HMAC_SECRET
#
# IMPORTANT: Save this value — you will need to embed it in the iOS/Android app.
# -----------------------------------------------------------------------------

# -----------------------------------------------------------------------------
# JWT_SECRET
# Worker-side only. Used to sign and verify the short-lived session tokens
# issued by POST /init. The mobile app never sees this value.
#
# 1. Generate a strong random value (use a different one from HMAC_SECRET):
openssl rand -base64 32
#
# 2. Upload it to Cloudflare:
npx wrangler secret put JWT_SECRET
#
# IMPORTANT: This secret lives only on Cloudflare. Do not put it anywhere else.
# -----------------------------------------------------------------------------

# -----------------------------------------------------------------------------
# Verifying secrets are set
# Lists all secrets configured for this Worker (values are never shown):
npx wrangler secret list
# -----------------------------------------------------------------------------
