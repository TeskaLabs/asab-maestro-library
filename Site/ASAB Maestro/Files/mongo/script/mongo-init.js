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
 * The function `load_data` reads JSON files from a specified directory, transforms the data, and
 * returns it as an object.
 */
function load_data() {
	const data = {}

	const files = fs.readdirSync("/script/to_upload");

	files.forEach(file => {
		const filePath = path.join("/script/to_upload", file);
		const collectionName = file.slice(0,-5)
		data[collectionName] = transform_collection(collectionName, JSON.parse(fs.readFileSync(filePath, 'utf8')))
	});

	return data
}

/**
 * The function "transform_collection" takes a collection name and data as input, and adds additional
 * fields to each record in the data to satisfy seacat auth requirements
 * @returns the modified data array.
 */
function transform_collection(collectionName, data) {
	data.forEach((record) => {
		if (collectionName === "c") {
			record["_id"] = ObjectId(record._id)  // IDs of users are stored as ObjectId
		}
		record["_c"] = new Date()
		record["_m"] = new Date()
		record["_v"] = 1
	});

	return data
}

/**
 * The function upsertSeaCatAuthCollections inserts or updates multiple collections in the "auth"
 * database using the provided data, and handles duplicate key errors.
 * @param data - The `data` parameter is an object that contains collections and their corresponding
 * data to be upserted into the "auth" database. Each key in the `data` object represents a collection
 * name, and the corresponding value is an array of documents to be inserted or updated in that
 * collection.
 */
function insertSeaCatAuthCollections(data) {
	// seacat auth uses "auth" database
	authDb = db.getSiblingDB( "auth" );
	Object.keys(data).forEach(function(collectionName) {
		const collection = authDb.getCollection(collectionName)
		try {
			res = collection.insertMany(data[collectionName], {ordered: false})
			print(`Insterted ${Object.keys(res.insertedIds).length} into ${collectionName} collection.`)
		} catch (MongoBulkWriteError) {
			if (MongoBulkWriteError.code === 11000) {
				res = MongoBulkWriteError.result
				print(`Insterted ${res.insertedCount} into ${collectionName} collection.`)
			} else {
				throw MongoBulkWriteError
			}
		}
	});
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

			try {
				data = load_data()
			} catch (err) {
				print('Error reading directory "/script/to_upload":', err);
				quit(1);
			}
			
	
			try {
				insertSeaCatAuthCollections(data);
			} catch (err) {
				print("UNSUCCESSFUL_DATA_INSERT", err);
				quit(1)
			}
			
			print("SUCCESS!")
			quit(0)  // SUCCESS!
		};
		sleep(5000)
	}

	quit(1)
};

main()
