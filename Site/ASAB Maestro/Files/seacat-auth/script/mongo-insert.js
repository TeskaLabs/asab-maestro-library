const fs = require("fs")


/**
 * The function `load_data` reads JSON files from a specified directory, transforms the data, and
 * returns it as an object.
 */
function load_data() {
	const data = [] // array of arrays - each object has just one key/value pair

	const subpaths = fs.readdirSync("/script/to_upload").sort();
	// Sort so processing order is deterministic. Multiple files can map to the same
	// collection (e.g. rs.json in seacat-auth, grafana, jupyter, ...); last upsert wins
	// per _id, so we need a stable order to get the same mongo result for the same tarball.
	subpaths.forEach(subpath => {
		const files = fs.readdirSync(path.join("/script/to_upload", subpath)).sort();
		files.forEach(file => {
			const filePath = path.join("/script/to_upload", subpath, file);
			const collectionName = file.slice(0, -5);
			data.push([collectionName, transform_collection(collectionName, JSON.parse(fs.readFileSync(filePath, 'utf8')))]);
		});
	});

	return data;
}

/**
 * The function "transform_collection" takes a collection name and data as input, and adds additional
 * fields to each record in the data to satisfy seacat auth requirements
 * @returns the modified data array.
 */
function transform_collection(collectionName, data) {
	data.forEach((record) => {
		if (collectionName === "c" || collectionName === "mc") {
			record["_id"] = ObjectId(record._id)  // IDs of users are stored as ObjectId
		}
		record["_c"] = new Date()
		record["_m"] = new Date()
		record["_v"] = 1
		record["managed_by"] = "asab-maestro"
	});

	return data
}


function upsertSeaCatAuthCollections(data, db) {
	// seacat auth uses "auth" database
	const authDb = db.getSiblingDB("auth");
	// save existing and new record IDs for each collection to compare and delete records not present in the new data
	const existingRecordIds = {};
	const newRecordIds = {};
	const allCollections = authDb.getCollectionNames();
	// find all existing records managed by asab-maestro
	allCollections.forEach(collectionName => { 
		existingRecordIds[collectionName] = authDb.getCollection(collectionName).find({ managed_by: "asab-maestro" }).map(record => record._id).toArray() 
	});
	// iterate through new data and upsert records
	data.forEach(line => {
		const collectionName = line[0]
		const collection = authDb.getCollection(collectionName)
		const newRecords = line[1];

		// save new record IDs - use object id for users instead of string
		if (!newRecordIds[collectionName]) {
			newRecordIds[collectionName] = [];
		}

		newRecordIds[collectionName].push(...newRecords.map(doc => {
			if (collectionName === "c" || collectionName === "mc") {
				return ObjectId(doc._id);
			}
			return doc._id;
		}));

		// upsert new records
		newRecords.forEach(record => {
			print(`Upserting ${record["_id"]} to collection ${collectionName}`)
			collection.updateOne({ _id: record["_id"] }, { $set: record }, { upsert: true })
		});
	});

	// Delete records not present in the new data.
	// Only consider collections that are in the current upload data.
	// When incoming data for a collection is empty, skip deletes for that collection.
	const collectionsInThisRun = [...new Set(data.map(line => line[0]))];
	collectionsInThisRun.forEach(collectionName => {
		const newIds = newRecordIds[collectionName];
		if (!newIds || newIds.length === 0) {
			print(`Skipping delete for collection ${collectionName}: no data in this run.`);
			return;
		}

		const collection = authDb.getCollection(collectionName)
		// Create a to_delete array by subtracting new records from existing records
		let to_delete;
		if (collectionName === "c" || collectionName === "mc") {
			// ObjectId comparison
			to_delete = (existingRecordIds[collectionName] || []).filter(existingId =>
				!newIds.some(newId => existingId.equals(newId))
			);
		} else {
			// String ID comparison
			to_delete = (existingRecordIds[collectionName] || []).filter(id =>
				!newIds.includes(id)
			);
		}

		// Delete records not present in the new data
		to_delete.forEach(id => {
			print(`Deleting ${id} from collection ${collectionName}`);
			collection.deleteOne({ _id: id });
		});

	});
}


/**
 * Number of attempts and delay for the main connect loop that connects to the
 * mongod instances and waits for a writable primary. MongoDB may take a while
 * to become primary (compose depends_on only waits for container start), so
 * keep the default high enough for a fresh install.
 * Env: MONGO_INIT_CONNECT_ATTEMPTS (default 60), MONGO_INIT_CONNECT_MS (default 5000).
 */
function initConnectConfigFromEnv() {
	const attempts = parseInt(process.env.MONGO_INIT_CONNECT_ATTEMPTS || "60", 10)
	const ms = parseInt(process.env.MONGO_INIT_CONNECT_MS || "5000", 10)
	return {
		attempts: isNaN(attempts) ? 60 : Math.max(1, attempts),
		ms: isNaN(ms) ? 5000 : Math.max(200, ms),
	}
}

/**
 * The main function reads JSON files from a directory, connects to multiple MongoDB instances,
 * waits for a writable primary, and inserts data into collections. The number of connection
 * attempts is configurable via MONGO_INIT_CONNECT_ATTEMPTS / MONGO_INIT_CONNECT_MS.
 */
function main() {

	let data = []
	let db

	const mongoHostnames = process.env.MONGO_HOSTNAMES.split(",")
	const { attempts: connectAttempts, ms: connectMs } = initConnectConfigFromEnv()

	// Connect until we find a writable primary and upsert the seacat auth data.
	// This can only be done on the primary node, which may take a while to be
	// elected on a fresh install, so keep trying connectAttempts times.
	for (let i = 0; i < connectAttempts; i++) {
		print("Connection attempt", i + 1 + "/" + connectAttempts)

		for (let hostname of mongoHostnames) {
			try {
				db = connect(`${hostname}:27017`)
			} catch (MongoNetworkError) {
				continue
			}

			// db.hello() returns an object with basic data about the mongo instance and the database
			// https://www.mongodb.com/docs/manual/reference/command/hello/#mongodb-dbcommand-dbcmd.hello
			if (!(db.hello()?.isWritablePrimary ?? false)) {  // treat absent/null isWritablePrimary as false (not primary) before negating
				// skip mongo instances that are not primary
				continue
			};

			try {
				data = load_data()
			} catch (err) {
				print('Error reading directory "/script/to_upload":', err);
				quit(1);
			}


			try {
				upsertSeaCatAuthCollections(data, db);
			} catch (err) {
				print("UNSUCCESSFUL_DATA_INSERT", err);
				quit(1)
			}

			print("SUCCESS!")
			quit(0)  // SUCCESS!
		};
		sleep(connectMs)
	}

	print("ERROR: Could not connect to a writable primary on any of:", mongoHostnames)
	print("Giving up after", connectAttempts, "attempts.")
	quit(1)
};

main()
