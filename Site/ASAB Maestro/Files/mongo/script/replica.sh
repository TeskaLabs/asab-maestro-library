#!/bin/bash

# Get hostnames from environment variable
IFS=',' read -r -a hostnames <<< "$MONGO_HOSTNAMES"

port=27017

# The JavaScript file to execute
script=/script/reconfigure_replica_set.js

# Read the JSON file
newConfig=$(cat /script/new-config.json)

for hostname in "${hostnames[@]}"; do
echo "Trying hostname $hostname"

# Prepare the JavaScript command with the newConfig variable
command="var newConfig = $newConfig; $(cat $script)"

# Run the MongoDB shell command
output=$(mongosh --host "$hostname" --port $port --eval "$command")

# Print the output
echo "$output"

# Check the output for error or success messages
if [[ $output == *"ERROR_NOT_PRIMARY"* ]]; then
	echo "Notice: Not a primary node. Trying another one..."
elif [[ $output == *"ERROR_RECONFIG"* ]]; then
	echo "Error: Failed to reconfigure the replica set."
	exit 1
elif [[ $output == *"SUCCESS_RECONFIG"* ]]; then
	echo "Success: Replica set reconfigured."
	exit 0
elif [[ $output == *"SUCCESS_INITIATE"* ]]; then
	echo "Success: New replica set initiated."
	exit 0
fi
exit 1
done
