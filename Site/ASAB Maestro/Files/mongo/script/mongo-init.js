const fs = require("fs")


/**
 * The function reconfigureReplicaSet is used to find the primary node in a replica set and apply a new configuration to it.
 */
function reconfigureReplicaSet() {
	const newConfig = JSON.parse(fs.readFileSync('/script/replica-set.json', 'utf8'))
	try {
		// If there is a configuration, the replica set has been initialized and it want's to be reconfigured, which can be done only from the primary node
		let currentConfig = rs.conf();
		newConfig.version = newConfig.version + 1;
		rs.reconfig(newConfig, { force: false });
		print("SUCCESS_RECONFIG");
	} catch (error) {
		// If there is no replica set configuration, it is probably a first node in the cluster and the replica set should be initialized
		if (error.codeName === 'NotYetInitialized' || error.codeName === 'InvalidReplicaSetConfig') {
			rs.initiate(newConfig);
			print("SUCCESS_INITIATE");
		} else {
			print("Failed with " + error.name + ": " + error.message + " / " + error.codeName);
			throw new Error("ERROR_RECONFIG");
		}
	}
}

/**
 * The main function reads JSON files from a directory, connects to multiple MongoDB instances,
 * reconfigures the replica set, and inserts data into collections, with a maximum of 5 attempts.
 */
function main() {
	print("(Re)-initializing the Mongo cluster.");

	const mongoHostnames = process.env.MONGO_HOSTNAMES.split(",");

	// there are 5 attempts to reconfigure replica sets.
	// It can be done only on the primary node.
	// When replica set is (re)configured, upsert seacat auth data.
	for (let i = 0; i < 5; i++) {

		print("Connection attempt", i+1);

		for (let hostname of mongoHostnames) {
			print("Connecting to ", `${hostname}:27017`);
			try {
				db = connect( `${hostname}:27017` );
			} catch (error) {
				print("Failed with " + error.name + ": " + error.message)
				continue;
			}

			if (!db.isMaster()) {
				print("Not a master, continuing to the next Mongo node.");
				continue;
			};
		
			print("This is a master, reconfiguring a replica set.");

			try {
				reconfigureReplicaSet();
			} catch (e) {
				print("Failed to reconfigure replica set with " + error.name + ": " + error.message)
				break;
			}

			print("SUCCESS!");
			quit(0);  // SUCCESS!
		};
		sleep(5000);
	}

	print("Exiting due to failure.")
	quit(1);
};

main();
