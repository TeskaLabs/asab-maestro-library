import aiohttp
import asyncio
import json


async def upload_config(session, config_type, config_file_name, config_file_data):
	file = config_file_data["file"]
	try:
		async with session.put("http://asab-config:8894/config/{}/{}".format(config_type, config_file_name), params={"if_not_exists": config_file_data.get("if_not_exists"), "validate": False}, json=file) as response:
			if response.status == 200:
				print("Config '{}' of type '{}' uploaded to asab-config".format(config_file_name, config_type))
			else:
				print("Upload of config '{}/{}' was not successful. Status: {}. Reason: {}".format(config_type, config_file_name, response.status, await response.json()))
	except Exception as e:
		print("Upload of config '{}/{}' was not successful. Error: {}".format(config_type, config_file_name, str(e)))

async def upload_config_type(session, config_type, config_file_data):
	file = config_file_data["file"]
	try:
		async with session.put("http://asab-config:8894/type/{}".format(config_type), params={"if_not_exists": config_file_data.get("if_not_exists")}, json=file) as response:
			if response.status == 200:
				print("Config type '{}' uploaded to asab-config".format(config_type))
			else:
				print("Upload of config type '{}' was not successful. Status: {}. Reason: {}".format(config_type, response.status, await response.json()))
	except Exception as e:
		print("Upload of config type '{}' was not successful. Error: {}".format(config_type, str(e)))


async def main():
	# Load data from file
	try:
		with open("/sherpa/content.json", "r") as file:
			content = json.load(file)
	except FileNotFoundError:
		print("/sherpa/content.json was not found.")
		return
	except json.JSONDecodeError:
		print("Error decoding JSON data from /sherpa/content.json file")
		return
	
	# Initialize aiohttp session and send requests
	tasks = []
	async with aiohttp.ClientSession() as session:
		for config_type, config_type_data in content.items():
			for config_file_name, config_file_data in config_type_data.items():
				if config_file_name == "_schema":
					tasks.append(upload_config_type(session, config_type, config_file_data))
				else:
					tasks.append(upload_config(session, config_type, config_file_name, config_file_data))
		await asyncio.gather(*tasks)

if __name__ == "__main__":
	asyncio.run(main())
