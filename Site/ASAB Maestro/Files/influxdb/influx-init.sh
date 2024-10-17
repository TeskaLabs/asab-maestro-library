#!/bin/sh

# Wait for InfluxDB to start
until curl -s http://{{INFLUXDB_HOSTNAME}}:8086/health | grep -q '"status": "pass"'; do
  echo "Waiting for InfluxDB to start..."
  sleep 1
done

# Get the bucket ID
BUCKET_ID=$(curl -s -X GET http://{{INFLUXDB_HOSTNAME}}:8086/api/v2/buckets -H 'Authorization: Token "{{INFLUXDB_TOKEN}}"' -H "Accept: application/json" | jq -r '.buckets[] | select(.name=="{{DOCKER_INFLUXDB_INIT_BUCKET}}") | .id')
# Get the org ID
ORG_ID=$(curl -s -X GET http://{{INFLUXDB_HOSTNAME}}:8086/api/v2/orgs -H 'Authorization: Token "{{INFLUXDB_TOKEN}}"' -H "Accept: application/json" | jq -r '.orgs[] | select(.name=="{{DOCKER_INFLUXDB_INIT_ORG}}") | .id')

# Get the user ID
USER_ID=$(curl -s -X GET http://{{INFLUXDB_HOSTNAME}}:8086/api/v2/users -H 'Authorization: Token "{{INFLUXDB_TOKEN}}"' -H "Accept: application/json" | jq -r '.users[] | select(.name=="{{DOCKER_INFLUXDB_INIT_USERNAME}}") | .id')

# Create the non-admin token using the InfluxDB API v2
curl -X POST http://{{INFLUXDB_HOSTNAME}}:8086/api/v2/authorizations \
  -H "Authorization: Token {{INFLUXDB_TOKEN}}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -d '{
        "description": "Non-admin user with write access",
        "orgID": "'"$ORG_ID"'", 
        "permissions": [
          {
            "action": "write",
            "resource": {
              "type": "buckets",
              "id": "'"$BUCKET_ID"'"
            }
          }
        ],
        "status": "active",
        "userID": "'"$USER_ID"'" 
      }'