#!/bin/sh

# Start PoolNoodle in debug mode
# No daemon fork, and all logs emitted to stdout, debug level 9
# Also set default pool children to 1/1, and static file TTL to 0

HOMEDIR="$(dirname "$(cd -- "$(dirname "$0")" && (pwd -P 2>/dev/null || pwd))")"

cd $HOMEDIR
node --trace-warnings $HOMEDIR/lib/main.js --debug --debug_level 9 --worker_echo --notify --PoolNoodle.pools.default.min_children 1 --PoolNoodle.pools.default.max_children 1 --WebServer.http_static_ttl 0 "$@"
