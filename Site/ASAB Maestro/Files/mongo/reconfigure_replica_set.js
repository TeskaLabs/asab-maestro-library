// Function to find the primary node and apply the new configuration
function reconfigureReplicaSet(newConfig) {
	try {
		// If there is a configuration, the replica set has been initialized and it want's to be reconfigured, which can be done only from the primary node
		let currentConfig = rs.conf();
		const primary = db.isMaster();
		if (!primary.ismaster) {
			print("ERROR_NOT_PRIMARY");
			return;
		}
		newConfig.version = currentConfig.version + 1;
		rs.reconfig(newConfig, { force: false });
		print("SUCCESS_RECONFIG");
	} catch (error) {
		// If there is no replica set configuration, it is probably a first node in the cluster and the replica set should be initialized
		if (error.codeName === 'NotYetInitialized' || error.codeName === 'InvalidReplicaSetConfig') {
			try {
				rs.initiate(newConfig);
				print("SUCCESS_INITIATE");
			} catch (initiateError) {
				print("ERROR_INITIATE");
			}
		} else {
			print("ERROR_RECONFIG");
		}
	}
}

// Execute the function with the new configuration
reconfigureReplicaSet(newConfig);