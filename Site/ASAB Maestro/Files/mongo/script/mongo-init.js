const fs = require("fs")

/**
 * Cluster-wide default write concern (MongoDB 5.0+ gate before many reconfigs).
 * Optional: MONGO_INIT_DEFAULT_WRITE_CONCERN_W — "majority" (default), "1", "2", etc.
 * Use w=1 only when you accept weaker defaults (e.g. temporary 1 data + 1 arbiter).
 * @see https://www.mongodb.com/docs/manual/reference/command/setDefaultRWConcern/
 */
function defaultWriteConcernFromEnv() {
	const w = process.env.MONGO_INIT_DEFAULT_WRITE_CONCERN_W
	if (w == null || String(w).trim() === "" || String(w).trim() === "majority") {
		return { w: "majority", wtimeout: 0 }
	}
	const n = parseInt(String(w), 10)
	if (!isNaN(n)) {
		return { w: n, wtimeout: 0 }
	}
	return { w: String(w).trim(), wtimeout: 0 }
}

function ensureClusterWideDefaultWriteConcern() {
	const dwc = defaultWriteConcernFromEnv()
	const res = db.adminCommand({
		setDefaultRWConcern: 1,
		defaultWriteConcern: dwc,
		writeConcern: { w: "majority", wtimeout: 15000 },
	})
	if (!res.ok) {
		const msg = res.errmsg != null ? res.errmsg : JSON.stringify(res)
		throw new Error("setDefaultRWConcern failed: " + msg)
	}
	print("setDefaultRWConcern: defaultWriteConcern " + JSON.stringify(dwc) + " (ok)")
}

function normalizeMemberHost(host) {
	return typeof host === "string" ? host.trim() : host
}

function currentMembersByHost(conf) {
	const map = {}
	for (const mem of conf.members) {
		map[normalizeMemberHost(mem.host)] = mem
	}
	return map
}

/**
 * Add one member from desired JSON (preserves _id when Mongo accepts it).
 */
function addMemberFromDesired(dm) {
	const h = normalizeMemberHost(dm.host)
	const doc = { host: h }
	if (dm._id !== undefined && dm._id !== null) {
		doc._id = dm._id
	}
	if (dm.arbiterOnly === true) {
		doc.arbiterOnly = true
	}
	if (dm.priority !== undefined) {
		doc.priority = dm.priority
	}
	if (dm.votes !== undefined) {
		doc.votes = dm.votes
	}
	try {
		rs.add(doc)
	} catch (e1) {
		if (dm.arbiterOnly === true) {
			print("rs.add with arbiterOnly failed, trying rs.addArb: " + e1.message)
			rs.addArb(h)
		} else {
			throw e1
		}
	}
}

/**
 * Data-bearing member cannot become arbiter in place: remove from set first.
 * Operator must wipe dbPath and restart mongod; a later init pass adds the arbiter.
 */
function removeMembersForArbiterConversion(desired, current) {
	const curMap = currentMembersByHost(current)
	let removed = false
	for (const dm of desired.members) {
		const h = normalizeMemberHost(dm.host)
		const cm = curMap[h]
		if (cm && dm.arbiterOnly === true && cm.arbiterOnly !== true) {
			print("Removing data member for arbiter conversion (wipe data + restart this host before it can rejoin): " + h)
			try {
				rs.remove(h)
				removed = true
			} catch (e) {
				print("rs.remove failed (member may already be absent): " + e.message)
			}
		}
	}
	return removed
}

function addMissingMembers(desired, current) {
	const curMap = currentMembersByHost(current)
	for (const dm of desired.members) {
		const h = normalizeMemberHost(dm.host)
		if (!curMap[h]) {
			print("Adding new replica set member: " + JSON.stringify(dm))
			addMemberFromDesired(dm)
			current = rs.conf()
			Object.assign(curMap, currentMembersByHost(current))
		}
	}
	return current
}

/**
 * Apply full desired config after incremental steps.
 * Preserves Mongo-assigned member _id for existing hosts so we never request an illegal _id change.
 */
function applyFullReconfig(desired) {
	const current = rs.conf()
	const curByHost = currentMembersByHost(current)
	const mergedMembers = desired.members.map((dm) => {
		const h = normalizeMemberHost(dm.host)
		const cm = curByHost[h]
		if (cm) {
			return Object.assign({}, dm, { _id: cm._id })
		}
		return dm
	})
	const newConfig = {
		_id: desired._id,
		members: mergedMembers,
		version: current.version + 1,
	}
	if (current.settings !== undefined && current.settings !== null) {
		newConfig.settings = Object.assign({}, current.settings, desired.settings || {})
	}
	rs.reconfig(newConfig, { force: false })
}

/**
 * Reconcile desired replica-set.json with live config: conversions, new nodes, then full reconfig.
 */
function reconfigureReplicaSet() {
	ensureClusterWideDefaultWriteConcern()

	const desired = JSON.parse(fs.readFileSync("/script/replica-set.json", "utf8"))
	if (!desired.members || !Array.isArray(desired.members)) {
		throw new Error("replica-set.json must contain a members array")
	}

	let current = rs.conf()

	removeMembersForArbiterConversion(desired, current)
	current = rs.conf()

	current = addMissingMembers(desired, current)

	applyFullReconfig(desired)
}

function initiateReplicaSet() {
	const newConfig = JSON.parse(fs.readFileSync("/script/replica-set.json", "utf8"))
	rs.initiate(newConfig)
}

function main() {
	print("mongo-init.js revision: asab-remote-control/remote_control/tech/mongo-init.js (2025-03-27c)")
	print("(Re)-initializing the Mongo cluster.")

	const mongoHostnames = process.env.MONGO_HOSTNAMES.split(",")

	for (let i = 0; i < 5; i++) {
		print("Connection attempt", i + 1)

		for (let hostname of mongoHostnames) {
			print("Connecting to ", `${hostname}:27017`)
			try {
				db = connect(`${hostname}:27017`)
			} catch (connectErr) {
				print("Failed with " + connectErr.name + ": " + connectErr.message)
				continue
			}

			const hello = db.hello()

			if (!hello.isWritablePrimary && !hello.secondary && hello.isreplicaset && hello.info === "Does not have a valid replica set config") {
				try {
					initiateReplicaSet()
					print("Initialization successful.")
					print("SUCCESS!")
					quit(0)
				} catch (e) {
					print("Initialization of replicaset failed.")
					print("Exiting due to failure.")
					quit(1)
				}
			}

			if (!hello.isWritablePrimary) {
				print("Not a primary, continuing to the next Mongo node.")
				continue
			}

			print("This is a primary, reconfiguring a replicaset.")

			try {
				reconfigureReplicaSet()
				print("Successfully reconfigured replicaset.")
				print("SUCCESS!")
				quit(0)
			} catch (e) {
				print(
					"Reconfiguration failed with " +
						e.name +
						": " +
						e.message +
						" / " +
						(e.codeName != null ? e.codeName : "")
				)
				print("Exiting due to failure.")
				quit(1)
			}
		}
		sleep(5000)
	}
}

main()
