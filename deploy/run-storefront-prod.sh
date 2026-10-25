#!/bin/bash
# Production entrypoint for the SiteGuard FORMS storefront. Mirrors the
# console app's own deploy/run-forms-prod.sh pattern exactly (source nvm,
# cd, exec node) rather than hardcoding a version-specific node binary path
# directly in the systemd unit -- a hardcoded path breaks the next time
# node is upgraded via nvm; sourcing nvm.sh and letting it resolve the
# active version does not.
set -e
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd /srv/siteguard/forms-storefront
exec node server.js
