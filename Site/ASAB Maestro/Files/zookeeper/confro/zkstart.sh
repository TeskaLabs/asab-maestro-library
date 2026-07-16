#!/bin/bash

# Copy the configuration from the read-only site directory to the /conf
# This has to be done b/c Zookeeper cannot operate from read-only /conf
# Zookeeper add own files into /conf during runtime so `/conf` cannot be mounted directly (rsync will erase Zookeeper data etc.)
#
# Static files from /confro are synced when missing or when their content changed.
# Do not sync zoo.cfg.dynamic here; Zookeeper manages that file at runtime.

sync_confro_file() {
    local name="$1"
    local src="/confro/${name}"
    local dst="${ZOO_CONF_DIR}/${name}"

    if [[ ! -f "$src" ]]; then
        return 0
    fi

    if [[ ! -f "$dst" ]] || ! cmp -s "$src" "$dst"; then
        cp "$src" "$dst"
    fi
}

sync_confro_file zoo.cfg
sync_confro_file logback.xml

# Create a "myid" file in the data directory
if [[ ! -f "$ZOO_DATA_DIR/myid" ]]; then
    echo "${ZOO_MY_ID:-1}" > "$ZOO_DATA_DIR/myid"
fi

exec "$@"
