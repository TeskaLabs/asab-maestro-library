import os
import sys
import time
import json
import shutil
import collections
import urllib.request
import logging

import jinja2
import kazoo
import kazoo.client
import kazoo.exceptions

# Configure logging to output to stdout for Docker visibility
logging.basicConfig(
	level=logging.INFO,
	format='%(asctime)s %(levelname)s %(message)s',
	stream=sys.stdout
)

L = logging.getLogger(__name__)

if __name__ == "__main__":
	joining_server = os.getenv('JOINING')
	if joining_server is None:
		L.info("JOINING environment variable is not set. Reconfiguration is not needed. Exiting...")
		sys.exit(0)

	L.info("Joining server: {}".format(joining_server))
	L.info("Reconfiguring ZooKeeper...")

	zookeeper_servers = os.getenv('ZOOKEEPER_SERVERS')
	kazoo_client = None
	for attempt in range(1, 6):  # Try up to 5 times
		try:
			kazoo_client = kazoo.client.KazooClient(hosts=zookeeper_servers, timeout=5)
			kazoo_client.start()
			L.info("Successfully connected to ZooKeeper")
			break
		except kazoo.exceptions.ConnectionLoss as e:
			L.warning("Failed to connect to ZooKeeper (attempt {}/5): {}".format(attempt, e))
			if attempt < 5:
				wait_time = min(2 ** attempt, 30)  # Exponential backoff, max 30 seconds
				L.info("Retrying in {} seconds...".format(wait_time))
				time.sleep(wait_time)
			else:
				L.error("Failed to connect to ZooKeeper after 5 attempts. Exiting...")
				sys.exit(20)

	if kazoo_client is None:
		L.error("Failed to establish ZooKeeper connection. Exiting...")
		sys.exit(20)

	zkconfig = kazoo_client.get("/zookeeper/config")
	zkservers = [zkserver for zkserver in zkconfig[0].decode('ascii').split('\n') if zkserver.startswith("server.")]
	if joining_server.split("=")[0] in zkservers:
		L.info("Server {} is already in the ZooKeeper cluster. Exiting...".format(joining_server))
		sys.exit(0)

	L.info("Adding server {} to the ZooKeeper cluster...".format(joining_server))


	zkconfig_new = None
	for attempt in range(1, 6):  # Try up to 5 times
		try:
			zkconfig_new = kazoo_client.reconfig(
				joining=joining_server,
				leaving=None,
				new_members=None
			)
			break
		except Exception as e:
			L.warning("Failed to reconfigure ZooKeeper (attempt {}/5): {}".format(attempt, e))
			if attempt < 5:
				wait_time = min(2 ** attempt, 30)  # Exponential backoff, max 30 seconds
				L.info("Retrying in {} seconds...".format(wait_time))
				time.sleep(wait_time)
			else:
				L.error("Failed to reconfigure ZooKeeper after 5 attempts. Exiting...")
				kazoo_client.stop()
				sys.exit(21)

	if zkconfig_new is None:
		L.error("Failed to reconfigure ZooKeeper. Exiting...")
		kazoo_client.stop()
		sys.exit(21)


	L.info("ZooKeeper reconfiguration completed successfully")
	sys.exit(0)