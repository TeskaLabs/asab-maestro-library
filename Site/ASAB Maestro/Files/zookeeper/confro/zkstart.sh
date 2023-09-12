#!/bin/bash

# Copy the configuration from the read-only site directory to the /conf
cp /confro/zoo.cfg $ZOO_CONF_DIR/zoo.cfg

# Create a "myid" file in the data directory
if [[ ! -f "$ZOO_DATA_DIR/myid" ]]; then
    echo "${ZOO_MY_ID:-1}" > "$ZOO_DATA_DIR/myid"
fi

exec "$@"
