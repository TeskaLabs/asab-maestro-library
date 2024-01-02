#!/bin/bash

# Check if /config directory exists
if [ -d "/config" ]; then
    # Check if /home/jovyan/.jupyter directory exists
    if [ ! -d "/home/jovyan/.jupyter" ]; then
        # Create the directory if it doesn't exist
        mkdir -p /home/jovyan/.jupyter
    fi

    # Copy files from /config to /home/jovyan/.jupyter
    cp /config/jupyter_notebook_config.py /home/jovyan/.jupyter/jupyter_notebook_config.py
else
    echo "The source directory /config does not exist."
fi

exec "tini" "-g" "--" start-notebook.sh
