#!/bin/sh
# export for the local n8n editor of this folder (see env.sh and ../_shared/bin/n8n-local.mjs).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
. "$here/env.sh"
exec node "$here/../_shared/bin/n8n-local.mjs" export "$here"
