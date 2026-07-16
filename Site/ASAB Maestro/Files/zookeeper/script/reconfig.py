import os
import sys
import time
import logging

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
		reconfig_error = None
		try:
			zkconfig_new = kazoo_client.reconfig(
				joining=joining_server,
				leaving=None,
				new_members=None
			)
			break
		except kazoo.exceptions.ReconfigInProcessError as e:
			reconfig_error = "Another reconfiguration is in progress: {}".format(e)
		except kazoo.exceptions.NewConfigNoQuorumError as e:
			reconfig_error = "No quorum of new config is connected and up-to-date: {}".format(e)
		except kazoo.exceptions.BadVersionError as e:
			reconfig_error = "Configuration version mismatch: {}".format(e)
		except kazoo.exceptions.BadArgumentsError as e:
			L.error("Invalid reconfiguration arguments: {}".format(e))
			kazoo_client.stop()
			sys.exit(21)
		except kazoo.exceptions.UnimplementedError as e:
			L.error("ZooKeeper reconfiguration is not supported: {}".format(e))
			kazoo_client.stop()
			sys.exit(21)
		except kazoo.exceptions.ConnectionLoss as e:
			reconfig_error = "Connection to ZooKeeper lost: {}".format(e)
		except kazoo.exceptions.ConnectionClosedError as e:
			reconfig_error = "ZooKeeper connection closed: {}".format(e)
		except kazoo.exceptions.SessionExpiredError as e:
			reconfig_error = "ZooKeeper session expired: {}".format(e)
		except kazoo.exceptions.SessionMovedError as e:
			reconfig_error = "ZooKeeper session moved: {}".format(e)
		except kazoo.exceptions.OperationTimeoutError as e:
			reconfig_error = "ZooKeeper operation timed out: {}".format(e)
		except kazoo.exceptions.ZookeeperStoppedError as e:
			reconfig_error = "Kazoo client stopped: {}".format(e)
		except kazoo.exceptions.ConnectionDropped as e:
			reconfig_error = "ZooKeeper connection dropped: {}".format(e)
		except kazoo.exceptions.CancelledError as e:
			reconfig_error = "ZooKeeper operation cancelled: {}".format(e)
		except kazoo.exceptions.ZookeeperError as e:
			reconfig_error = "ZooKeeper server error: {}".format(e)
		except kazoo.exceptions.KazooException as e:
			reconfig_error = "Kazoo client error: {}".format(e)

		if reconfig_error is not None:
			L.warning("Failed to reconfigure ZooKeeper (attempt {}/5): {}".format(attempt, reconfig_error))
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
