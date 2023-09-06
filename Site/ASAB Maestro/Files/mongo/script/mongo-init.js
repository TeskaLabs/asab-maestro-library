const fs = require("fs")


/**
 * The function reconfigureReplicaSet is used to find the primary node in a replica set and apply a new
 * configuration to it.
 */
function reconfigureReplicaSet() {
	const newConfig = JSON.parse(fs.readFileSync('/script/new-config.json', 'utf8'))
	try {
		// If there is a configuration, the replica set has been initialized and it want's to be reconfigured, which can be done only from the primary node
		let currentConfig = rs.conf();
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
				throw new Error("ERROR_INITIATE");
			}
		} else {
			throw new Error("ERROR_RECONFIG");
		}
	}
}

/**
 * The main function reads JSON files from a directory, connects to multiple MongoDB instances,
 * reconfigures the replica set, and inserts data into collections, with a maximum of 5 attempts.
 */
function main() {

	let data = {}

	const mongoHostnames = process.env.MONGO_HOSTNAMES.split(",")


	// there are 5 attempts to reconfigure replica sets.
	// It can be done only on the primary node.
	// When replica set is (re)configured, upsert seacat auth data.
	for (let i = 0; i < 5; i++) {

		for (let hostname of mongoHostnames) {
			try {
				db = connect( `${hostname}:27017` )
			} catch (MongoNetworkError) {
				continue
			}

			if (!db.isMaster()) {
				continue
			};
		
			try {
				reconfigureReplicaSet();
			} catch {
				break
			}

			print("SUCCESS!")
			quit(0)  // SUCCESS!
		};
		sleep(5000)
	}

	quit(1)
};

main()
