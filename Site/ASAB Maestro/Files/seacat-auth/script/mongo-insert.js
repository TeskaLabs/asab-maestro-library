const fs = require("fs")


/**
 * The function `load_data` reads JSON files from a specified directory, transforms the data, and
 * returns it as an object.
 */
function load_data() {
	const data = [] // array of arrays - each object has just one key/value pair

	const subpaths = fs.readdirSync("/script/to_upload");

	subpaths.forEach(subpath => {
		const files = fs.readdirSync(path.join("/script/to_upload", subpath));
		files.forEach(file => {
			const filePath = path.join("/script/to_upload", subpath, file);
			const collectionName = file.slice(0, -5)
			data.push([collectionName, transform_collection(collectionName, JSON.parse(fs.readFileSync(filePath, 'utf8')))])
		});
	})

	return data
}

/**
 * The function "transform_collection" takes a collection name and data as input, and adds additional
 * fields to each record in the data to satisfy seacat auth requirements
 * @returns the modified data array.
 */
function transform_collection(collectionName, data) {
	data.forEach((record) => {
		if (collectionName === "c" | collectionName === "mc") {
			record["_id"] = ObjectId(record._id)  // IDs of users are stored as ObjectId
		}
		record["_c"] = new Date()
		record["_m"] = new Date()
		record["_v"] = 1
		record["managed_by"] = "asab-maestro"
	});

	return data
}


function upsertSeaCatAuthCollections(data) {
	// seacat auth uses "auth" database
	authDb = db.getSiblingDB("auth");
	// save existing and new record IDs for each collection to compare and delete records not present in the new data
	const existingRecordIds = {};
	const newRecordIds = {};
	const allCollections = authDb.getCollectionNames();
	// find all existing records managed by asab-maestro
	allCollections.forEach(collectionName => { 
		existingRecordIds[collectionName] = authDb.getCollection(collectionName).find({ managed_by: "asab-maestro" }).map(record => record._id).toArray() 
	});
	// create empty arrays for new record IDs
	allCollections.forEach(collectionName => { newRecordIds[collectionName] = [] });

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
			if (collectionName === "c" | collectionName === "mc") {
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

	// Delete records not present in the new data
	allCollections.forEach(collectionName => {
		const collection = authDb.getCollection(collectionName)
		// Create a to_delete array by subtracting new records from existing records
		let to_delete;
		if (collectionName === "c" || collectionName === "mc") {
			// ObjectId comparison
			to_delete = existingRecordIds[collectionName].filter(existingId => 
				!newRecordIds[collectionName].some(newId => existingId.equals(newId))
			);
		} else {
			// String ID comparison
			to_delete = existingRecordIds[collectionName].filter(id => 
				!newRecordIds[collectionName].includes(id)
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
				db = connect(`${hostname}:27017`)
			} catch (MongoNetworkError) {
				continue
			}

			// db.hello() returns an object with basic data about the mongo instance and the database
			// https://www.mongodb.com/docs/manual/reference/command/hello/#mongodb-dbcommand-dbcmd.hello
			if (!db.hello()?.isWritablePrimary ?? false) {  //The optional chaining operator (?.) will return undefined instead of causing an error if isMaster() returns null or undefined, or if isWritablePrimary does not exist on the object returned by isMaster(). The nullish coalescing operator (??) will return the value on its right-hand side if the value on its left-hand side is null or undefined.
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
				upsertSeaCatAuthCollections(data);
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
