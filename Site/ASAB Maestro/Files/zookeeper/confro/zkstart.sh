#!/bin/bash

set -e

cp /confro/zoo.cfg /conf/zoo.cfg

if [[ ! -f "$ZOO_DATA_DIR/myid" ]]; then
    echo "${ZOO_MY_ID:-1}" > "$ZOO_DATA_DIR/myid"
fi

exec zkServer.sh start-foreground
