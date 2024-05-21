const fs = require("fs")

/**
 * The function reconfigureReplicaSet is used to find the primary node in a replica set and apply a new configuration to it.
 */
function reconfigureReplicaSet() {
	const newConfig = JSON.parse(fs.readFileSync('/script/replica-set.json', 'utf8'))
	newConfig.version = newConfig.version + 1;
	rs.reconfig(newConfig, { force: false });
}

function initiateReplicaSet() {
	const newConfig = JSON.parse(fs.readFileSync('/script/replica-set.json', 'utf8'))
	rs.initiate(newConfig);
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

			const hello = db.hello()
			// To setup replicaset, the replicaset needs to be both in configuration but also initialized. However, it has to be initialized only once. 
			// https://www.mongodb.com/docs/manual/tutorial/deploy-replica-set/#initiate-the-replica-set
			// Mongo starts with rs0 configuration and the replicaset has not yet been initialized. However, this state cannot be tested anyhow.
			// In this state the mongo instance is not primary, it is not secondary, it has replicaset, and the only indicative thing is this message: 'Does not have a valid replica set config'

			if (!hello.isWritablePrimary && !hello.secondary && hello.isreplicaset && hello.info === 'Does not have a valid replica set config') {
				// replicaset has not yet been initialized
				try {
					initiateReplicaSet()
					print("Initialization successful.")
					print("SUCCESS!");
					quit(0);

				} catch (e) {
					print("Initialization of replicaset failed.")
					print("Exiting due to failure.")
					quit(1);
				}
			}

			if (!hello.isWritablePrimary) {
				print("Not a primary, continuing to the next Mongo node.");
				continue;
			};
		
			print("This is a primary, reconfiguring a replicaset.");

			try {
				reconfigureReplicaSet();
				print("Successfully reconfigured replicaset.");
				print("SUCCESS!");
				quit(0);
			} catch (e) {
				print("Reconfiguration failed with " + e.name + ": " + e.message + " / " + error.codeName);
				print("Exiting due to failure.")
				quit(1);
			}
		};
		sleep(5000);
	}
};

main();
