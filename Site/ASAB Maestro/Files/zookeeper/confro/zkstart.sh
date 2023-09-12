#!/bin/bash

# Copy the configuration from the read-only site directory to the /conf
# This has to be done b/c Zookeeper cannot operate from read-only /conf
# Zookeeper add own files into /conf during runtime so `/conf` cannot be mounted directly (rsync will erase Zookeeper data etc.)
cp /confro/zoo.cfg $ZOO_CONF_DIR/zoo.cfg

# Create a "myid" file in the data directory
if [[ ! -f "$ZOO_DATA_DIR/myid" ]]; then
    echo "${ZOO_MY_ID:-1}" > "$ZOO_DATA_DIR/myid"
fi

exec "$@"
