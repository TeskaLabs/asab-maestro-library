#!/bin/bash

# Copy the configuration from the read-only site directory to the /conf
# This has to be done b/c Zookeeper cannot operate from read-only /conf
# Zookeeper add own files into /conf during runtime so `/conf` cannot be mounted directly (rsync will erase Zookeeper data etc.)
# WARNING: The file will be copied only once, in the beginning b/c Zookeeper manages the content of that file
# If any modification will be needed, the custom "patching" functionality must me added here.
if [[ ! -f "$ZOO_CONF_DIR/zoo.cfg" ]]; then
    cp /confro/zoo.cfg $ZOO_CONF_DIR/zoo.cfg
fi

# Create a "myid" file in the data directory
if [[ ! -f "$ZOO_DATA_DIR/myid" ]]; then
    echo "${ZOO_MY_ID:-1}" > "$ZOO_DATA_DIR/myid"
fi

exec "$@"
