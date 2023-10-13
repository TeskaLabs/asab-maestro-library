import aiohttp
import aiohttp.client_exceptions
import asyncio
import json
import sys
import os
import time


async def upload_config(session, node_id, config_type, config_file_name, config_file_data):
	file = config_file_data["file"]
	params = {"validate": "false"}
	if config_file_data.get("if_not_exists"):
		params["if_not_exists"] = "true"

	async with session.put("/config/{}/{}".format(config_type, config_file_name), params=params, json=file) as response:
		if response.status == 200:
			print("Config '{}' of type '{}' uploaded to asab-config".format(config_file_name, config_type))
			return 0
		else:
			print("Upload of config '{}/{}' was not successful. Status: {}. Reason: {}".format(config_type, config_file_name, response.status, await response.json()))
			return 1


async def upload_config_type(session, node_id, config_type, config_file_data):
	file = config_file_data["file"]
	params = {}
	if config_file_data.get("if_not_exists"):
		params["if_not_exists"] = "true"

	async with session.put("/type/{}".format(config_type), params=params, json=file) as response:
		if response.status == 200:
			print("Config type '{}' uploaded to asab-config".format(config_type))
			return 0
		else:
			print("Upload of config type '{}' was not successful. Status: {}. Reason: {}".format(config_type, response.status, await response.json()))
			return 1


async def main():
	node_id = os.getenv("NODE_ID")
	if node_id is None:
		print("Could not find NODE_ID environment variable")
		sys.exit(1)
	# Load data from file
	try:
		with open("/content/content.json", "r") as file:
			content = json.load(file)
	except FileNotFoundError:
		print("/content/content.json was not found.")
		return
	except json.JSONDecodeError:
		print("Error decoding JSON data from /content/content.json file")
		return
	
	i = 5
	while i > 0:
		try:
			# Initialize aiohttp session and send requests
			res = 0
			async with aiohttp.ClientSession(base_url="http://{}:8894".format(node_id)) as session:
				for config_type, config_type_data in content.items():
					if config_type_data.get("_schema") is not None:
						res += await upload_config_type(session, node_id, config_type, config_type_data["_schema"])

					for config_file_name, config_file_data in config_type_data.items():
						if config_file_name == "_schema":
							continue
						res += await upload_config(session, node_id, config_type, config_file_name, config_file_data)

				if res > 0:
					sys.exit(1)
			sys.exit(0)
		except aiohttp.client_exceptions.ClientConnectorError:
			print("Cannot reach asab-config. Retrying in 5 seconds...")
			time.sleep(5)
		i -= 1


if __name__ == "__main__":
	asyncio.run(main())
